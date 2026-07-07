import assert from "node:assert/strict"
import { test } from "node:test"

import plugin from "../dist/index.js"

const context = {
  sessionID: "ses_test_clear",
  directory: "/tmp/nocreep-test",
}

test("clear can be called without indices", async () => {
  const server = await plugin({
    client: {
      session: {
        messages: async () => {
          throw new Error("clear should not read session messages")
        },
      },
    },
  })

  assert.equal(server.tool.nocreep.args.clear.safeParse(undefined).success, true)
  assert.equal(server.tool.nocreep.args.indices.safeParse(undefined).success, true)
  assert.equal(await server.tool.nocreep.execute({ clear: true }, context), "")
})

test("non-clear calls still require at least one index", async () => {
  const server = await plugin({
    client: {
      session: {
        messages: async () => {
          throw new Error("invalid prune calls should not read session messages")
        },
      },
    },
  })

  assert.equal(await server.tool.nocreep.execute({}, context), "nocreep: provide at least one tool call index or set clear=true.")
})
