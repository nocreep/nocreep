import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

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

const rulesBySession = new Map<string, PruneRule[]>()

export const plugin: Plugin = async (input) => ({
  tool: {
    nocreep: tool({
      description:
        "Prune prior tool outputs from future context. Always use proactively immediately after tool outputs unless every line of all those outputs is still needed for future reasoning. Provide call IDs from the tool calls that happened immediately before this nocreep call. Omit lines, pass an empty lines array, or pass an empty array for a specific call ID to drop that whole output; otherwise pass one nested line-selector array per call ID to prune only those lines.",
      args: {
        call_ids: tool.schema
          .array(tool.schema.string())
          .min(1)
          .describe("Specific call IDs from the immediately preceding completed tool calls to prune."),
        lines: tool.schema
          .array(tool.schema.array(tool.schema.union([tool.schema.number().int().min(1), tool.schema.string()])))
          .optional()
          .describe(
            'Optional nested 1-based output lines or ranges to remove, one array per call_id, for example [[5, "10-25"], []]. Omit lines, pass [], or pass [] for a call_id to prune the whole output.',
          ),
        clear: tool.schema
          .boolean()
          .optional()
          .describe("Clear nocreep prune rules for this session instead of adding rules."),
      },
      async execute(args, context) {
        if (args.clear) {
          rulesBySession.delete(context.sessionID)
          return ""
        }

        const messages = await getSessionMessages(input.client, context.sessionID, context.directory)
        const selected = selectCompletedToolParts(messages, args.call_ids)

        if (selected.length === 0) {
          return "nocreep: no completed tool calls matched."
        }

        const existing = rulesBySession.get(context.sessionID) ?? []
        const next = mergeRules(
          existing,
          selected.map((part) => ({
            sessionID: context.sessionID,
            callID: part.callID,
            lines: getLinesForCallID(args.call_ids, args.lines ?? [], part.callID),
            created: Date.now(),
          })),
        )
        rulesBySession.set(context.sessionID, next)

        return ""
      },
    }),
  },
  "experimental.chat.messages.transform": async (_input, output) => {
    applyPruneRules(output.messages)
  },
})

export default plugin

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
        return []
      }

      part.state.output = pruneLines(part.state.output, rule.lines)
      return [part]
    })
  })
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

function selectCompletedToolParts(messages: MessageWithParts[], callIDs: string[]) {
  const completed =
    messages.findLast((message) => message.parts.some(isCompletedToolPart))?.parts.filter(isCompletedToolPart) ?? []
  const wanted = new Set(callIDs)
  return completed.filter((part) => wanted.has(part.callID))
}

function getLinesForCallID(callIDs: string[], lines: LineSelector[][], callID: string) {
  const index = callIDs.indexOf(callID)
  if (index < 0) {
    return []
  }

  return normalizeLines(lines[index] ?? [])
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
