import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capText, childArgs, depthOf, isSessionId, loadRoles, maxDepthOf, newRun, newSessionId, parseRole, readLine, resolveModel, roleOfSession, sessionFile } from "../lib.ts";

test("depth is 0 at the top and the limit defaults to 1", () => {
  assert.equal(depthOf({}), 0);
  assert.equal(depthOf({ PI_SUBAGENT_DEPTH: "1" }), 1);
  assert.equal(maxDepthOf({}), 1);
  assert.equal(maxDepthOf({ PI_SUBAGENT_MAX_DEPTH: "3" }), 3);
  assert.equal(maxDepthOf({ PI_SUBAGENT_MAX_DEPTH: "0" }), 0);
  assert.throws(() => maxDepthOf({ PI_SUBAGENT_MAX_DEPTH: "two" }), /whole number/);
  assert.throws(() => depthOf({ PI_SUBAGENT_DEPTH: "-1" }), /whole number/);
});

test("a role is frontmatter and instructions", () => {
  const role = parseRole("---\nname: scout\ndescription: finds things\nmodel: anthropic/claude-haiku-5.5\nthinking: low\ntools: read, grep, jev_find\n---\n\nYou are a scout.\n", "scout.md");
  assert.deepEqual(role, {
    name: "scout",
    description: "finds things",
    model: "anthropic/claude-haiku-5.5",
    thinking: "low",
    tools: ["read", "grep", "jev_find"],
    prompt: "You are a scout.",
    file: "scout.md",
  });
  assert.equal(parseRole("no frontmatter", "x.md"), undefined);
  assert.equal(parseRole("---\nname: Bad Name\n---\nx", "x.md"), undefined);
  assert.equal(parseRole("---\nname: w\nthinking: lots\n---\nx", "w.md")?.thinking, undefined);
});

test("a later directory's role replaces an earlier one of the same name", () => {
  const base = mkdtempSync(join(tmpdir(), "roles-"));
  for (const [dir, model] of [["a", "m1"], ["b", "m2"]]) {
    mkdirSync(join(base, dir));
    writeFileSync(join(base, dir, "scout.md"), `---\nname: scout\nmodel: ${model}\n---\nx`);
  }
  const roles = loadRoles([join(base, "a"), join(base, "missing"), join(base, "b")]);
  assert.equal(roles.get("scout")?.model, "m2");
});

const AVAILABLE = [
  { provider: "openrouter", id: "anthropic/claude-haiku-5.5" },
  { provider: "openrouter", id: "anthropic/claude-sonnet-5.5" },
  { provider: "anthropic", id: "claude-sonnet-5-5" },
  { provider: "anthropic", id: "shared" },
  { provider: "openrouter", id: "shared" },
];

test("models resolve to provider/id, with a thinking suffix", () => {
  assert.deepEqual(resolveModel("openrouter/anthropic/claude-haiku-5.5", AVAILABLE), { model: "openrouter/anthropic/claude-haiku-5.5", thinking: undefined });
  assert.deepEqual(resolveModel("anthropic/claude-haiku-5.5:high", AVAILABLE), { model: "openrouter/anthropic/claude-haiku-5.5", thinking: "high" });
  assert.deepEqual(resolveModel("claude-sonnet-5-5", AVAILABLE), { model: "anthropic/claude-sonnet-5-5", thinking: undefined });
  assert.equal(resolveModel("shared", AVAILABLE, "openrouter").model, "openrouter/shared");
  assert.throws(() => resolveModel("shared", AVAILABLE), /several providers/);
  assert.throws(() => resolveModel("claude-haiku-4-5", AVAILABLE), /No model "claude-haiku-4-5"/);
  assert.throws(() => resolveModel("sonnet-5.5", AVAILABLE), /Close: openrouter\/anthropic\/claude-sonnet-5.5/);
});

test("session IDs carry their role and are valid Pi IDs", () => {
  const id = newSessionId("scout", () => 0.5);
  assert.equal(id, "scout-ssssss");
  assert.ok(isSessionId(id));
  assert.equal(roleOfSession("code-reviewer-k3j9x2"), "code-reviewer");
  assert.ok(!isSessionId("../etc"));
  assert.ok(!isSessionId("scout"));
});

test("a saved session is found by its ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  writeFileSync(join(dir, "2026-10-12T13-59-31-332Z_scout-k3j9x2.jsonl"), "");
  assert.equal(sessionFile(dir, "scout-k3j9x2"), join(dir, "2026-10-12T13-59-31-332Z_scout-k3j9x2.jsonl"));
  assert.equal(sessionFile(dir, "scout-zzzzzz"), undefined);
  assert.equal(sessionFile(join(dir, "missing"), "scout-k3j9x2"), undefined);
});

test("the child's command line saves its session and ends options before the task", () => {
  const args = childArgs({ sessionDir: "/s", sessionId: "scout-k3j9x2", model: "openrouter/x", thinking: "low", tools: ["read", "grep"], prompt: "Be brief.", name: "scout: find", task: "-starts with a dash" });
  assert.deepEqual(args, ["--mode", "json", "-p", "--session-dir", "/s", "--session-id", "scout-k3j9x2", "--model", "openrouter/x", "--name", "scout: find", "--thinking", "low", "--tools", "read,grep", "--append-system-prompt", "Be brief.", "--", "-starts with a dash"]);
  assert.ok(!childArgs({ sessionDir: "/s", sessionId: "general-aaaaaa", model: "m", name: "n", task: "t" }).includes("--tools"));
});

test("the child's output is read for turns, usage, its last words and its last tool", () => {
  const run = newRun();
  const usage = (total: number) => ({ input: 10, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 115, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
  const lines = [
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "task" }] } },
    { type: "message_end", message: { role: "assistant", provider: "openrouter", model: "a/b", content: [{ type: "toolCall", name: "grep" }], usage: usage(0.01), stopReason: "toolUse" } },
    { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } },
    { type: "message_end", message: { role: "assistant", provider: "openrouter", model: "a/b", content: [{ type: "text", text: "Found it." }, { type: "text", text: "src/a.ts:3" }], usage: usage(0.02), stopReason: "stop" } },
  ];
  assert.equal(readLine(run, "not json"), false);
  for (const l of lines) readLine(run, JSON.stringify(l));
  assert.equal(run.turns, 2);
  assert.equal(run.usage.input, 20);
  assert.equal(Number(run.usage.cost.total.toFixed(2)), 0.03);
  assert.equal(run.text, "Found it.\n\nsrc/a.ts:3");
  assert.equal(run.lastTool, "grep");
  assert.equal(run.model, "openrouter/a/b");
  assert.equal(run.stopReason, "stop");
});

test("long replies are cut and say so", () => {
  assert.equal(capText("short", 100), "short");
  const cut = capText("é".repeat(2000), 1024);
  assert.match(cut, /\[cut at 1 KB/);
  assert.ok(Buffer.byteLength(cut.split("\n\n[cut")[0], "utf8") <= 1024);
});
