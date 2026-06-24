// resession's own sidecar state: custom session names + a soft-delete trash.
//
// We never mutate the original Claude/Codex JSONL files. Renames live in a small
// labels.json keyed by sessionId; deletes move the file into a trash directory so
// they can be recovered.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function homeDir() {
  const raw = (process.env.RESESSION_HOME || '').trim();
  return raw ? path.resolve(raw) : path.join(os.homedir(), '.resession');
}

function labelsFile() {
  return path.join(homeDir(), 'labels.json');
}

function trashDir() {
  return path.join(homeDir(), 'trash');
}

export function loadLabels() {
  try {
    const data = JSON.parse(fs.readFileSync(labelsFile(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** Set (or clear, when name is falsy) the custom name for a session id. */
export function saveLabel(sessionId, name) {
  const labels = loadLabels();
  const trimmed = (name || '').trim();
  if (trimmed) labels[sessionId] = trimmed;
  else delete labels[sessionId];
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(labelsFile(), JSON.stringify(labels, null, 2) + '\n');
  return labels;
}

/**
 * Soft-delete a session: move its JSONL into the trash dir and append a manifest
 * line recording where it came from. Returns the trashed path.
 */
export function trashSession(session) {
  const dir = trashDir();
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(session.filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${stamp}__${session.source}__${base}`);

  try {
    fs.renameSync(session.filePath, dest);
  } catch (err) {
    // Cross-device rename (EXDEV) fallback: copy then unlink.
    if (err && err.code === 'EXDEV') {
      fs.copyFileSync(session.filePath, dest);
      fs.unlinkSync(session.filePath);
    } else {
      throw err;
    }
  }

  const entry = {
    deletedAt: new Date().toISOString(),
    source: session.source,
    sessionId: session.sessionId,
    originalPath: session.filePath,
    trashedPath: dest,
  };
  try {
    fs.appendFileSync(path.join(dir, 'manifest.jsonl'), JSON.stringify(entry) + '\n');
  } catch {
    // manifest is best-effort
  }
  return dest;
}
