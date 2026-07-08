import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  estimateTokens,
  hasRecordedStats,
  loadStoredPrunedCalls,
  recordStats,
  removeStoredPrunedCalls,
  storePrunedCalls,
} from "./storage.js"

type MessageWithParts = {
  info: Message
  parts: Part[]
}

type PruneRule = {
  sessionID: string
  callID: string
  lines: number[]
  created: number
}

type LineSelector = number | string

type CompletedToolPart = Extract<Part, { type: "tool" }> & {
  state: Extract<Extract<Part, { type: "tool" }>["state"], { status: "completed" }>
}

type IndexedCompletedToolPart = CompletedToolPart & {
  batchIndex: number
  pruneIndex: number
}

const rulesBySession = new Map<string, PruneRule[]>()
const loadedSessions = new Set<string>()
const sessionsWithInstructionOverhead = new Set<string>()
const toolCallOverheadTokens = 12
const prunedOutputPlaceholder = "pruned"
const nocreepDescription =
  "Prune prior tool outputs from future context. Once you prune output, you will not be able to see it or remember it in future turns. Prune only results and parts of results you will not need. Keep exact evidence, file contents, error text, and command output that you still need for reasoning, citations, edits, or the final answer. Once pruned, the removed output is gone from your future context, so only prune lines you are certain you no longer need. If you made conclusions or reasoning based on parts of the output, keep them. If you need pruned information later, re-fetch it instead of guessing or trying to recover it. Always use immediately after any tool outputs unless there is absolutely nothing to remove because every line of all those outputs is still needed for future reasoning. After tool calls finish, call nocreep before continuing whenever any output or output line can be discarded. Never just continue after tool outputs unless all of every output must remain in context. Do not leave prior tool outputs in context if any part of them is unnecessary for the next reasoning step. Provide 0-based indices of the completed tool calls from the immediately preceding tool batch, where 0 is the first tool call in that batch by position (the order they were started, not the order they finished). Omit lines, pass an empty lines array, or pass an empty array for a specific index to drop the whole output; otherwise pass one nested line-selector array per index to prune only those lines. Remember: after pruning, you cannot inspect or rely on the removed output again."

export const plugin: Plugin = async (input) => ({
  tool: {
    nocreep: tool({
      description: nocreepDescription,
      args: {
        indices: tool.schema
          .array(tool.schema.number().int().min(0))
          .min(1)
          .describe(
            "0-based indices of completed tool calls from the immediately preceding tool batch to prune. 0 means the first tool call in that batch by position (order started, not order finished).",
          ),
        lines: tool.schema
          .array(tool.schema.array(tool.schema.union([tool.schema.number().int().min(1), tool.schema.string()])))
          .optional()
          .describe(
            'Optional nested 1-based output lines or ranges to remove, one array per index, for example [[5, "10-25"], []]. Omit lines, pass [], or pass [] for an index to prune the whole output.',
          ),
      },
      async execute(args, context) {
        const messages = await getSessionMessages(input.client, context.sessionID, context.directory)
        const selected = selectCompletedToolParts(messages, args.indices)

        if (selected.length === 0) {
          return "nocreep: no completed tool calls matched."
        }

        const existing = rulesBySession.get(context.sessionID) ?? []
        const nextRules = selected.map((part) => ({
          sessionID: context.sessionID,
          callID: part.callID,
          lines: getLinesForPart(args.lines ?? [], part),
          created: Date.now(),
        }))
        const next = mergeRules(existing, nextRules)
        rulesBySession.set(context.sessionID, next)
        storePrunedCalls(
          context.sessionID,
          next.map(({ callID, lines, created }) => ({ callID, lines, created })),
        )

        const grossTokensSaved = nextRules.reduce(
          (total, rule) => total + getRuleTokensSaved(selected, rule.callID, rule.lines),
          0,
        )
        const overheadTokens = await getOverheadTokens(context.sessionID, {
          indices: args.indices,
          ...(args.lines ? { lines: args.lines } : {}),
        })
        const tokensSaved = Math.max(0, grossTokensSaved - overheadTokens)
        recordStats(context.sessionID, tokensSaved)

        return ""
      },
    }),
  },
  "experimental.chat.messages.transform": async (_input, output) => {
    await loadSessionRules(output.messages)
    applyPruneRules(output.messages)
  },
})

export default plugin

async function getOverheadTokens(sessionID: string, toolArgs: { indices: number[]; lines?: LineSelector[][] }) {
  const instructionOverhead = await getInstructionOverheadTokens(sessionID)
  return estimateTokens(JSON.stringify(toolArgs)) + toolCallOverheadTokens + instructionOverhead
}

