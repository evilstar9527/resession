#!/usr/bin/env node
// resession — global LRU session picker for Claude Code & Codex.
//
//   resession              open the interactive picker (newest first)
//   resession ls           print the recency-sorted table, no TUI
//   resession <n>          resume the n-th session from the list
//   resession <id>         resume by sessionId (or file name)
//
// Flags:
//   --here          only sessions from the current git repo's worktrees
//   --all           parse/show every session (default shows newest 50)
//   --limit <N>     cap how many sessions to show/parse (default 50)
//   --json          (with ls) print raw JSON instead of a table
//   --dry-run       print the resume command instead of executing it
//   -h, --help      show help
//   -v, --version   show version

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { discoverSessions, currentWorktreePaths } from '../src/discover.js';
import { resumeSession } from '../src/resume.js';
import { renderTable, pickSession } from '../src/ui.js';

const DEFAULT_LIMIT = 50;

function readVersion() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `resession — global LRU session picker for Claude Code & Codex

Usage:
  resession              open the interactive picker (newest first)
  resession ls           print the recency-sorted table, no TUI
  resession <n>          resume the n-th session from the list
  resession <id>         resume by sessionId (or file name)

Cross-device (optional — only after \`login\`):
  resession login                                   browser-authorize this device
  resession login <url>                             use a specific sync server
  resession push                                    upload local sessions
  resession pull                                    refresh remote session list
  resession logout                                  disconnect

Options:
  --here          only sessions from the current git repo's worktrees
  --all           parse/show every session (default: newest ${DEFAULT_LIMIT})
  --limit <N>     cap how many sessions to show/parse
  --json          (with ls) print raw JSON instead of a table
  --dry-run       print the resume command instead of running it
  -h, --help      show this help
  -v, --version   print version`;

function parseArgs(argv) {
  const opts = { here: false, all: false, limit: DEFAULT_LIMIT, json: false, dryRun: false, device: null, local: false, remote: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--here': opts.here = true; break;
      case '--all': opts.all = true; break;
      case '--json': opts.json = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--local': opts.local = true; break;
      case '--remote': opts.remote = true; break;
      case '--limit': opts.limit = Number(argv[++i]); break;
      case '--device': opts.device = argv[++i]; break;
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      default:
        if (a.startsWith('--limit=')) opts.limit = Number(a.slice('--limit='.length));
        else if (a.startsWith('--device=')) opts.device = a.slice('--device='.length);
        else positional.push(a);
    }
  }
  return { opts, positional };
}

function buildDiscoverOpts(opts, limit) {
  const discoverOpts = { limit: opts.all ? Infinity : limit };
  if (opts.here) discoverOpts.worktrees = currentWorktreePaths(process.cwd());
  return discoverOpts;
}

// Gather the session list to show: always local discovery; plus, when logged in
// and not restricted to --local/--here, the cached remote sessions (read-only).
// Local sessions are tagged { local:true }; remote-only ones { local:false }.
// Dedupe key is source+sessionId; a locally-present session always wins (so it
// stays resumable). Purely additive: with no remote cache this returns exactly
// the previous local-only list.
async function gatherSessions(opts, limit) {
  const local = discoverSessions(buildDiscoverOpts(opts, limit));
  for (const s of local) { s.local = true; s.deviceId = 'this'; }

  if (opts.local || opts.here) return local;

  let remote = [];
  try {
    const { loadConfig, loadRemoteCache } = await import('../src/remote.js');
    if (loadConfig()) remote = loadRemoteCache().sessions || [];
  } catch {
    remote = [];
  }
  if (opts.remote) {
    // show only remote sessions
    return remote.map((s) => ({ ...s, local: false }))
      .sort((a, b) => ((b.updatedAt || '') < (a.updatedAt || '') ? -1 : 1));
  }
  if (!remote.length) return local;

  const haveLocal = new Set(local.map((s) => `${s.source}/${s.sessionId}`));
  const merged = local.slice();
  for (const r of remote) {
    if (haveLocal.has(`${r.source}/${r.sessionId}`)) continue; // local copy wins
    merged.push({ ...r, local: false });
  }
  merged.sort((a, b) => ((b.updatedAt || '') < (a.updatedAt || '') ? -1 : (b.updatedAt || '') > (a.updatedAt || '') ? 1 : 0));
  return opts.all ? merged : merged.slice(0, limit);
}

