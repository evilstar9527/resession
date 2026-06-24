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

Options:
  --here          only sessions from the current git repo's worktrees
  --all           parse/show every session (default: newest ${DEFAULT_LIMIT})
  --limit <N>     cap how many sessions to show/parse
  --json          (with ls) print raw JSON instead of a table
  --dry-run       print the resume command instead of running it
  -h, --help      show this help
  -v, --version   print version`;

function parseArgs(argv) {
  const opts = { here: false, all: false, limit: DEFAULT_LIMIT, json: false, dryRun: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--here': opts.here = true; break;
      case '--all': opts.all = true; break;
      case '--json': opts.json = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--limit': opts.limit = Number(argv[++i]); break;
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      default:
        if (a.startsWith('--limit=')) opts.limit = Number(a.slice('--limit='.length));
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

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));

  if (opts.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (opts.version) { process.stdout.write(readVersion() + '\n'); return 0; }

  const sub = positional[0];

  // resession <n>  — resume by 1-based index into the LRU list
  if (sub && /^\d+$/.test(sub)) {
    const n = Number(sub);
    const sessions = discoverSessions(buildDiscoverOpts(opts, Math.max(n, DEFAULT_LIMIT)));
    const session = sessions[n - 1];
    if (!session) {
      process.stderr.write(`resession: no session #${n} (found ${sessions.length})\n`);
      return 1;
    }
    return resumeSession(session, { dryRun: opts.dryRun });
  }

  // resession <id> — resume by sessionId / file stem (needs full scan to find it)
  if (sub && sub !== 'ls' && sub !== 'list') {
    const sessions = discoverSessions(buildDiscoverOpts({ ...opts, all: true }, Infinity));
    const session = sessions.find(
      (s) => s.sessionId === sub || path.basename(s.filePath, '.jsonl') === sub
    );
    if (!session) {
      process.stderr.write(`resession: session '${sub}' not found\n`);
      return 1;
    }
    return resumeSession(session, { dryRun: opts.dryRun });
  }

  // resession ls — non-interactive listing
  if (sub === 'ls' || sub === 'list') {
    const sessions = discoverSessions(buildDiscoverOpts(opts, opts.limit));
    if (opts.json) {
      process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
    } else {
      process.stdout.write(renderTable(sessions) + '\n');
    }
    return 0;
  }

  // default — interactive picker
  const sessions = discoverSessions(buildDiscoverOpts(opts, opts.limit));
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
  return resumeSession(chosen, { dryRun: opts.dryRun });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`resession: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
