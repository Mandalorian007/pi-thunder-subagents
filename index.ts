// pi-thunder-subagents: a `subagent` tool that hands a task to another Pi
// process, with its own context, and gets back its final reply.
//
//   Models    each call can name a model (and thinking level); otherwise the
//             role's, otherwise the parent's. Checked against the models with
//             credentials before anything starts.
//   Sessions  every subagent is a saved Pi session, beside the parent's:
//             <sessions>/<parent session id>/subagents/<role>-<id>.jsonl. It
//             can be opened with `pi --session`, and resumed by the tool.
//   Depth     PI_SUBAGENT_MAX_DEPTH levels below the top (default 1). A
//             process at the limit has no subagent tool, and a Pi started
//             from inside one (say, by its bash tool) refuses to run.
//   Recovery  `list` shows this session's subagents and which were cut off
//             (say, when the parent was killed mid-call), so one can be
//             resumed from where it stopped.
//   Cost      each result carries its subagents' usage, so the session's
//             totals include them.
//
// The parts that need no session are in ./lib.ts.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  addUsage,
  capText,
  childArgs,
  DEPTH_VAR,
  depthOf,
  dollars,
  emptyUsage,
  failed,
  isSessionId,
  loadRoles,
  MAX_DEPTH_VAR,
  maxDepthOf,
  newRun,
  newSessionId,
  readLine,
  readSaved,
  resolveModel,
  roleOfSession,
  sessionFile,
  THINKING,
  type ChildPlan,
  type Run,
  type Thinking,
} from "./lib.ts";

const MAX_PARALLEL = 8;
const CONCURRENCY = 4;
// What one parallel task may put in the parent's context.
const PER_TASK_CAP = 50 * 1024;

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
// The package's roles, then the user's, which replace them by name.
const ROLE_DIRS = [join(PACKAGE_DIR, "agents"), join(AGENT_DIR, "agents")];

type Spec = { agent?: string; task: string; model?: string; thinking?: Thinking };

type Child = {
  id: string;
  role: string;
  model: string;
  task: string;
  session?: string;
  exitCode: number;
  turns: number;
  cost: number;
  stopReason?: string;
  error?: string;
  lastTool?: string;
  text: string;
  usage: Run["usage"];
};

// How this process runs Pi, so a child runs the same Pi.
function piCommand(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return { command: process.execPath, args };
  return { command: "pi", args };
}

function runChild(plan: ChildPlan, cwd: string, depth: number, signal: AbortSignal | undefined, progress: (run: Run) => void) {
  return new Promise<{ run: Run; exitCode: number; stderr: string }>((resolve, reject) => {
    const run = newRun();
    const { command, args } = piCommand(childArgs(plan));
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, [DEPTH_VAR]: String(depth) } });
    let buffer = "";
    let stderr = "";
    let aborted = false;
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (readLine(run, line)) progress(run);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-8_000);
    });
    const kill = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5_000).unref();
    };
    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      if (buffer.trim()) readLine(run, buffer);
      if (aborted) reject(new Error("The subagent was stopped."));
      else resolve({ run, exitCode: code ?? 1, stderr });
    });
  });
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const footer = (c: Child) => `[subagent ${c.id} · ${c.model} · ${c.turns} turn${c.turns === 1 ? "" : "s"} · ${dollars(c.cost)}]`;

// Subagents running in this process, so `list` can tell them from ones cut off.
const running = new Set<string>();

const subagentDir = (ctx: ExtensionContext) => join(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId(), "subagents");

const brief = (c: Child) => ({ ...c, task: c.task.slice(0, 300), text: c.text.slice(0, 2_000) });

