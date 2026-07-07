import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

export type StoredPrunedCall = {
  callID: string
  lines: number[]
  created: number
}

const appName = "nocreep"
const stateDir = getStateDir()
const prunedCallsDir = path.join(stateDir, "pruned-calls")

let writeQueue = Promise.resolve()

export const storePrunedCalls = (sessionID: string, calls: StoredPrunedCall[]) => {
  scheduleWrite(async () => {
    await fs.mkdir(prunedCallsDir, { recursive: true })
    await fs.writeFile(getPrunedCallsFile(sessionID), `${JSON.stringify(calls)}\n`)
  })
}

export const clearStoredPrunedCalls = (sessionID: string) => {
  scheduleWrite(async () => {
    await removeFile(getPrunedCallsFile(sessionID))
  })
}

export const removeStoredPrunedCalls = (sessionID: string) => {
  scheduleWrite(async () => {
    await removeFile(getPrunedCallsFile(sessionID))
  })
}

export const loadStoredPrunedCalls = async (sessionID: string) =>
  readJsonFile<StoredPrunedCall[]>(getPrunedCallsFile(sessionID), [])

const getPrunedCallsFile = (sessionID: string) => path.join(prunedCallsDir, `${encodeURIComponent(sessionID)}.json`)

function getStateDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), appName)
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName)
  }

  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), appName)
}

const scheduleWrite = (write: () => Promise<void>) => {
  writeQueue = writeQueue.then(write, write)
  void writeQueue.catch(() => undefined)
}

const readJsonFile = async <T>(file: string, fallback: T) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return fallback
    }

    throw error
  }
}

const removeFile = async (file: string) => {
  try {
    await fs.rm(file)
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error
    }
  }
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && "code" in error
