// session discovery + lightweight JSONL metadata parsing.
//
// Ported from ~/.claude/skills/resume-session/scripts/resume_session.py, with one
// deliberate change: discovery is GLOBAL by default (no git-worktree filter), and
// it is stat-first / parse-lazily so a machine with hundreds of sessions stays fast.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { loadLabels } from './store.js';

// --------------------------------------------------------------------------
// paths (honours the same env overrides as the skill)
// --------------------------------------------------------------------------

function resolveHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

export function claudeHome() {
  const raw = (process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_HOME || '').trim();
  return raw ? resolveHome(raw) : path.join(os.homedir(), '.claude');
}

export function claudeProjectsDir() {
  return path.join(claudeHome(), 'projects');
}

export function codexHome() {
  const raw = (process.env.TRANSESSION_CODEX_HOME || process.env.CODEX_HOME || '').trim();
  return raw ? resolveHome(raw) : path.join(os.homedir(), '.codex');
}

const BUCKET_RE = /[^A-Za-z0-9-]/g;

export function pathToClaudeProjectBucket(projectPath) {
  return path.resolve(projectPath).replace(BUCKET_RE, '-');
}

// --------------------------------------------------------------------------
// git worktree detection (only used for the optional --here filter)
// --------------------------------------------------------------------------

export function currentWorktreePaths(cwd) {
  let out;
  try {
    out = execFileSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  } catch {
    return new Set([path.resolve(cwd)]);
  }
  const paths = new Set();
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      paths.add(path.resolve(line.slice('worktree '.length).trim()));
    }
  }
  return paths.size ? paths : new Set([path.resolve(cwd)]);
}

// --------------------------------------------------------------------------
// jsonl walking + head parsing
// --------------------------------------------------------------------------

// Only read the first N lines to extract metadata; the early records reliably
// carry cwd / sessionId / first user message.
const MAX_HEAD_LINES = 200;

function* walkJsonl(root, nameFilter) {
  let stack;
  try {
    if (!fs.existsSync(root)) return;
    stack = [root];
  } catch {
    return;
  }
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (nameFilter && !nameFilter(entry.name)) continue;
        yield full;
      }
    }
  }
}

function* iterJsonlHead(filePath, maxLines = MAX_HEAD_LINES) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  let count = 0;
  for (const line of raw.split('\n')) {
    if (count >= maxLines) return;
    const trimmed = line.trim();
    if (!trimmed) continue;
    count += 1;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // skip malformed line
    }
  }
}

function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function isoFromMs(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

// Claude `--resume` only knows about top-level `<bucket>/<sessionId>.jsonl`.
// Files nested deeper (subagents / memory) cannot be resumed directly.
function isTopLevelClaudeSession(filePath, projectsRoot) {
  const rel = path.relative(projectsRoot, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).length === 2; // <bucket>/<sessionId>.jsonl
}

// --------------------------------------------------------------------------
// per-source metadata extraction
// --------------------------------------------------------------------------

function claudeSessionMeta(filePath) {
  let cwd = null;
  let sessionId = path.basename(filePath, '.jsonl');
  let gitBranch = null;
  let title = null;
  let createdAt = null;
  let version = null;

  for (const rec of iterJsonlHead(filePath)) {
    if (!rec || typeof rec !== 'object') continue;
    cwd = cwd || rec.cwd || null;
    sessionId = rec.sessionId || sessionId;
    gitBranch = gitBranch || rec.gitBranch || null;
    version = version || rec.version || null;
    const ts = rec.timestamp;
    if (ts && (createdAt === null || ts < createdAt)) createdAt = ts;

    if (!title && rec.type === 'user') {
      const content = rec.message && rec.message.content;
      if (typeof content === 'string') {
        title = content.trim().slice(0, 80) || null;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block.text === 'string') {
            title = block.text.trim().slice(0, 80);
            if (title) break;
          }
        }
      }
    }
    if (!title && rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
      title = rec.aiTitle.slice(0, 80);
    }
    if (cwd && title) break;
  }

  if (!cwd) return null;
  const mtime = fileMtimeMs(filePath);
  return {
    source: 'claude',
    sessionId,
    cwd,
    title,
    gitBranch,
    createdAt,
    updatedAt: isoFromMs(mtime),
    updatedAtMs: mtime,
    filePath,
    version,
  };
}