export default function subagents(pi: ExtensionAPI) {
  // How deep this process is, fixed at first load so /reload keeps it.
  const KEY = Symbol.for("pi-thunder-subagents.depth");
  const global = globalThis as { [KEY]?: number };
  const depth = (global[KEY] ??= depthOf(process.env));
  const maxDepth = maxDepthOf(process.env);
  if (depth > maxDepth) {
    process.stderr.write(`pi: refusing to start at subagent depth ${depth}; ${MAX_DEPTH_VAR} is ${maxDepth}. A subagent cannot start another Pi.\n`);
    process.exit(3);
  }
  // Whatever this process starts, including through bash, is a level deeper.
  process.env[DEPTH_VAR] = String(depth + 1);
  if (depth >= maxDepth) return;

  const roles = loadRoles(ROLE_DIRS);
  const roleList = [...roles.values()].map((r) => `${r.name}${r.model ? ` (${r.model})` : ""}: ${r.description}`).join("; ");

  const plan = (spec: Spec, ctx: ExtensionContext, resume?: string): ChildPlan => {
    const current = loadRoles(ROLE_DIRS);
    const roleName = resume ? roleOfSession(resume) : spec.agent;
    const role = roleName ? current.get(roleName) : undefined;
    if (spec.agent && !role) throw new Error(`No role named "${spec.agent}". Roles: ${[...current.keys()].join(", ") || "none"}.`);
    const parent = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const wanted = spec.model ?? role?.model ?? parent;
    if (!wanted) throw new Error("No model: name one with `model`, or choose one for this session.");
    const available = ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id }));
    const resolved = resolveModel(wanted, available, ctx.model?.provider);
    const sessionDir = subagentDir(ctx);
    if (resume && !sessionFile(sessionDir, resume)) throw new Error(`No subagent session "${resume}" belongs to this session.`);
    const name = role?.name ?? roleName ?? "general";
    return {
      sessionDir,
      sessionId: resume ?? newSessionId(name),
      model: resolved.model,
      thinking: spec.thinking ?? resolved.thinking ?? role?.thinking ?? (ctx.thinkingLevel as Thinking | undefined),
      tools: role?.tools,
      prompt: role?.prompt,
      name: `${name}: ${spec.task.replace(/\s+/g, " ").slice(0, 60)}`,
      task: spec.task,
    };
  };

  const start = async (p: ChildPlan, ctx: ExtensionContext, signal: AbortSignal | undefined, progress: (c: Child) => void): Promise<Child> => {
    const child: Child = { id: p.sessionId, role: roleOfSession(p.sessionId), model: p.model, task: p.task, exitCode: -1, turns: 0, cost: 0, text: "", usage: emptyUsage() };
    const fill = (run: Run) => Object.assign(child, { turns: run.turns, cost: run.usage.cost.total, usage: run.usage, stopReason: run.stopReason, error: run.error, lastTool: run.lastTool, text: run.text, model: run.model ?? p.model });
    running.add(p.sessionId);
    const { run, exitCode, stderr } = await runChild(p, ctx.cwd, depth + 1, signal, (r) => progress(fill(r))).finally(() => running.delete(p.sessionId));
    fill(run);
    child.exitCode = exitCode;
    child.session = sessionFile(p.sessionDir, p.sessionId);
    if (failed(run, exitCode) && !child.error) child.error = stderr.trim().split("\n").slice(-5).join("\n") || `exit ${exitCode}`;
    return child;
  };

  const usageOf = (children: Child[]) => children.reduce((u, c) => addUsage(u, c.usage), emptyUsage());
  const isFailed = (c: Child) => c.exitCode !== 0 || c.stopReason === "error" || c.stopReason === "aborted";

  const SpecSchema = {
    agent: Type.Optional(Type.String({ description: "A role, such as scout or worker. Leave out for a general subagent with your tools." })),
    task: Type.String({ description: "The whole task. The subagent has not seen this conversation: include what it needs, and say what to report back." }),
    model: Type.Optional(Type.String({ description: "A model as provider/id or id, optionally with :thinking, e.g. anthropic/claude-haiku-5.5. Default: the role's, else yours." })),
    thinking: Type.Optional(Type.Union(THINKING.map((t) => Type.Literal(t)), { description: "Thinking level. Default: the role's, else yours." })),
  };

  const list = (ctx: ExtensionContext) => {
    const dir = subagentDir(ctx);
    const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort() : [];
    const saved = files.map((n) => {
      const s = readSaved(readFileSync(join(dir, n), "utf8"));
      return { ...s, status: running.has(s.id) ? ("running" as const) : s.status, file: join(dir, n) };
    });
    if (!saved.length) return { content: [{ type: "text" as const, text: "This session has no subagents." }], details: { mode: "list", subagents: [] } };
    const when = (t?: string) => (t ? new Date(t).toLocaleString() : "unknown");
    const lines = saved.map(
      (s) =>
        `- ${s.id} · ${s.status} · ${s.model ?? "unknown model"} · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${dollars(s.cost)} · last active ${when(s.updated)}\n  task: ${s.task.replace(/\s+/g, " ").slice(0, 300)}`,
    );
    const interrupted = saved.filter((s) => s.status === "interrupted");
    const hint = interrupted.length ? `\n\nTo carry on with an interrupted one, call subagent with resume set to its ID and a task such as "You were interrupted. Carry on from where you stopped and finish the original task."` : "";
    return {
      content: [{ type: "text" as const, text: `This session's subagents (${saved.length}):\n${lines.join("\n")}${hint}` }],
      details: { mode: "list", subagents: saved.map(({ reply: _reply, ...s }) => s) },
    };
  };

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Hand a task to a subagent: a separate Pi with its own context, whose final reply is all that comes back to you.",
      "One task: agent + task. Several independent tasks at once: tasks (up to 8, 4 at a time). Steps that build on each other: chain, where {previous} in a step's task is replaced by the step before's reply.",
      "Every subagent's session is saved; pass its ID as resume (with a new task) to continue it with its context intact. list: true shows this session's subagents and which were interrupted.",
      `Roles: ${roleList || "none"}.`,
    ].join(" "),
    promptSnippet: "Delegate a self-contained task to a subagent with its own context and model",
    promptGuidelines: [
      "Use subagent for self-contained work whose details you do not need in your own context: a broad search, a review, an independent change. Only its final reply comes back, so say in the task exactly what to report (file:line, decisions, what changed and how it was checked).",
      "A subagent has not seen this conversation. Put everything it needs in the task.",
      "Run independent subagents together with tasks; use chain only when a step needs the previous step's reply.",
      "Choose a cheaper model for simple searches and summaries, and a stronger one for hard changes. To follow up with a subagent, pass its ID as resume rather than starting again.",
      "If an earlier subagent call has no result (the session was interrupted while it ran), call subagent with list: true, and resume the interrupted subagent with a task such as \"You were interrupted. Carry on from where you stopped and finish the original task.\" rather than starting it again.",
      "Subagents cannot start subagents of their own.",
    ],
    parameters: Type.Object({
      ...SpecSchema,
      task: Type.Optional(SpecSchema.task),
      resume: Type.Optional(Type.String({ description: "A subagent ID from an earlier result, such as scout-k3j9x2, to continue that subagent with task." })),
      tasks: Type.Optional(Type.Array(Type.Object(SpecSchema), { minItems: 1, maxItems: MAX_PARALLEL, description: "Independent tasks to run at once." })),
      chain: Type.Optional(Type.Array(Type.Object(SpecSchema), { minItems: 1, description: "Steps in order; {previous} in a task is the previous step's reply." })),
      list: Type.Optional(Type.Boolean({ description: "List this session's subagents: ID, status (finished, interrupted, failed, running), model, cost and task." })),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      const modes = [params.task !== undefined, params.tasks !== undefined, params.chain !== undefined, params.list === true].filter(Boolean).length;
      if (modes !== 1) throw new Error("Give exactly one of task, tasks, chain or list.");
      if (params.list) return list(ctx);
      if (params.resume && !isSessionId(params.resume)) throw new Error(`"${params.resume}" is not a subagent ID.`);
      if (params.resume && !params.task) throw new Error("resume needs a task: what the subagent should do next.");
      const update = (text: string, children: Child[]) => onUpdate?.({ content: [{ type: "text", text }], details: { children: children.map(brief) } });
      const line = (c: Child) => `${c.id}: ${c.turns} turn${c.turns === 1 ? "" : "s"}, ${dollars(c.cost)}${c.lastTool ? `, last ${c.lastTool}` : ""}`;

      if (params.task !== undefined) {
        const p = plan({ agent: params.agent, task: params.task, model: params.model, thinking: params.thinking }, ctx, params.resume);
        const c = await start(p, ctx, signal, (c) => update(line(c), [c]));
        const body = isFailed(c) ? `Subagent ${c.id} failed${c.stopReason ? ` (${c.stopReason})` : ""}: ${c.error}` : c.text || "(no reply)";
        return { content: [{ type: "text", text: `${body}\n\n${footer(c)}` }], details: { mode: "single", children: [brief(c)] }, usage: usageOf([c]), isError: isFailed(c) };
      }

      if (params.tasks) {
        const plans = params.tasks.map((t) => plan(t, ctx));
        const live: Child[] = [];
        const children = await mapLimited(plans, CONCURRENCY, (p, i) =>
          start(p, ctx, signal, (c) => {
            live[i] = c;
            const done = live.filter((x) => x && x.exitCode !== -1).length;
            update(`Parallel: ${done}/${plans.length} done\n${live.filter(Boolean).map(line).join("\n")}`, live.filter(Boolean));
          }),
        );
        const ok = children.filter((c) => !isFailed(c)).length;
        const sections = children.map((c) => `### ${c.id} ${isFailed(c) ? "failed" : "done"}\n\n${isFailed(c) ? c.error : capText(c.text || "(no reply)", PER_TASK_CAP)}\n\n${footer(c)}`);
        return {
          content: [{ type: "text", text: `Parallel: ${ok}/${children.length} succeeded, ${dollars(usageOf(children).cost.total)} in all\n\n${sections.join("\n\n---\n\n")}` }],
          details: { mode: "parallel", children: children.map(brief) },
          usage: usageOf(children),
          isError: ok === 0,
        };
      }

      const steps = params.chain!;
      const children: Child[] = [];
      let previous = "";
      for (const [i, step] of steps.entries()) {
        const p = plan({ ...step, task: step.task.replaceAll("{previous}", previous) }, ctx);
        const c = await start(p, ctx, signal, (c) => update(`Step ${i + 1}/${steps.length}: ${line(c)}`, [...children, c]));
        children.push(c);
        if (isFailed(c)) {
          return {
            content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${c.id}): ${c.error}\n\n${children.map(footer).join("\n")}` }],
            details: { mode: "chain", children: children.map(brief) },
            usage: usageOf(children),
            isError: true,
          };
        }
        previous = c.text;
      }
      return {
        content: [{ type: "text", text: `${previous || "(no reply)"}\n\n${children.map(footer).join("\n")}` }],
        details: { mode: "chain", children: children.map(brief) },
        usage: usageOf(children),
      };
    },
  });
}