async function getInstructionOverheadTokens(sessionID: string) {
  if (sessionsWithInstructionOverhead.has(sessionID) || (await hasRecordedStats(sessionID))) {
    return 0
  }

  sessionsWithInstructionOverhead.add(sessionID)
  return estimateTokens(nocreepDescription)
}

function applyPruneRules(messages: MessageWithParts[]) {
  const sessionID = getSessionID(messages)
  if (!sessionID) {
    return
  }

  const rules = rulesBySession.get(sessionID)
  if (!rules?.length) {
    return
  }

  const rulesByCall = new Map(rules.map((rule) => [rule.callID, rule]))

  messages.forEach((message) => {
    message.parts = message.parts.flatMap((part) => {
      if (!isCompletedToolPart(part)) {
        return [part]
      }

      const rule = rulesByCall.get(part.callID)
      if (!rule) {
        return [part]
      }

      if (!rule.lines.length) {
        part.state.output = prunedOutputPlaceholder
        return [part]
      }

      part.state.output = pruneLines(part.state.output, rule.lines)
      return [part]
    })
  })
}

async function loadSessionRules(messages: MessageWithParts[]) {
  const sessionID = getSessionID(messages)
  if (!sessionID || loadedSessions.has(sessionID)) {
    return
  }

  const calls = await loadStoredPrunedCalls(sessionID)
  if (calls.length) {
    rulesBySession.set(
      sessionID,
      mergeRules(
        rulesBySession.get(sessionID) ?? [],
        calls.map((call) => ({ sessionID, ...call })),
      ),
    )
  }
  loadedSessions.add(sessionID)
  removeStoredPrunedCalls(sessionID)
}

function getSessionID(messages: MessageWithParts[]) {
  return messages.find((message) => message.info.sessionID)?.info.sessionID
}

async function getSessionMessages(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
): Promise<MessageWithParts[]> {
  const response = await client.session.messages({
    path: { id: sessionID },
    query: { directory },
  })

  return response.data ?? []
}

function selectCompletedToolParts(messages: MessageWithParts[], indices: number[]) {
  const completed =
    messages.findLast((message) => message.parts.some(isCompletedToolPart))?.parts.filter(isCompletedToolPart) ?? []
  return indices.flatMap((batchIndex, pruneIndex) => {
    const part = completed[batchIndex]
    return part ? [{ ...part, batchIndex, pruneIndex }] : []
  })
}

function getLinesForPart(lines: LineSelector[][], part: IndexedCompletedToolPart) {
  return normalizeLines(lines[part.pruneIndex] ?? [])
}

function mergeRules(existing: PruneRule[], next: PruneRule[]) {
  return [...existing, ...next].reduce<PruneRule[]>((rules, rule) => {
    const index = rules.findIndex((item) => item.callID === rule.callID)
    if (index < 0) {
      return [...rules, rule]
    }

    return rules.map((item, itemIndex) => (itemIndex === index ? rule : item))
  }, [])
}

function getRemovedOutput(parts: IndexedCompletedToolPart[], callID: string, lines: number[]) {
  const part = parts.find((item) => item.callID === callID)
  if (!part) {
    return ""
  }

  if (!lines.length) {
    return part.state.output
  }

  const selected = new Set(lines)
  return part.state.output
    .split("\n")
    .filter((_line, index) => selected.has(index + 1))
    .join("\n")
}

function getRuleTokensSaved(parts: IndexedCompletedToolPart[], callID: string, lines: number[]) {
  const removedOutput = getRemovedOutput(parts, callID, lines)
  const placeholderTokens = lines.length ? 0 : estimateTokens(prunedOutputPlaceholder)
  return estimateTokens(removedOutput) - placeholderTokens
}

function pruneLines(output: string, lines: number[]) {
  const selected = new Set(lines)
  const chunks = output.split("\n").reduce<string[]>((items, line, index) => {
    if (!selected.has(index + 1)) {
      return [...items, line]
    }

    if (items.at(-1) === "...") {
      return items
    }

    return [...items, "..."]
  }, [])

  return chunks.join("\n")
}

function isCompletedToolPart(part: Part): part is CompletedToolPart {
  return part.type === "tool" && part.state.status === "completed"
}

function normalizeLines(selectors: LineSelector[]) {
  return [...new Set(selectors.flatMap(expandLineSelector))].sort((first, second) => first - second)
}

function expandLineSelector(selector: LineSelector) {
  if (typeof selector === "number") {
    return [selector]
  }

  const range = selector.trim().match(/^(\d+)\s*-\s*(\d+)$/)
  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    const first = Math.min(start, end)
    const last = Math.max(start, end)
    return Array.from({ length: last - first + 1 }, (_value, index) => first + index)
  }

  const line = Number(selector.trim())
  if (Number.isInteger(line) && line > 0) {
    return [line]
  }

  return []
}
