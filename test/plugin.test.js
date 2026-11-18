import assert from "node:assert/strict"
import { test } from "node:test"
import { createPlugin } from "../index.js"

async function host() {
  const hooks = {}
  await createPlugin().setup({ tool: { hook: async (name, fn) => { hooks[name] = fn } } })
  let id = 0
  // Runs one tool call the way OpenCode does: before, then (if not blocked) after.
  return async function run(tool, input, result = "same output", { sessionID = "s1", status = "completed", error } = {}) {
    const call = { id: "call" + ++id, sessionID, tool, input }
    try {
      await hooks["execute.before"](call)
    } catch (e) {
      return "BLOCKED: " + e.message
    }
    await hooks["execute.after"]({ ...call, status, result: { output: result }, error })
    return "ran"
  }
}

test("a third identical call with the same result is blocked", async () => {
  const run = await host()
  assert.equal(await run("bash", { command: "ls" }), "ran")
  assert.equal(await run("bash", { command: "ls" }), "ran")
  assert.match(await run("bash", { command: "ls" }), /^BLOCKED: loop-guard blocked this call/)
  assert.match(await run("bash", { command: "ls" }), /^BLOCKED/)
})

test("a repeat whose result changes is allowed", async () => {
  const run = await host()
  for (let i = 0; i < 6; i++) assert.equal(await run("bash", { command: "cat log.txt" }, "line " + i), "ran")
})

test("waiting and status polls are never blocked", async () => {
  const run = await host()
  for (const command of ["sleep 5", "wait", "watch -n1 ls", "./recompile_status", "unity test status --job 3"]) {
    for (let i = 0; i < 4; i++) assert.equal(await run("bash", { command }), "ran", command)
  }
})

test("git status is not treated as a poll", async () => {
  const run = await host()
  await run("bash", { command: "git status" })
  await run("bash", { command: "git status" })
  assert.match(await run("bash", { command: "git status" }), /^BLOCKED/)
})

test("an A, B, A, B, A loop is blocked", async () => {
  const run = await host()
  assert.equal(await run("read", { path: "a" }, "A"), "ran")
  assert.equal(await run("read", { path: "b" }, "B"), "ran")
  assert.equal(await run("read", { path: "a" }, "A"), "ran")
  assert.equal(await run("read", { path: "b" }, "B"), "ran")
  assert.match(await run("read", { path: "a" }, "A"), /^BLOCKED.*2 times/)
})

test("repeated identical failures are blocked", async () => {
  const run = await host()
  const fail = { status: "error", error: { message: "timed out" } }
  await run("sim_tap", { x: 1, y: 2 }, undefined, fail)
  await run("sim_tap", { x: 1, y: 2 }, undefined, fail)
  assert.match(await run("sim_tap", { x: 1, y: 2 }, undefined, fail), /^BLOCKED/)
})

test("a reworded description, a new timeout or reordered keys still count as the same call", async () => {
  const run = await host()
  await run("bash", { command: "ls", description: "List files" })
  await run("bash", { timeout: 5000, description: "Show the files", command: "ls" })
  assert.match(await run("bash", { command: "ls", description: "Again" }), /^BLOCKED/)
})

test("different input is a different call", async () => {
  const run = await host()
  await run("bash", { command: "ls" })
  await run("bash", { command: "ls" })
  assert.equal(await run("bash", { command: "ls -la" }), "ran")
})

test("sessions are tracked separately", async () => {
  const run = await host()
  await run("bash", { command: "ls" }, "x", { sessionID: "a" })
  await run("bash", { command: "ls" }, "x", { sessionID: "a" })
  assert.equal(await run("bash", { command: "ls" }, "x", { sessionID: "b" }), "ran")
})

test("a blocked call doesn't count toward the next decision", async () => {
  const run = await host()
  await run("bash", { command: "ls" })
  await run("bash", { command: "ls" })
  await run("bash", { command: "ls" }) // blocked
  await run("bash", { command: "pwd" }, "p1")
  await run("bash", { command: "date" }, "d1")
  // Only the two real "ls" runs are remembered, so it is still a loop.
  assert.match(await run("bash", { command: "ls" }), /^BLOCKED/)
})

test("old calls drop out of the 10-call window", async () => {
  const run = await host()
  await run("bash", { command: "ls" })
  await run("bash", { command: "ls" })
  for (let i = 0; i < 10; i++) await run("bash", { command: "echo " + i }, String(i))
  assert.equal(await run("bash", { command: "ls" }), "ran")
})

test("inputs that can't be serialized don't crash the guard", async () => {
  const run = await host()
  const circular = { command: "x" }
  circular.self = circular
  assert.equal(await run("bash", circular), "ran")
})

test("memory stays bounded across many sessions", async () => {
  const run = await host()
  for (let i = 0; i < 1000; i++) await run("bash", { command: "ls" }, "x", { sessionID: "s" + i })
  // The oldest session was forgotten, so its history no longer blocks.
  await run("bash", { command: "ls" }, "x", { sessionID: "s0" })
  assert.equal(await run("bash", { command: "ls" }, "x", { sessionID: "s0" }), "ran")
})

test("re-running the same failing test after each edit is not blocked", async () => {
  const run = await host()
  const fail = "FAIL: expected 2, got 3"
  for (let i = 0; i < 4; i++) {
    assert.equal(await run("bash", { command: "npm test" }, fail), "ran", "test run " + i)
    assert.equal(await run("edit", { filePath: "a.js", oldString: "v" + i, newString: "v" + (i + 1) }, "ok"), "ran")
  }
})

test("the same edit repeated with the same result is still blocked", async () => {
  const run = await host()
  const edit = { filePath: "a.js", oldString: "x", newString: "y" }
  await run("edit", edit, "no match")
  await run("edit", edit, "no match")
  assert.match(await run("edit", edit, "no match"), /^BLOCKED/)
})

test("write, patch and namespaced edit tools also count as file changes", async () => {
  for (const tool of ["write", "patch", "apply_patch", "multiedit", "serena_edit"]) {
    const run = await host()
    await run("bash", { command: "npm test" }, "fail")
    await run("bash", { command: "npm test" }, "fail")
    await run(tool, { filePath: "a.js", content: tool }, "ok")
    assert.equal(await run("bash", { command: "npm test" }, "fail"), "ran", tool)
  }
})

test("tools that only mention editing in their name don't reset the count", async () => {
  const run = await host()
  await run("bash", { command: "ls" })
  await run("bash", { command: "ls" })
  await run("editor_status", {}, "idle")
  assert.match(await run("bash", { command: "ls" }), /^BLOCKED/)
})
