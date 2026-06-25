// Pluggable storage for resession-server.
//
// Prefers SQLite (better-sqlite3) for the metadata index. If the native module
// isn't available (e.g. a dev box without build tools), it transparently falls
// back to a zero-dependency JSON-file index. JSONL blobs always live on disk;
// only the metadata index differs between backends.

import fs from 'node:fs';
import path from 'node:path';

export async function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const { default: Database } = await import('better-sqlite3');
    return new SqliteStore(Database, dataDir);
  } catch (err) {
    process.stderr.write(
      'resession-server: better-sqlite3 unavailable, using JSON index fallback ' +
        `(${(err && err.code) || err})\n`
    );
    return new JsonStore(dataDir);
  }
}

const COLUMNS = [
  'deviceId', 'source', 'sessionId', 'cwd', 'title', 'gitBranch',
  'createdAt', 'updatedAt', 'version', 'model', 'contentHash', 'bytes', 'uploadedAt',
];

class SqliteStore {
  constructor(Database, dataDir) {
    this.kind = 'sqlite';
    this.db = new Database(path.join(dataDir, 'index.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        deviceId TEXT NOT NULL, source TEXT NOT NULL, sessionId TEXT NOT NULL,
        cwd TEXT, title TEXT, gitBranch TEXT, createdAt TEXT, updatedAt TEXT,
        version TEXT, model TEXT, contentHash TEXT, bytes INTEGER, uploadedAt TEXT,
        PRIMARY KEY (deviceId, source, sessionId)
      );
      CREATE INDEX IF NOT EXISTS idx_updated ON sessions(updatedAt DESC);
    `);
    this._upsert = this.db.prepare(`
      INSERT INTO sessions (${COLUMNS.join(',')})
      VALUES (${COLUMNS.map((c) => '@' + c).join(',')})
      ON CONFLICT(deviceId, source, sessionId) DO UPDATE SET
        ${COLUMNS.filter((c) => !['deviceId', 'source', 'sessionId'].includes(c))
          .map((c) => `${c}=@${c}`)
          .join(', ')}
    `);
    this._getOne = this.db.prepare(
      'SELECT * FROM sessions WHERE deviceId=? AND source=? AND sessionId=?'
    );
    this._all = this.db.prepare('SELECT * FROM sessions ORDER BY updatedAt DESC');
  }
  upsert(row) {
    this._upsert.run(row);
  }
  get(deviceId, source, sessionId) {
    return this._getOne.get(deviceId, source, sessionId) || null;
  }
  all() {
    return this._all.all();
  }
}

class JsonStore {
  constructor(dataDir) {
    this.kind = 'json';
    this.file = path.join(dataDir, 'index.json');
    try {
      this.map = new Map(Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8'))));
    } catch {
      this.map = new Map();
    }
  }
  _key(d, s, i) {
    return `${d}/${s}/${i}`;
  }
  _flush() {
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 0));
  }
  upsert(row) {
    const clean = {};
    for (const c of COLUMNS) clean[c] = row[c] ?? null;
    this.map.set(this._key(row.deviceId, row.source, row.sessionId), clean);
    this._flush();
  }
  get(deviceId, source, sessionId) {
    return this.map.get(this._key(deviceId, source, sessionId)) || null;
  }
  all() {
    return [...this.map.values()].sort((a, b) =>
      (b.updatedAt || '') < (a.updatedAt || '') ? -1 : (b.updatedAt || '') > (a.updatedAt || '') ? 1 : 0
    );
  }
}
