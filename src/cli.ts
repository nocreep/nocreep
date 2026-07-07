#!/usr/bin/env node
import { readStats } from "./storage.js"

const args = process.argv.slice(2)

if (!args.includes("--stats")) {
  console.log("Usage: nocreep --stats")
  process.exit(0)
}

const { sessions, timestamps } = await readStats()
const now = new Date()
const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
const weekStart = new Date(dayStart)
weekStart.setDate(dayStart.getDate() - ((dayStart.getDay() + 6) % 7))
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
const tokensSince = (start: Date) =>
  timestamps
    .filter((entry) => new Date(entry.timestampUtc) >= start)
    .reduce((total, entry) => total + entry.tokensSaved, 0)

console.log(`Tokens saved today: ${tokensSince(dayStart)}`)
console.log(`Tokens saved this week: ${tokensSince(weekStart)}`)
console.log(`Tokens saved this month: ${tokensSince(monthStart)}`)
console.log("Last 5 sessions:")

sessions
  .toSorted((first, second) => new Date(second.updatedAtUtc).getTime() - new Date(first.updatedAtUtc).getTime())
  .slice(0, 5)
  .forEach((session) => {
    console.log(`${session.sessionID}: ${session.tokensSaved}`)
  })
