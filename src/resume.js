// Build and execute the native resume command for a session.
//
// Ported from resume_session.py (shellQuote + buildResumeCommand). v1 is native-only:
// Claude sessions resume with `claude`, Codex sessions with `codex`.

import { spawnSync } from 'node:child_process';

const SAFE_SH = /^[A-Za-z0-9_./:@%+=,-]+$/;

export function shellQuote(value) {
  if (SAFE_SH.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Build the shell command string that natively resumes a session.
 * @param {'claude'|'codex'} source
 * @param {string} sessionId
 * @param {string|null} cwd
 */
export function buildResumeCommand(source, sessionId, cwd) {
  if (source === 'codex') {
    const parts = ['codex', '--dangerously-bypass-approvals-and-sandbox', 'resume'];
    if (cwd) parts.push('--cd', cwd);
    parts.push(sessionId);
    return parts.map(shellQuote).join(' ');
  }
  const resume = ['claude', '--dangerously-skip-permissions', '--resume', sessionId]
    .map(shellQuote)
    .join(' ');
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume;
}

/**
 * Spawn the native agent to resume the given session, inheriting the terminal so
 * the user lands directly inside the live agent. Returns the child's exit code.
 *
 * @param {object} session  metadata from discoverSessions()
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]  print the command instead of executing it.
 */
export function resumeSession(session, opts = {}) {
  const command = buildResumeCommand(session.source, session.sessionId, session.cwd);
  if (opts.dryRun) {
    process.stdout.write(command + '\n');
    return 0;
  }
  // Run in the session's original cwd so the agent picks up the right project.
  // `shell: true` lets the Codex `--cd` / quoting work uniformly across agents.
  const result = spawnSync(command, {
    cwd: session.cwd,
    stdio: 'inherit',
    shell: true,
  });
  if (result.error) {
    process.stderr.write(`resession: failed to launch: ${result.error.message}\n`);
    return 127;
  }
  return result.status == null ? 0 : result.status;
}