// Open a remote (read-only) session: download its JSONL and show it in a pager.
async function viewRemote(session) {
  const { loadConfig, getSessionJsonl } = await import('../src/remote.js');
  const { renderTranscript } = await import('../src/ui.js');
  const cfg = loadConfig();
  if (!cfg) { process.stderr.write('resession: not logged in\n'); return 1; }
  let jsonl;
  try {
    jsonl = await getSessionJsonl(cfg, session.deviceId, session.source, session.sessionId);
  } catch (err) {
    process.stderr.write(`resession: ${err.message}\n`);
    return 1;
  }
  return pageText(renderTranscript(jsonl, session));
}

// Pipe text through the user's pager (or print if none / not a TTY).
function pageText(text) {
  if (!process.stdout.isTTY) { process.stdout.write(text + '\n'); return 0; }
  const pager = process.env.PAGER || 'less';
  const args = pager === 'less' ? ['-R'] : [];
  const r = spawnSync(pager, args, { input: text, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.error) { process.stdout.write(text + '\n'); }
  return 0;
}

// A session is openable locally (resumable) vs remote (read-only view).
function openSession(session, opts) {
  if (session.local) return resumeSession(session, { dryRun: opts.dryRun });
  return viewRemote(session);
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));

  if (opts.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (opts.version) { process.stdout.write(readVersion() + '\n'); return 0; }

  const sub = positional[0];

  // Cross-device verbs (only meaningful after `login`; intercepted first).
  if (sub === 'login' || sub === 'logout' || sub === 'push' || sub === 'pull') {
    const cmds = await import('../src/commands.js');
    if (sub === 'login') return cmds.cmdLogin(positional, opts);
    if (sub === 'logout') return cmds.cmdLogout();
    if (sub === 'push') return cmds.cmdPush();
    if (sub === 'pull') return cmds.cmdPull();
  }

  // resession <n>  — open the n-th session (resume if local, view if remote)
  if (sub && /^\d+$/.test(sub)) {
    const n = Number(sub);
    const sessions = await gatherSessions(opts, Math.max(n, DEFAULT_LIMIT));
    const session = sessions[n - 1];
    if (!session) {
      process.stderr.write(`resession: no session #${n} (found ${sessions.length})\n`);
      return 1;
    }
    return openSession(session, opts);
  }

  // resession <id> — open by sessionId / file stem (local or remote)
  if (sub && sub !== 'ls' && sub !== 'list') {
    const sessions = await gatherSessions({ ...opts, all: true }, Infinity);
    const session = sessions.find(
      (s) => s.sessionId === sub || (s.filePath && path.basename(s.filePath, '.jsonl') === sub)
    );
    if (!session) {
      process.stderr.write(`resession: session '${sub}' not found\n`);
      return 1;
    }
    return openSession(session, opts);
  }

  // resession ls — non-interactive listing
  if (sub === 'ls' || sub === 'list') {
    const sessions = await gatherSessions(opts, opts.limit);
    if (opts.json) {
      process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
    } else {
      process.stdout.write(renderTable(sessions) + '\n');
    }
    return 0;
  }

  // default — interactive picker
  const sessions = await gatherSessions(opts, opts.limit);
  if (!sessions.length) {
    process.stderr.write('resession: no sessions found\n');
    return 1;
  }
  if (!process.stdin.isTTY) {
    // Not a terminal — fall back to the table so the output is still useful.
    process.stdout.write(renderTable(sessions) + '\n');
    return 0;
  }
  const chosen = await pickSession(sessions);
  if (!chosen) return 130; // cancelled
  return openSession(chosen, opts);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`resession: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
