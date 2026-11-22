// opencode-loop-guard (OpenCode 2.x plugin): stops a model that keeps repeating itself.
//
// Blocks a tool call when the exact same call (same tool, same input) already
// returned the same result
//   - in each of the last two calls (a straight repeat), or
//   - twice more among the last 10 calls (an A, B, A, B, A loop).
// A repeat whose result changes is allowed, so polling until something is done
// still works, and shell commands that wait or poll a status are never blocked.
// A file edit starts the count over for every other call, so "edit, re-run the
// tests, same failure, edit again, re-run" is never blocked.
// The model gets an error telling it to change approach or ask the user. If it
// keeps sending blocked calls (3 in a row), the guard ends the turn, so a stuck
// model stops and waits for the user instead of retrying for half an hour.
// Remove it from your plugin list (or delete the file) to turn it off.

import { createHash } from "node:crypto"

const WINDOW = 10 // calls remembered per session
const STOP_AFTER = 3 // blocked calls in a row before the turn is ended
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

// Tools that change files. After one runs, earlier results of other calls may be stale.
const WRITE_TOOL = /(^|[_.-])(edit|multiedit|write|patch|apply_patch)$/i

function isWrite(call) {
  return typeof call.tool === "string" && WRITE_TOOL.test(call.tool)
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
  const strikes = new Map() // sessionID -> blocked calls in a row

  function remember(sessionID, entry) {
    let recent = runs.get(sessionID) ?? []
    // Files changed: forget the other calls, but keep earlier edits so an edit
    // repeated with the same result can still be caught.
    if (entry.write) recent = recent.filter((r) => r.write)
    runs.delete(sessionID) // re-insert so the most recently active session is last
    recent.push(entry)
    if (recent.length > WINDOW) recent.shift()
    runs.set(sessionID, recent)
    if (runs.size > MAX_SESSIONS) runs.delete(runs.keys().next().value)
  }

  return {
    id: "loop-guard",
    async setup(ctx) {
      // Ends the session's current turn, after the refused call has been reported.
      const interrupt = typeof ctx.session?.interrupt === "function"
        ? (sessionID) => setTimeout(() => {
            try {
              Promise.resolve(ctx.session.interrupt({ sessionID })).catch(() => {})
            } catch {}
          }, 0)
        : undefined

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
        const strike = (strikes.get(call.sessionID) ?? 0) + 1
        strikes.set(call.sessionID, strike)
        if (strikes.size > MAX_SESSIONS) strikes.delete(strikes.keys().next().value)
        if (strike >= STOP_AFTER && interrupt) {
          strikes.delete(call.sessionID)
          interrupt(call.sessionID)
          throw new Error(
            "loop-guard stopped this turn: you sent a call it had already blocked " +
              strike +
              " times in a row (" +
              call.tool +
              " with the same input and the same result). Don't run it again. " +
              "When the user writes next, say what you were trying to do, what the repeated call returned, and ask one short question.",
          )
        }
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
        strikes.delete(call.sessionID)
        remember(call.sessionID, { sig: signature(call), out: resultKey(call), write: isWrite(call) })
      })
    },
  }
}

export default createPlugin()
