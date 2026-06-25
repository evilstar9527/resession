// Device authorization flow (no password, click-to-approve).
//
//   CLI ── POST /device/code ──▶ server returns {device_code, user_code, verification_uri}
//   user open verification_uri in browser, clicks "Authorize"
//   browser ── POST /device/approve {user_code} ──▶ server mints a device token
//   CLI ── POST /device/token {device_code} (polling) ──▶ server returns the token
//
// Device tokens are persisted so they survive restarts; pending requests are
// in-memory only (short-lived).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes to approve

// Ambiguous chars removed (no 0/O/1/I) for easy reading aloud / typing.
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomUserCode() {
  const pick = () => USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)];
  return Array.from({ length: 4 }, pick).join('') + '-' + Array.from({ length: 4 }, pick).join('');
}

export class DeviceAuth {
  constructor(dataDir) {
    this.tokensFile = path.join(dataDir, 'device-tokens.json');
    this.pending = new Map(); // device_code -> { userCode, deviceName, createdAt, token? }
    this.byUserCode = new Map(); // user_code -> device_code
    this.tokens = this._loadTokens(); // Map token -> { deviceId, createdAt }
  }

  _loadTokens() {
    try {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(this.tokensFile, 'utf8'))));
    } catch {
      return new Map();
    }
  }

  _saveTokens() {
    try {
      fs.writeFileSync(this.tokensFile, JSON.stringify(Object.fromEntries(this.tokens), null, 0));
    } catch {
      /* best effort */
    }
  }

  _gc() {
    const now = Date.now();
    for (const [dc, p] of this.pending) {
      if (now - p.createdAt > PENDING_TTL_MS) {
        this.pending.delete(dc);
        this.byUserCode.delete(p.userCode);
      }
    }
  }

  isValidToken(token) {
    return this.tokens.has(token);
  }

  // POST /device/code
  requestCode(deviceName) {
    this._gc();
    const deviceCode = crypto.randomBytes(24).toString('hex');
    let userCode = randomUserCode();
    while (this.byUserCode.has(userCode)) userCode = randomUserCode();
    const entry = { userCode, deviceName: deviceName || 'unknown device', createdAt: Date.now(), token: null };
    this.pending.set(deviceCode, entry);
    this.byUserCode.set(userCode, deviceCode);
    return { device_code: deviceCode, user_code: userCode, interval: 2, expires_in: PENDING_TTL_MS / 1000 };
  }

  // Look up a pending request by its user code (for the approval page).
  lookupByUserCode(userCode) {
    this._gc();
    const dc = this.byUserCode.get((userCode || '').toUpperCase().trim());
    if (!dc) return null;
    const p = this.pending.get(dc);
    return p ? { userCode: p.userCode, deviceName: p.deviceName, approved: !!p.token } : null;
  }

  // POST /device/approve {user_code} — browser clicked Authorize.
  approve(userCode) {
    this._gc();
    const dc = this.byUserCode.get((userCode || '').toUpperCase().trim());
    if (!dc) return { ok: false, error: 'unknown or expired code' };
    const p = this.pending.get(dc);
    if (!p) return { ok: false, error: 'expired' };
    if (!p.token) {
      const token = 'rsd_' + crypto.randomBytes(24).toString('hex');
      p.token = token;
      this.tokens.set(token, { deviceId: p.deviceName, createdAt: Date.now() });
      this._saveTokens();
    }
    return { ok: true, deviceName: p.deviceName };
  }

  // POST /device/token {device_code} — CLI polling.
  poll(deviceCode) {
    this._gc();
    const p = this.pending.get(deviceCode);
    if (!p) return { status: 'expired' };
    if (!p.token) return { status: 'pending' };
    const token = p.token;
    // One-shot: consume the pending entry once the token is handed out.
    this.pending.delete(deviceCode);
    this.byUserCode.delete(p.userCode);
    return { status: 'approved', token, deviceId: p.deviceName };
  }
}

// Minimal approval page (no framework, no external assets).
export function activationPage(userCode, deviceName, state) {
  const safe = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const codeAttr = safe(userCode);
  const dev = safe(deviceName);

  if (state === 'approved') {
    return page(`<h1>✓ Device authorized</h1>
      <p><b>${dev}</b> can now sync. You can close this tab and return to your terminal.</p>`);
  }
  if (state === 'notfound') {
    return page(`<h1>Code not found</h1>
      <p>This authorization code is unknown or has expired. Run <code>resession login</code> again.</p>`);
  }
  return page(`<h1>Authorize this device?</h1>
    <p class="dev">${dev}</p>
    <p class="code">Code: <b>${codeAttr}</b></p>
    <button id="go">Authorize</button>
    <p id="msg" class="msg"></p>
    <script>
      document.getElementById('go').onclick = async () => {
        const m = document.getElementById('msg');
        m.textContent = 'Authorizing…';
        try {
          const r = await fetch('/device/approve', {
            method: 'POST', headers: {'content-type':'application/json'},
            body: JSON.stringify({ user_code: ${JSON.stringify(userCode)} })
          });
          const j = await r.json();
          if (j.ok) { document.body.innerHTML = '<div class="card"><h1>✓ Authorized</h1><p>You can close this tab and return to your terminal.</p></div>'; }
          else { m.textContent = 'Failed: ' + (j.error || 'unknown'); }
        } catch (e) { m.textContent = 'Error: ' + e.message; }
      };
    </script>`);
}

function page(inner) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>resession</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#1a1d24;border:1px solid #2a2f3a;border-radius:14px;padding:32px 36px;max-width:420px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.4)}
  h1{font-size:20px;margin:0 0 12px}
  .dev{font-size:15px;color:#9aa4b2;margin:4px 0}
  .code{font-size:15px;letter-spacing:1px;margin:8px 0 20px}
  .code b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;color:#7aa2f7}
  button{background:#3b82f6;color:#fff;border:0;border-radius:9px;padding:11px 26px;font-size:15px;cursor:pointer}
  button:hover{background:#2f6fe0}
  .msg{margin-top:14px;color:#9aa4b2;font-size:13px;min-height:18px}
  code{background:#0f1115;padding:2px 6px;border-radius:5px}
</style></head><body><div class="card">${inner}</div></body></html>`;
}
