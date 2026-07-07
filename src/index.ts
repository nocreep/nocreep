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
        "Prune prior tool outputs from future context. Always use proactively for tool outputs you no longer need. Supports last calls, last parallel batch, call IDs, and line/range pruning.",
      args: {
        last: tool.schema
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Number of most recent completed tool calls to prune. Defaults to 1 when call_ids and parallel_last are omitted.",
          ),
        parallel_last: tool.schema
          .boolean()
          .optional()
          .describe(
            "Prune every completed tool call in the most recent assistant message that contains completed tool calls.",
          ),
        call_ids: tool.schema.array(tool.schema.string()).optional().describe("Specific tool call IDs to prune."),
        lines: tool.schema
          .array(tool.schema.union([tool.schema.number().int().min(1), tool.schema.string()]))
          .optional()
          .describe(
            'Optional 1-based output lines or ranges to remove, for example 5 or "10-25". Omit to prune the whole selected output.',
          ),
        clear: tool.schema
          .boolean()
          .optional()
          .describe("Clear nocreep prune rules for this session instead of adding rules."),
      },
      async execute(args, context) {
        if (args.clear) {
          rulesBySession.delete(context.sessionID)
          return "nocreep: cleared prune rules for this session."
        }

        const messages = await getSessionMessages(input.client, context.sessionID, context.directory)
        const selected = selectCompletedToolParts(messages, {
          callIDs: args.call_ids ?? [],
          last: args.last,
          parallelLast: args.parallel_last ?? false,
        })

        if (selected.length === 0) {
          return "nocreep: no completed tool calls matched."
        }

        const existing = rulesBySession.get(context.sessionID) ?? []
        const lines = normalizeLines(args.lines ?? [])
        const next = mergeRules(
          existing,
          selected.map((part) => ({
            sessionID: context.sessionID,
            callID: part.callID,
            lines,
            created: Date.now(),
          })),
        )
        rulesBySession.set(context.sessionID, next)

        return `nocreep: pruning ${selected.length} tool output${selected.length === 1 ? "" : "s"} from future model context${lines.length ? ` (line${lines.length === 1 ? "" : "s"} ${formatLineSummary(lines)})` : ""}.`
      },
    }),
  },
  "experimental.chat.messages.transform": async (_input, output) => {
    applyPruneRules(output.messages)
  },
  "tool.execute.after": async (input) => {
    if (input.tool !== "nocreep") {
      return
    }

    rulesBySession.set(
      input.sessionID,
      mergeRules(rulesBySession.get(input.sessionID) ?? [], [
        {
          sessionID: input.sessionID,
          callID: input.callID,
          lines: [],
          created: Date.now(),
        },
      ]),
    )
  },
})

export default plugin

function applyPruneRules(messages: MessageWithParts[]) {
  const sessionID = messages.find((message) => message.info.sessionID)?.info.sessionID
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

function selectCompletedToolParts(
  messages: MessageWithParts[],
  options: { callIDs: string[]; last?: number; parallelLast: boolean },
) {
  const completed = messages.flatMap((message) => message.parts.filter(isCompletedToolPart))

  if (options.callIDs.length) {
    const wanted = new Set(options.callIDs)
    return completed.filter((part) => wanted.has(part.callID))
  }

  if (options.parallelLast) {
    return (
      messages.findLast((message) => message.parts.some(isCompletedToolPart))?.parts.filter(isCompletedToolPart) ?? []
    )
  }

  return completed.slice(-(options.last ?? 1))
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

function formatLineSummary(lines: number[]) {
  return lines.join(", ")
}
