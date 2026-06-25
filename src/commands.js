// Cross-device subcommands (login / logout / push / pull). Additive: these are
// only invoked by their explicit verbs; the local-only flows never call them.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { discoverSessions } from './discover.js';
import {
  loadConfig, saveConfig, defaultDeviceId,
  loadRemoteCache, saveRemoteCache,
  ping, listRemote, diff, putSession,
  requestDeviceCode, pollDeviceToken,
} from './remote.js';

// Best-effort "open this URL in the default browser" across platforms.
function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// `resession login <url> [token] [--device <name>]`
//   - with <token>: save it directly (manual / scripted path)
//   - without:     browser device-authorization flow
export async function cmdLogin(positional, opts) {
  const url = positional[1];
  const manualToken = positional[2];
  if (!url) {
    process.stderr.write('usage: resession login <url> [token] [--device <name>]\n');
    return 1;
  }
  const deviceId = (opts.device || defaultDeviceId()).replace(/[^A-Za-z0-9._-]/g, '-');
  const baseUrl = url.replace(/\/+$/, '');

  // Manual token path (unchanged behaviour).
  if (manualToken) {
    const cfg = { url: baseUrl, token: manualToken, deviceId };
    let ok = false;
    try { ok = await ping(cfg); } catch (err) {
      process.stderr.write(`resession: cannot reach ${baseUrl} (${err.message})\n`);
      return 1;
    }
    if (!ok) { process.stderr.write(`resession: ${baseUrl}/healthz did not return ok\n`); return 1; }
    saveConfig(cfg);
    process.stdout.write(`logged in to ${baseUrl} as device "${deviceId}"\n`);
    return 0;
  }

  // Browser device-authorization flow.
  let codeResp;
  try {
    codeResp = await requestDeviceCode(baseUrl, deviceId);
  } catch (err) {
    process.stderr.write(`resession: cannot reach ${baseUrl} (${err.message})\n`);
    return 1;
  }
  const verifyUrl = codeResp.verification_uri || `${baseUrl}/activate?code=${codeResp.user_code}`;
  const intervalMs = Math.max(1, codeResp.interval || 2) * 1000;
  const deadline = Date.now() + (codeResp.expires_in || 600) * 1000;

  process.stdout.write(
    `\nTo authorize this device, open:\n  ${verifyUrl}\n\n` +
    `Confirmation code: ${codeResp.user_code}\n\nWaiting for approval in your browser…\n`
  );
  openBrowser(verifyUrl);

  // Poll until approved / expired / timeout.
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let r;
    try { r = await pollDeviceToken(baseUrl, codeResp.device_code); } catch { continue; }
    if (r.status === 'approved' && r.token) {
      saveConfig({ url: baseUrl, token: r.token, deviceId });
      process.stdout.write(`\n✓ logged in to ${baseUrl} as device "${deviceId}"\n`);
      return 0;
    }
    if (r.status === 'expired') {
      process.stderr.write('\nresession: code expired, run `resession login` again\n');
      return 1;
    }
  }
  process.stderr.write('\nresession: timed out waiting for approval\n');
  return 1;
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
