import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

export type StoredPrunedCall = {
  callID: string
  lines: number[]
  created: number
}

type SessionStats = {
  sessionID: string
  tokensSaved: number
  updatedAtUtc: string
}

type TimestampStats = {
  sessionID: string
  tokensSaved: number
  timestampUtc: string
}

const appName = "nocreep"
const stateDir = getStateDir()
const prunedCallsDir = path.join(stateDir, "pruned-calls")
const sessionsStatsFile = path.join(stateDir, "stats-sessions.json")
const timestampsStatsFile = path.join(stateDir, "stats-timestamps.json")

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

export const recordStats = (sessionID: string, tokensSaved: number) => {
  if (tokensSaved <= 0) {
    return
  }

  scheduleWrite(async () => {
    await fs.mkdir(stateDir, { recursive: true })
    const now = new Date().toISOString()
    const sessions = await readJsonFile<SessionStats[]>(sessionsStatsFile, [])
    const timestamps = await readJsonFile<TimestampStats[]>(timestampsStatsFile, [])
    const sessionIndex = sessions.findIndex((session) => session.sessionID === sessionID)
    const nextSession = {
      sessionID,
      tokensSaved: tokensSaved + (sessions[sessionIndex]?.tokensSaved ?? 0),
      updatedAtUtc: now,
    }
    const nextSessions = sessionIndex < 0 ? [...sessions, nextSession] : sessions.with(sessionIndex, nextSession)

    await fs.writeFile(sessionsStatsFile, `${JSON.stringify(nextSessions)}\n`)
    await fs.writeFile(
      timestampsStatsFile,
      `${JSON.stringify([...timestamps, { sessionID, tokensSaved, timestampUtc: now }])}\n`,
    )
  })
}

export const readStats = async () => ({
  sessions: await readJsonFile<SessionStats[]>(sessionsStatsFile, []),
  timestamps: await readJsonFile<TimestampStats[]>(timestampsStatsFile, []),
})

export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

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
