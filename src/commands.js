// Cross-device subcommands (login / logout / push / pull). Additive: these are
// only invoked by their explicit verbs; the local-only flows never call them.

import fs from 'node:fs';
import crypto from 'node:crypto';

import { discoverSessions } from './discover.js';
import {
  loadConfig, saveConfig, defaultDeviceId,
  loadRemoteCache, saveRemoteCache,
  ping, listRemote, diff, putSession,
} from './remote.js';

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg) {
    process.stderr.write('resession: not logged in. Run: resession login <url> <token>\n');
    return null;
  }
  return cfg;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// `resession login <url> <token> [--device <name>]`
export async function cmdLogin(positional, opts) {
  const url = positional[1];
  const token = positional[2];
  if (!url || !token) {
    process.stderr.write('usage: resession login <url> <token> [--device <name>]\n');
    return 1;
  }
  const cfg = {
    url: url.replace(/\/+$/, ''),
    token,
    deviceId: (opts.device || defaultDeviceId()).replace(/[^A-Za-z0-9._-]/g, '-'),
  };
  let ok = false;
  try {
    ok = await ping(cfg);
  } catch (err) {
    process.stderr.write(`resession: cannot reach ${cfg.url} (${err.message})\n`);
    return 1;
  }
  if (!ok) {
    process.stderr.write(`resession: ${cfg.url}/healthz did not return ok\n`);
    return 1;
  }
  saveConfig(cfg);
  process.stdout.write(`logged in to ${cfg.url} as device "${cfg.deviceId}"\n`);
  return 0;
}

export async function cmdLogout() {
  const cfg = loadConfig();
  if (cfg) saveConfig({ ...cfg, url: '', token: '' }); // clear creds, keep file harmless
  process.stdout.write('logged out\n');
  return 0;
}

// `resession push` — upload local sessions the server is missing or has stale.
export async function cmdPush() {
  const cfg = requireConfig();
  if (!cfg) return 1;

  const sessions = discoverSessions({ limit: Infinity });
  // Build local hash map keyed by deviceId/source/sessionId.
  const byKey = new Map();
  const entries = {};
  for (const s of sessions) {
    let buf;
    try {
      buf = fs.readFileSync(s.filePath);
    } catch {
      continue; // file vanished mid-scan
    }
    const hash = sha256(buf);
    const key = `${cfg.deviceId}/${s.source}/${s.sessionId}`;
    entries[key] = hash;
    byKey.set(key, { meta: s, hash, buf });
  }

  let need;
  try {
    need = await diff(cfg, entries);
  } catch (err) {
    process.stderr.write(`resession: ${err.message}\n`);
    return 1;
  }

  let uploaded = 0;
  let oversized = 0;
  for (const key of need) {
    const item = byKey.get(key);
    if (!item) continue;
    const meta = { ...item.meta, deviceId: cfg.deviceId };
    try {
      const status = await putSession(cfg, meta, item.hash, item.buf);
      if (status === 200) uploaded += 1;
      else if (status === 413) {
        oversized += 1;
        const mb = (item.buf.length / 1048576).toFixed(0);
        process.stderr.write(`  skipped ${key} — too large (${mb}MB)\n`);
      }
    } catch (err) {
      process.stderr.write(`  failed ${key}: ${err.message}\n`);
    }
  }
  const skipped = Object.keys(entries).length - uploaded - oversized;
  let msg = `pushed ${uploaded}, skipped ${skipped} (already up to date)`;
  if (oversized) msg += `, ${oversized} too large`;
  process.stdout.write(msg + '\n');
  return 0;
}

// `resession pull` — refresh the cached list of remote sessions (metadata only).
export async function cmdPull() {
  const cfg = requireConfig();
  if (!cfg) return 1;
  let remote;
  try {
    remote = await listRemote(cfg);
  } catch (err) {
    process.stderr.write(`resession: ${err.message}\n`);
    return 1;
  }
  saveRemoteCache({ sessions: remote, fetchedAt: new Date().toISOString() });
  const devices = new Set(remote.map((s) => s.deviceId));
  process.stdout.write(
    `pulled ${remote.length} sessions from ${devices.size} device(s): ${[...devices].join(', ')}\n`
  );
  return 0;
}
