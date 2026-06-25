// resession-server — a thin sync server for cross-device session viewing.
//
// It does NOT understand JSONL internals. Clients (the resession CLI) parse
// sessions locally and push: metadata (already extracted) + the raw JSONL +
// a content hash. The server stores metadata in SQLite and the JSONL on disk,
// and answers list / fetch / diff queries. Auth is a single shared bearer token
// over HTTPS (terminated by the reverse proxy).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from './store.js';
import { DeviceAuth, activationPage } from './device.js';

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || '/data';
const TOKEN = process.env.RESESSION_TOKEN || '';
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 256 * 1024 * 1024); // 256MB default

if (!TOKEN) {
  process.stderr.write('FATAL: RESESSION_TOKEN env var is required\n');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// --------------------------------------------------------------------------
// storage
// --------------------------------------------------------------------------

const store = await createStore(DATA_DIR);
const deviceAuth = new DeviceAuth(DATA_DIR);

// File path for a session's JSONL. Components are sanitized to stay inside DATA_DIR.
function jsonlPath(deviceId, source, sessionId) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = path.join(DATA_DIR, safe(deviceId), safe(source));
  return { dir, file: path.join(dir, safe(sessionId) + '.jsonl') };
}

// --------------------------------------------------------------------------
// http helpers
// --------------------------------------------------------------------------

function send(res, code, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

// Build the externally-visible base URL so the verification link points at the
// public domain (behind Cloudflare Tunnel / Traefik), not the internal host:port.
function publicBase(req) {
  const envBase = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (envBase) return envBase;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = (req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

function authed(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const presented = m[1];
  // Accept the shared master token (constant-time) ...
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  // ... or any per-device token minted via the browser approval flow.
  return deviceAuth.isValidToken(presented);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        const e = new Error('body too large');
        e.code = 'E_TOO_LARGE';
        reject(e);
        // Drain without buffering so the client can still read our 413 response,
        // instead of getting an ECONNRESET from an abrupt socket destroy.
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// --------------------------------------------------------------------------
// routes
// --------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    // health (no auth)
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return send(res, 200, { ok: true });
    }

    // ---- device authorization flow (no auth; this is how you GET a token) ----

    // CLI requests a device + user code.
    if (req.method === 'POST' && url.pathname === '/device/code') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const out = deviceAuth.requestCode(body.deviceName);
      const base = publicBase(req);
      out.verification_uri = `${base}/activate?code=${out.user_code}`;
      return send(res, 200, out);
    }

    // Browser opens the approval page.
    if (req.method === 'GET' && url.pathname === '/activate') {
      const code = url.searchParams.get('code') || '';
      const found = deviceAuth.lookupByUserCode(code);
      const html = found
        ? activationPage(found.userCode, found.deviceName, found.approved ? 'approved' : 'pending')
        : activationPage(code, '', 'notfound');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // Browser clicked "Authorize".
    if (req.method === 'POST' && url.pathname === '/device/approve') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return send(res, 200, deviceAuth.approve(body.user_code));
    }

    // CLI polls for the minted token.
    if (req.method === 'POST' && url.pathname === '/device/token') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return send(res, 200, deviceAuth.poll(body.device_code));
    }

    if (!authed(req)) return send(res, 401, { error: 'unauthorized' });

    // GET /sessions  -> all metadata (optional ?device=&source=&since=)
    if (req.method === 'GET' && url.pathname === '/sessions') {
      const device = url.searchParams.get('device');
      const source = url.searchParams.get('source');
      const since = url.searchParams.get('since');
      let rows = store.all();
      if (device) rows = rows.filter((r) => r.deviceId === device);
      if (source) rows = rows.filter((r) => r.source === source);
      if (since) rows = rows.filter((r) => (r.updatedAt || '') > since);
      return send(res, 200, { count: rows.length, sessions: rows });
    }

    // POST /sync/diff  -> body {entries:{key:hash}} ; key = deviceId/source/sessionId
    // returns which keys the server is missing or has a different hash for.
    if (req.method === 'POST' && url.pathname === '/sync/diff') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const local = body.entries || {};
      const serverHashes = new Map(
        store.all().map((r) => [`${r.deviceId}/${r.source}/${r.sessionId}`, r.contentHash])
      );
      const needUpload = []; // server missing or stale -> client should PUT
      for (const [key, hash] of Object.entries(local)) {
        if (serverHashes.get(key) !== hash) needUpload.push(key);
      }
      return send(res, 200, { needUpload });
    }

    // /sessions/:deviceId/:source/:sessionId
    if (parts[0] === 'sessions' && parts.length === 4) {
      const [, deviceId, source, sessionId] = parts.map(decodeURIComponent);

      if (req.method === 'GET') {
        const { file } = jsonlPath(deviceId, source, sessionId);
        if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return fs.createReadStream(file).pipe(res);
      }

      if (req.method === 'PUT') {
        // All x-* meta values are URL-encoded by the client; decode uniformly.
        const dec = (h) => {
          const v = req.headers[h];
          if (!v) return null;
          try { return decodeURIComponent(v); } catch { return v; }
        };
        const meta = {
          deviceId,
          source,
          sessionId,
          cwd: dec('x-cwd'),
          title: dec('x-title'),
          gitBranch: dec('x-git-branch'),
          createdAt: dec('x-created-at'),
          updatedAt: dec('x-updated-at'),
          version: dec('x-version'),
          model: dec('x-model'),
          contentHash: req.headers['x-content-hash'] || null,
        };
        // Skip if unchanged.
        const existing = store.get(deviceId, source, sessionId);
        if (existing && existing.contentHash && existing.contentHash === meta.contentHash) {
          return send(res, 204, '');
        }
        const buf = await readBody(req);
        const { dir, file } = jsonlPath(deviceId, source, sessionId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, buf);
        store.upsert({
          ...meta,
          bytes: buf.length,
          uploadedAt: new Date().toISOString(),
        });
        return send(res, 200, { ok: true });
      }
    }

    return send(res, 404, { error: 'no such route' });
  } catch (err) {
    if (err && err.code === 'E_TOO_LARGE') {
      return send(res, 413, { error: 'session too large' });
    }
    return send(res, 500, { error: String((err && err.message) || err) });
  }
});

server.listen(PORT, () => {
  process.stdout.write(`resession-server listening on :${PORT} (data: ${DATA_DIR})\n`);
});
