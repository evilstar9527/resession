# resession

A lightweight, global **LRU session picker** for [Claude Code](https://claude.com/claude-code)
and [Codex CLI](https://developers.openai.com/codex/cli/). One command lists **every**
session across **all** your projects — sorted by most-recent-use — and resumes the one you
pick **natively**, in its original directory.

No more `cd`-ing into the exact worktree just to find a conversation in the built-in
project-scoped `/resume`.

```
npx resession
```

## Why

Claude Code and Codex both store sessions as JSONL files on disk
(`~/.claude/projects/**`, `~/.codex/sessions/**`). Their built-in resume pickers are scoped
to the current project. But the way you actually think about sessions is *"the thing I was
just working on"* — LRU. `resession` reads those files directly, sorts by file mtime, and
hands the chosen session straight back to the real agent.

## Usage

```
resession              open the interactive picker (newest first)
resession ls           print the recency-sorted table, no TUI
resession <n>          resume the n-th session from the list
resession <id>         resume by sessionId (or file name)
```

Options:

| Flag | Meaning |
|------|---------|
| `--here` | Only sessions from the current git repo's worktrees |
| `--all` | Parse/show every session (default: newest 50) |
| `--limit <N>` | Cap how many sessions to show/parse |
| `--local` | Only local sessions (ignore remote) |
| `--remote` | Only remote sessions |
| `--json` | (with `ls`) print raw JSON instead of a table |
| `--dry-run` | Print the resume command instead of executing it |
| `-h`, `--help` / `-v`, `--version` | Help / version |

In the picker: type to fuzzy-filter (by project, title, branch, agent), arrow-keys to move,
**Enter** to open, **Esc**/**Ctrl-C** to cancel.

## Cross-device sync (optional)

By default `resession` is purely local. If you run a small sync server (see
[`server/`](server/)), you can view sessions from **all** your machines on any device.

```
resession login <url> <token> [--device <name>]   # connect to your server
resession push                                     # upload this machine's sessions
resession pull                                     # refresh the remote session list
resession logout                                   # disconnect
```

After `pull`, `resession ls` / the picker show a **device** column. Sessions from other
machines are marked ☁ and are **read-only**: pressing Enter downloads the transcript and
opens it in your pager (it does not try to resume on the wrong machine). Local sessions
behave exactly as before — fully resumable. Not logging in changes nothing.

> Why read-only for remote: a session is bound to its original `cwd`, code, and git state.
> Viewing the history across devices is reliable; resuming "the work" on a machine that
> lacks that workspace is not, so it is intentionally not offered.


## How resume works

| Session source | Command run (in the session's original cwd) |
|----------------|---------------------------------------------|
| Claude | `claude --dangerously-skip-permissions --resume <id>` |
| Codex | `codex --dangerously-bypass-approvals-and-sandbox resume --cd <cwd> <id>` |

`resession` inherits your terminal so you land directly inside the live agent, then exits
with the agent's exit code. **v1 is native-only** (Claude sessions resume with Claude, Codex
with Codex).

## Environment overrides

Honors the same overrides as the underlying tools:

- `CLAUDE_CONFIG_DIR` / `CLAUDE_HOME` — Claude home (default `~/.claude`)
- `CODEX_HOME` — Codex home (default `~/.codex`)

## Requirements

- Node.js ≥ 18
- `claude` and/or `codex` on your `PATH` (whichever you want to resume)

## License

MIT
