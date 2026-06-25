// Remote sync client for resession. Purely additive: everything here is only
// reached after the user runs `resession login`. Without a config file, the CLI
// stays a local-only tool and never touches the network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';

function homeDir() {
  const raw = (process.env.RESESSION_HOME || '').trim();
  return raw ? path.resolve(raw) : path.join(os.homedir(), '.resession');
}

const configFile = () => path.join(homeDir(), 'config.json');
const remoteCacheFile = () => path.join(homeDir(), 'remote-cache.json');

export function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    return c && c.url && c.token ? c : null;
  } catch {
    return null;
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return cfg;
}

export function loadRemoteCache() {
  try {
    const c = JSON.parse(fs.readFileSync(remoteCacheFile(), 'utf8'));
    return Array.isArray(c.sessions) ? c : { sessions: [], fetchedAt: null };
  } catch {
    return { sessions: [], fetchedAt: null };
  }
}

export function saveRemoteCache(cache) {
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(remoteCacheFile(), JSON.stringify(cache, null, 0) + '\n');
}

export function defaultDeviceId() {
  return (os.hostname() || 'device').split('.')[0].replace(/[^A-Za-z0-9._-]/g, '-');
}

export function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

// --------------------------------------------------------------------------
// minimal HTTP(S) request helper
// --------------------------------------------------------------------------

function request(cfg, method, urlPath, { headers = {}, body = null } = {}) {
  const url = new URL(urlPath, cfg.url);
  const lib = url.protocol === 'https:' ? https : http;
  const opts = {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      ...headers,
    },
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(url, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks) })
      );
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function encode(v) {
  return v == null ? '' : encodeURIComponent(String(v));
}

// --------------------------------------------------------------------------
// API
// --------------------------------------------------------------------------

export async function ping(cfg) {
  const r = await request(cfg, 'GET', '/healthz');
  return r.status === 200;
}

export async function listRemote(cfg) {
  const r = await request(cfg, 'GET', '/sessions');
  if (r.status !== 200) throw new Error(`list failed: HTTP ${r.status}`);
  return JSON.parse(r.body.toString('utf8')).sessions || [];
}

export async function diff(cfg, entries) {
  const r = await request(cfg, 'POST', '/sync/diff', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
  if (r.status !== 200) throw new Error(`diff failed: HTTP ${r.status}`);
  return JSON.parse(r.body.toString('utf8')).needUpload || [];
}

export async function putSession(cfg, meta, contentHash, jsonlBuffer) {
  const url =
    `/sessions/${encode(meta.deviceId)}/${encode(meta.source)}/${encode(meta.sessionId)}`;
  const r = await request(cfg, 'PUT', url, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-hash': contentHash,
      'x-cwd': encode(meta.cwd),
      'x-title': encode(meta.title),
      'x-git-branch': encode(meta.gitBranch),
      'x-created-at': encode(meta.createdAt),
      'x-updated-at': encode(meta.updatedAt),
      'x-version': encode(meta.version),
      'x-model': encode(meta.model),
    },
    body: jsonlBuffer,
  });
  return r.status; // 200 uploaded, 204 skipped
}

export async function getSessionJsonl(cfg, deviceId, source, sessionId) {
  const url = `/sessions/${encode(deviceId)}/${encode(source)}/${encode(sessionId)}`;
  const r = await request(cfg, 'GET', url);
  if (r.status !== 200) throw new Error(`fetch failed: HTTP ${r.status}`);
  return r.body.toString('utf8');
}

// --------------------------------------------------------------------------
// device authorization flow (browser login)
// --------------------------------------------------------------------------

// These three talk to a server we don't have a token for yet, so they use a
// token-less base config (just the URL).
function urlCfg(baseUrl) {
  return { url: baseUrl.replace(/\/+$/, ''), token: '' };
}

export async function requestDeviceCode(baseUrl, deviceName) {
  const r = await request(urlCfg(baseUrl), 'POST', '/device/code', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceName }),
  });
  if (r.status !== 200) throw new Error(`device/code failed: HTTP ${r.status}`);
  return JSON.parse(r.body.toString('utf8'));
}

export async function pollDeviceToken(baseUrl, deviceCode) {
  const r = await request(urlCfg(baseUrl), 'POST', '/device/token', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  if (r.status !== 200) throw new Error(`device/token failed: HTTP ${r.status}`);
  return JSON.parse(r.body.toString('utf8')); // {status:'pending'|'approved'|'expired', token?}
}
