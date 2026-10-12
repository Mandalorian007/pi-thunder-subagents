# pi-thunder-subagents

Subagents for [Pi](https://pi.dev). The `subagent` tool hands a task to another Pi process, which has its own context, and returns that process's final reply. The subagent:
- runs on whichever model you choose;
- is saved as a Pi session that you can open or resume;
- cannot start subagents of its own unless you raise the limit.

## Install

```sh
pi install git:github.com/Mandalorian007/pi-thunder-subagents        # every pi process for this user
pi -e git:github.com/Mandalorian007/pi-thunder-subagents             # try it for one run
```

Pin a version with `@v0.1.0`. Install it for the user, not just for one run with `-e`. The depth limit holds because every Pi process loads the extension, including each subagent and any Pi a subagent starts.

## The tool

| Mode | Call | What comes back |
|---|---|---|
| One task | `{ agent?, task, model?, thinking? }` | The subagent's final reply |
| Resume | `{ resume: "scout-k3j9x2", task }` | The reply from the same subagent, with its context intact |
| Parallel | `{ tasks: [{ agent?, task, model?, thinking? }, …] }` | Up to 8 tasks, 4 at a time. Each reply is capped at 50 KB |
| Chain | `{ chain: [{ …, task: "… {previous} …" }, …] }` | The last step's reply. `{previous}` in a task is replaced by the reply of the step before |

The parent gets only each subagent's final reply, followed by a footer line:

```
[subagent scout-k3j9x2 · openrouter/anthropic/claude-haiku-5.5 · 4 turns · $0.0123]
```

The footer's ID is what `resume` takes. A failed subagent comes back as an error, with its own error message or the end of its stderr.

## Models

Each subagent's model comes from the first of these that is set:
1. the call's `model`;
2. the role's `model`;
3. the model of the session that called it.

A model can be given as `provider/id` or as a bare `id`, optionally followed by `:thinking` (for example `anthropic/claude-haiku-5.5:low`). It is checked against the models you have credentials for before anything starts. An unknown name fails at once, listing close matches.

The thinking level works the same way. It comes from the call's `thinking`, else the model's `:suffix`, else the role's `thinking`, else the parent's level.

## Sessions

Every subagent is a saved Pi session, next to the session of the parent that started it:

```
~/.pi/agent/sessions/<project>/<parent>.jsonl
~/.pi/agent/sessions/<project>/<parent id>/subagents/<timestamp>_<role>-<id>.jsonl
```

Each one holds the subagent's whole transcript, so you can open it with `pi --session <path>` or export it with `pi --export <path>`. `pi -c` and `pi -r` do not list them; they look only at the project's own sessions. The tool's `resume` continues a subagent in the same file, so it keeps everything it read before.

Each result also carries its subagents' token usage and cost, so they count in the parent session's totals. The result's `details` hold a short record of each subagent (ID, model, turns, cost and session file) rather than its transcript.

## Depth

| Variable | Default | |
|---|---|---|
| `PI_SUBAGENT_MAX_DEPTH` | `1` | How many levels may exist below the session you started. `1`: subagents, but no sub-subagents. `0`: no subagents at all |
| `PI_SUBAGENT_DEPTH` | unset | Set by the extension: how deep a process is. Leave it alone |

- **At the limit, there is no tool.** A process at the limit gets no `subagent` tool, so its model never sees one.
- **Starting Pi through bash counts.** Every process sets `PI_SUBAGENT_DEPTH` one higher for whatever it starts, so a `pi` run through a subagent's `bash` tool counts as one level deeper.
- **Past the limit, Pi refuses to start.** It exits with code 3 and the message `pi: refusing to start at subagent depth 2; PI_SUBAGENT_MAX_DEPTH is 1`.

This guards against runaway recursion, not against an agent that sets out to get around it: a process that clears or rewrites those variables is not stopped.

## Roles

A role is a markdown file. Its frontmatter sets the role's name and defaults, and the text below becomes the instructions added to the subagent's system prompt:

```markdown
---
name: scout
description: Fast, read-only search of the codebase; reports where things are, with file:line
model: anthropic/claude-haiku-5.5
thinking: low
tools: read, grep, find, ls, jev_find
---

You are a scout. …
```

Every frontmatter field except `name` is optional. Without `tools`, a subagent gets Pi's default tools plus every installed extension's tools; unknown tool names are ignored. Two roles ship in `agents/`:

- **scout:** Haiku 5.5, read-only. It reports places as `path:start-end`.
- **worker:** your model and every tool. It makes a self-contained change and reports what changed and how it was checked.

Your own roles go in `~/.pi/agent/agents/*.md`. A role there replaces a shipped role of the same name. Roles are re-read on every call. A task with no `agent` runs as `general`, with no role instructions and your model and tools.

Project-local roles (`.pi/agents/` in a repository) are not loaded. A role's instructions run with your credentials, so a repository should not be able to supply them.

## Files

- `index.ts`: the tool, the depth guard, and starting and reading child processes.
- `lib.ts`: the parts that need no session, such as roles, model resolution, the child's command line and reading its output.
- `agents/`: the shipped roles.

`npm test` runs `lib.ts` offline.
