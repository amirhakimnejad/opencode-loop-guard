// opencode-loop-guard (OpenCode 2.x plugin): stops a model that keeps repeating itself.
//
// Blocks a tool call when the exact same call (same tool, same input) already
// returned the same result
//   - in each of the last two calls (a straight repeat), or
//   - twice more among the last 10 calls (an A, B, A, B, A loop).
// A repeat whose result changes is allowed, so polling until something is done
// still works, and shell commands that wait or poll a status are never blocked.
// The model gets an error telling it to change approach or ask the user.
// Remove it from your plugin list (or delete the file) to turn it off.

import { createHash } from "node:crypto"

const WINDOW = 10 // calls remembered per session
const MAX_SESSIONS = 200 // sessions remembered at once (least recently active dropped first)
// Shell commands that may legitimately repeat with the same output while waiting:
// sleep/wait/watch, *_status commands, and `unity ... status` (Editor, test, job).
const POLL = /(^|[\s;&|(])(sleep|wait|watch)\b|_status\b|\bunity\b.*\bstatus\b/i

function text(value) {
  try {
    return typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function hash(value) {
  return createHash("sha1")
    .update(text(value) ?? "")
    .digest("hex")
}

// Fields a model may vary between otherwise identical calls (a reworded
// description, a different timeout); they don't change what the call does.
const IGNORED_FIELDS = new Set(["description", "timeout", "title", "reason"])

function signature(call) {
  let input = call.input
  if (input && typeof input === "object" && !Array.isArray(input)) {
    input = Object.fromEntries(
      Object.entries(input)
        .filter(([key]) => !IGNORED_FIELDS.has(key))
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    )
  }
  return hash(call.tool + "\u0000" + text(input))
}

function isPoll(call) {
  const command = call.input && typeof call.input === "object" ? call.input.command : undefined
  return typeof command === "string" && POLL.test(command)
}

function resultKey(call) {
  if (call.status === "error") return hash("error\u0000" + text(call.error?.message ?? call.error))
  return hash(call.result?.content ?? call.result?.output ?? call.result)
}

export function createPlugin() {
  const runs = new Map() // sessionID -> [{ sig, out }]
  const blocked = new Set() // ids of calls this guard refused

  function remember(sessionID, entry) {
    const recent = runs.get(sessionID) ?? []
    runs.delete(sessionID) // re-insert so the most recently active session is last
    recent.push(entry)
    if (recent.length > WINDOW) recent.shift()
    runs.set(sessionID, recent)
    if (runs.size > MAX_SESSIONS) runs.delete(runs.keys().next().value)
  }

  return {
    id: "loop-guard",
    async setup(ctx) {
      await ctx.tool.hook("execute.before", (call) => {
        if (isPoll(call)) return
        const sig = signature(call)
        const recent = runs.get(call.sessionID) ?? []
        const last = recent.slice(-2)
        const twiceInARow = last.length === 2 && last.every((r) => r.sig === sig) && last[0].out === last[1].out
        const same = recent.filter((r) => r.sig === sig)
        const loop = same.length >= 2 && same.every((r) => r.out === same[0].out)
        if (!twiceInARow && !loop) return
        // opencode 2.1 doesn't run execute.after for a call refused here; keep the set from growing anyway.
        if (blocked.size > 1000) blocked.clear()
        blocked.add(call.id)
        throw new Error(
          "loop-guard blocked this call: you already ran this exact " +
            call.tool +
            " call with the same input " +
            (twiceInARow ? "twice in a row" : same.length + " times in your last few steps") +
            " and got the same result each time. Running it again will not change anything. " +
            "Use the result you already have, take a different next step, or stop and ask the user one short question.",
        )
      })

      await ctx.tool.hook("execute.after", (call) => {
        if (blocked.delete(call.id)) return
        remember(call.sessionID, { sig: signature(call), out: resultKey(call) })
      })
    },
  }
}

export default createPlugin()