function codexSessionMeta(filePath) {
  let cwd = null;
  let sessionId = null;
  let gitBranch = null;
  let title = null;
  let createdAt = null;
  let model = null;
  let version = null;

  for (const rec of iterJsonlHead(filePath)) {
    if (!rec || typeof rec !== 'object') continue;
    const ts = rec.timestamp;
    if (typeof ts === 'string' && (createdAt === null || ts < createdAt)) createdAt = ts;

    const rtype = rec.type;
    const payload = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};

    if (rtype === 'session_meta') {
      sessionId = sessionId || payload.id || null;
      cwd = cwd || payload.cwd || null;
      model = model || payload.model_provider || null;
      version = version || payload.cli_version || null;
      continue;
    }
    if (rtype === 'turn_context') {
      cwd = cwd || payload.cwd || null;
      model = model || payload.model || null;
      gitBranch = gitBranch || payload.git_branch || null;
      continue;
    }
    if (rtype === 'response_item' && payload.type === 'message') {
      const role = payload.role || 'assistant';
      if (!title && role === 'user' && Array.isArray(payload.content)) {
        const parts = [];
        for (const block of payload.content) {
          if (block && typeof block.text === 'string') parts.push(block.text);
        }
        const txt = parts.join('\n\n').trim();
        if (txt) title = txt.slice(0, 80);
      }
    }
    if (cwd && title) break;
  }

  if (sessionId === null) {
    const m = path.basename(filePath, '.jsonl').match(/[0-9a-fA-F-]{36}/);
    sessionId = m ? m[0] : path.basename(filePath, '.jsonl');
  }
  if (!cwd) return null;

  const mtime = fileMtimeMs(filePath);
  return {
    source: 'codex',
    sessionId,
    cwd,
    title,
    gitBranch,
    createdAt,
    updatedAt: isoFromMs(mtime),
    updatedAtMs: mtime,
    filePath,
    version,
    model,
  };
}

// --------------------------------------------------------------------------
// discovery (stat-first, parse-lazily)
// --------------------------------------------------------------------------

// Build the candidate list cheaply: just (filePath, source, mtime, parser).
function collectCandidates() {
  const candidates = [];
  const projectsRoot = claudeProjectsDir();
  for (const filePath of walkJsonl(projectsRoot)) {
    if (!isTopLevelClaudeSession(filePath, projectsRoot)) continue;
    candidates.push({ filePath, source: 'claude', mtime: fileMtimeMs(filePath), parse: claudeSessionMeta });
  }

  const codexRoot = codexHome();
  for (const sub of ['sessions', 'archived_sessions']) {
    const subRoot = path.join(codexRoot, sub);
    for (const filePath of walkJsonl(subRoot, (n) => n.startsWith('rollout-'))) {
      candidates.push({
        filePath,
        source: 'codex',
        mtime: fileMtimeMs(filePath),
        parse: codexSessionMeta,
        archived: sub === 'archived_sessions',
      });
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates;
}

/**
 * Discover sessions sorted by most-recent-use (file mtime), newest first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]  Only parse metadata for the newest `limit` files
 *                               (the rest are skipped entirely). Omit/Infinity for all.
 * @param {Set<string>} [opts.worktrees]  If given, only sessions whose cwd is in
 *                               this set are returned (the optional --here filter).
 * @returns {Array<object>} session metadata objects.
 */
export function discoverSessions(opts = {}) {
  const { limit = Infinity, worktrees = null } = opts;
  const candidates = collectCandidates();
  const labels = loadLabels();
  const results = [];

  for (const cand of candidates) {
    if (results.length >= limit) break;
    const meta = cand.parse(cand.filePath);
    if (!meta) continue;
    if (worktrees && !worktrees.has(path.resolve(meta.cwd))) continue;
    if (cand.archived) meta.archived = true;
    // Apply resession's own custom name, if any (never touches the original file).
    const custom = labels[meta.sessionId];
    if (custom) {
      meta.title = custom;
      meta.renamed = true;
    }
    results.push(meta);
  }
  return results;
}
