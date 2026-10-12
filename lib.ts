// The parts of the subagent tool that need no Pi session: depth, roles,
// models, the child's command line, and reading what the child printed.
// Plain data in and out, so the tests run them in plain Node.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING)[number];

// ---------------------------------------------------------------- depth

// PI_SUBAGENT_DEPTH is how deep this process is: unset at the top, 1 in a
// subagent, and so on. The tool sets it for every child. PI_SUBAGENT_MAX_DEPTH
// is how many levels may exist below the top (default 1; 0 turns subagents
// off).
export const DEPTH_VAR = "PI_SUBAGENT_DEPTH";
export const MAX_DEPTH_VAR = "PI_SUBAGENT_MAX_DEPTH";
export const DEFAULT_MAX_DEPTH = 1;

const count = (value: string | undefined, fallback: number, name: string) => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of 0 or more, not ${JSON.stringify(value)}`);
  return n;
};

export const depthOf = (env: NodeJS.ProcessEnv) => count(env[DEPTH_VAR], 0, DEPTH_VAR);
export const maxDepthOf = (env: NodeJS.ProcessEnv) => count(env[MAX_DEPTH_VAR], DEFAULT_MAX_DEPTH, MAX_DEPTH_VAR);

// ---------------------------------------------------------------- roles

export type Role = {
  name: string;
  description: string;
  model?: string;
  thinking?: Thinking;
  tools?: string[];
  prompt: string;
  file: string;
};

// A role is a markdown file with a frontmatter block of `key: value` lines
// (name, description, model, thinking, tools) and its instructions below.
export function parseRole(text: string, file: string): Role | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  if (!meta.name || !/^[a-z0-9][a-z0-9-]*$/.test(meta.name)) return undefined;
  const thinking = THINKING.find((t) => t === meta.thinking);
  const tools = meta.tools ? meta.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  return {
    name: meta.name,
    description: meta.description ?? "",
    ...(meta.model ? { model: meta.model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(tools?.length ? { tools } : {}),
    prompt: match[2].trim(),
    file,
  };
}

// Roles from each directory in turn; a later directory's role replaces an
// earlier one of the same name.
export function loadRoles(dirs: string[]): Map<string, Role> {
  const roles = new Map<string, Role>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
      const file = join(dir, name);
      const role = parseRole(readFileSync(file, "utf8"), file);
      if (role) roles.set(role.name, role);
    }
  }
  return roles;
}

// ---------------------------------------------------------------- models

export type ModelRef = { provider: string; id: string };

// "provider/id", "id", either with ":thinking" on the end, resolved against
// the models that have credentials. An exact "provider/id" wins, then an exact
// id (the parent's provider first). Returns the canonical "provider/id" and
// any thinking level the spec carried.
export function resolveModel(spec: string, available: ModelRef[], preferProvider?: string): { model: string; thinking?: Thinking } {
  let name = spec.trim();
  let thinking: Thinking | undefined;
  const colon = name.lastIndexOf(":");
  if (colon > 0) {
    const level = THINKING.find((t) => t === name.slice(colon + 1));
    if (level) {
      thinking = level;
      name = name.slice(0, colon);
    }
  }
  const full = (m: ModelRef) => `${m.provider}/${m.id}`;
  const exact = available.find((m) => full(m) === name);
  if (exact) return { model: full(exact), thinking };
  const byId = available.filter((m) => m.id === name);
  const chosen = byId.find((m) => m.provider === preferProvider) ?? (byId.length === 1 ? byId[0] : undefined);
  if (chosen) return { model: full(chosen), thinking };
  if (byId.length > 1) throw new Error(`Model "${name}" is offered by several providers: ${byId.map(full).join(", ")}. Name one as provider/id.`);
  const near = available
    .map(full)
    .filter((m) => m.toLowerCase().includes(name.toLowerCase().split("/").pop() ?? ""))
    .slice(0, 6);
  throw new Error(`No model "${name}" with credentials.${near.length ? ` Close: ${near.join(", ")}.` : ""}`);
}

// ---------------------------------------------------------------- sessions

// A child's session ID: its role, then six random characters ("scout-k3j9x2").
// Pi accepts letters, digits, ".", "_" and "-", starting and ending with a
// letter or digit.
export function newSessionId(role: string, random = Math.random): string {
  const tail = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)]).join("");
  return `${role}-${tail}`;
}

export const isSessionId = (id: string) => /^[a-z0-9][a-z0-9-]*-[a-z0-9]{6}$/.test(id);
export const roleOfSession = (id: string) => id.slice(0, id.lastIndexOf("-"));

// A child's saved session, which Pi names <timestamp>_<id>.jsonl.
export function sessionFile(dir: string, id: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((n) => n.endsWith(`_${id}.jsonl`));
  return name ? join(dir, name) : undefined;
}

// What a saved subagent session came to, read from its file: for listing a
// session's subagents, above all after the parent was killed mid-call.
//   finished     its last message is a reply that ended normally
//   failed       its last message is an error or an abort
//   interrupted  anything else: it stopped mid-turn, so it can be resumed
export type Status = "finished" | "failed" | "interrupted";

export type Saved = { id: string; task: string; model?: string; turns: number; cost: number; status: Status; updated?: string; reply: string };

type Entry = {
  type?: string;
  id?: string;
  timestamp?: string;
  provider?: string;
  modelId?: string;
  message?: { role?: string; content?: Part[] | string; stopReason?: string; usage?: Usage };
};

const textOf = (content: Part[] | string | undefined) =>
  typeof content === "string" ? content : (content ?? []).filter((p) => p.type === "text" && p.text).map((p) => p.text!.trim()).join("\n\n");

export function readSaved(jsonl: string): Saved {
  const entries: Entry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line cut off when the process was killed.
    }
  }
  const header = entries.find((e) => e.type === "session");
  const model = entries.filter((e) => e.type === "model_change").at(-1);
  const messages = entries.filter((e) => e.type === "message" && e.message);
  const replies = messages.filter((e) => e.message!.role === "assistant");
  const last = messages.at(-1)?.message;
  const status: Status =
    last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")
      ? "failed"
      : last?.role === "assistant" && last.stopReason !== "toolUse"
        ? "finished"
        : "interrupted";
  return {
    id: header?.id ?? "",
    task: textOf(messages.find((e) => e.message!.role === "user")?.message!.content),
    ...(model?.provider && model.modelId ? { model: `${model.provider}/${model.modelId}` } : {}),
    turns: replies.length,
    cost: replies.reduce((sum, e) => sum + (e.message!.usage?.cost?.total ?? 0), 0),
    status,
    updated: entries.at(-1)?.timestamp,
    reply: textOf(replies.at(-1)?.message!.content),
  };
}

// ---------------------------------------------------------------- the child

export type ChildPlan = {
  sessionDir: string;
  sessionId: string;
  model: string;
  thinking?: Thinking;
  tools?: string[];
  prompt?: string;
  name: string;
  task: string;
};

export function childArgs(plan: ChildPlan): string[] {
  const args = ["--mode", "json", "-p", "--session-dir", plan.sessionDir, "--session-id", plan.sessionId, "--model", plan.model, "--name", plan.name];
  if (plan.thinking) args.push("--thinking", plan.thinking);
  if (plan.tools?.length) args.push("--tools", plan.tools.join(","));
  if (plan.prompt) args.push("--append-system-prompt", plan.prompt);
  args.push("--", plan.task);
  return args;
}

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export function addUsage(into: Usage, u: Partial<Usage> | undefined): Usage {
  if (!u) return into;
  into.input += u.input ?? 0;
  into.output += u.output ?? 0;
  into.cacheRead += u.cacheRead ?? 0;
  into.cacheWrite += u.cacheWrite ?? 0;
  into.totalTokens += u.totalTokens ?? 0;
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) into.cost[k] += u.cost?.[k] ?? 0;
  return into;
}

// What a child's run came to, read from its `--mode json` lines as they come.
export type Run = {
  turns: number;
  usage: Usage;
  model?: string;
  text: string;
  lastTool?: string;
  stopReason?: string;
  error?: string;
};

export const newRun = (): Run => ({ turns: 0, usage: emptyUsage(), text: "" });

type Part = { type: string; text?: string; name?: string };
type Line = { type?: string; message?: { role?: string; content?: Part[] | string; usage?: Usage; model?: string; provider?: string; stopReason?: string; errorMessage?: string } };

// Folds one line of the child's output into the run. Returns whether it changed.
export function readLine(run: Run, raw: string): boolean {
  let line: Line;
  try {
    line = JSON.parse(raw);
  } catch {
    return false;
  }
  const m = line.message;
  if (line.type !== "message_end" || m?.role !== "assistant") return false;
  run.turns += 1;
  addUsage(run.usage, m.usage);
  if (m.model) run.model = m.provider ? `${m.provider}/${m.model}` : m.model;
  if (m.stopReason) run.stopReason = m.stopReason;
  if (m.errorMessage) run.error = m.errorMessage;
  const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
  const text = parts.filter((p) => p.type === "text" && p.text?.trim()).map((p) => p.text!.trim()).join("\n\n");
  if (text) run.text = text;
  const tool = parts.filter((p) => p.type === "toolCall").at(-1)?.name;
  if (tool) run.lastTool = tool;
  return true;
}

export const failed = (run: Run, exitCode: number) => exitCode !== 0 || run.stopReason === "error" || run.stopReason === "aborted";

export const dollars = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

// Text over `cap` bytes keeps its start and says how much was cut.
export function capText(text: string, cap: number): string {
  if (Buffer.byteLength(text, "utf8") <= cap) return text;
  let cut = text.slice(0, cap);
  while (Buffer.byteLength(cut, "utf8") > cap) cut = cut.slice(0, -1);
  return `${cut}\n\n[cut at ${Math.round(cap / 1024)} KB; the whole reply is in the subagent's session]`;
}
