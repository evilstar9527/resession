// Presentation: relative-time, table rendering (for `ls`), and a zero-dependency
// raw-mode interactive picker with tabs, mouse-wheel scrolling, rename and delete.

import path from 'node:path';
import { saveLabel, trashSession } from './store.js';

// --------------------------------------------------------------------------
// formatting helpers
// --------------------------------------------------------------------------

export function relativeTime(iso, nowMs = Date.now()) {
  if (!iso) return '—';
  const then = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const sec = Math.max(0, Math.round((nowMs - then) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.round(mon / 12)}y ago`;
}

function projectName(cwd) {
  if (!cwd) return '?';
  return path.basename(cwd) || cwd;
}

// Display width that counts CJK / wide chars as 2 columns.
function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana..CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1fbff) // emoji / symbols
  ) {
    return 2;
  }
  return 1;
}

function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

function truncWidth(s, max) {
  if (max <= 0) return '';
  const str = String(s ?? '');
  if (strWidth(str) <= max) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function padWidth(s, width) {
  const str = String(s ?? '');
  const w = strWidth(str);
  return w >= width ? str : str + ' '.repeat(width - w);
}

// --------------------------------------------------------------------------
// non-interactive table (used by `ls` and the non-TTY fallback)
// --------------------------------------------------------------------------

export function formatRows(sessions, nowMs = Date.now()) {
  const cols = sessions.map((s) => ({
    time: relativeTime(s.updatedAt || s.createdAt, nowMs),
    agent: s.source,
    project: projectName(s.cwd),
    branch: s.gitBranch || '',
    title: (s.renamed ? '★ ' : '') + (s.title || '(untitled)').replace(/\s+/g, ' ').trim(),
  }));
  const w = (key, max) => Math.min(max, Math.max(0, ...cols.map((c) => strWidth(c[key]))));
  const timeW = w('time', 10);
  const agentW = w('agent', 6);
  const projW = w('project', 28);
  const branchW = w('branch', 22);
  return cols.map(
    (c) =>
      `${padWidth(c.time, timeW)}  ${padWidth(c.agent, agentW)}  ${padWidth(truncWidth(c.project, projW), projW)}  ` +
      `${padWidth(truncWidth(c.branch, branchW), branchW)}  ${truncWidth(c.title, 80)}`.trimEnd()
  );
}

export function renderTable(sessions, nowMs = Date.now()) {
  if (!sessions.length) return '(no sessions found)';
  const rows = formatRows(sessions, nowMs);
  const numW = String(sessions.length).length;
  return rows
    .map((r, i) => `${String(i + 1).padStart(numW)}. ${r}`)
    .join('\n');
}

// --------------------------------------------------------------------------
// interactive picker (raw mode, zero deps)
// --------------------------------------------------------------------------

const TABS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'claude', label: 'Claude', match: (s) => s.source === 'claude' },
  { key: 'codex', label: 'Codex', match: (s) => s.source === 'codex' },
];

// ANSI
const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ALT_ON = `${ESC}[?1049h`; // enter alternate screen (so we restore on exit)
const ALT_OFF = `${ESC}[?1049l`; // leave alternate screen, restoring prior content
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1000l${ESC}[?1006l`;
const HOME = `${ESC}[H`;
const CLEAR_EOL = `${ESC}[K`;
const CLEAR_BELOW = `${ESC}[J`;
const REVERSE = `${ESC}[7m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

function matchesQuery(session, term) {
  if (!term) return true;
  const hay = `${session.source} ${projectName(session.cwd)} ${session.gitBranch || ''} ${session.title || ''} ${session.cwd}`.toLowerCase();
  return term
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => hay.includes(tok));
}

export async function pickSession(initialSessions) {
  const out = process.stdout;
  const inp = process.stdin;

  const state = {
    sessions: initialSessions.slice(),
    tab: 0,
    query: '',
    mode: 'list', // 'list' | 'search' | 'rename' | 'confirm'
    sel: 0,
    top: 0,
    buffer: '', // edit buffer for rename
    status: '',
  };

  const filtered = () =>
    state.sessions.filter((s) => TABS[state.tab].match(s) && matchesQuery(s, state.query));

  const tabCount = (i) => state.sessions.filter((s) => TABS[i].match(s)).length;

  function clampSel(list) {
    if (list.length === 0) {
      state.sel = 0;
      state.top = 0;
      return;
    }
    state.sel = Math.max(0, Math.min(state.sel, list.length - 1));
  }

  function viewportHeight() {
    const rows = out.rows || 24;
    // header(3) + separator(1) + footer(2) reserved
    return Math.max(3, rows - 6);
  }

  function ensureVisible(list) {
    const vh = viewportHeight();
    if (state.sel < state.top) state.top = state.sel;
    if (state.sel >= state.top + vh) state.top = state.sel - vh + 1;
    state.top = Math.max(0, Math.min(state.top, Math.max(0, list.length - vh)));
  }

  function render() {
    const cols = out.columns || 80;
    const list = filtered();
    clampSel(list);
    ensureVisible(list);
    const vh = viewportHeight();
    const nowMs = Date.now();

    const lines = [];

    // header
    lines.push(`${BOLD}resession${RESET} ${DIM}— ${state.sessions.length} sessions${RESET}`);

    const tabBar = TABS.map((t, i) => {
      const label = `${t.label}(${tabCount(i)})`;
      return i === state.tab ? `${REVERSE} ${label} ${RESET}` : ` ${label} `;
    }).join(DIM + '│' + RESET);
    lines.push(tabBar);

    if (state.mode === 'search') {
      lines.push(`${DIM}search:${RESET} ${state.query}${REVERSE} ${RESET}`);
    } else if (state.query) {
      lines.push(`${DIM}filter: ${state.query}  (${list.length} match)${RESET}`);
    } else {
      lines.push(state.status ? `${DIM}${state.status}${RESET}` : '');
    }
    lines.push(`${DIM}${'─'.repeat(Math.min(cols, 80))}${RESET}`);

    // rows
    const rowStrs = formatRows(list, nowMs);
    if (list.length === 0) {
      lines.push(`${DIM}(no sessions)${RESET}`);
      for (let i = 1; i < vh; i++) lines.push('');
    } else {
      for (let i = 0; i < vh; i++) {
        const idx = state.top + i;
        if (idx >= list.length) {
          lines.push('');
          continue;
        }
        const text = truncWidth(rowStrs[idx], cols - 2);
        if (idx === state.sel && state.mode !== 'confirm') {
          lines.push(`${REVERSE} ${padWidth(text, cols - 2)}${RESET}`);
        } else {
          lines.push(` ${text}`);
        }
      }
    }

    // footer
    if (state.mode === 'rename') {
      lines.push(`${DIM}─${RESET}`);
      lines.push(`${BOLD}New name:${RESET} ${state.buffer}${REVERSE} ${RESET}  ${DIM}(Enter save · Esc cancel · empty=clear)${RESET}`);
    } else if (state.mode === 'confirm') {
      const cur = list[state.sel];
      const name = cur ? truncWidth(cur.title || '(untitled)', 50) : '';
      lines.push(`${DIM}─${RESET}`);
      lines.push(`${BOLD}Delete${RESET} “${name}” → trash? ${DIM}(y / N)${RESET}`);
    } else {
      lines.push(`${DIM}─${RESET}`);
      lines.push(
        `${DIM}↑↓/wheel move · ←→ tab · ⏎ resume · r rename · d delete · / search · Esc quit${RESET}`
      );
    }

    out.write(HOME + lines.map((l) => l + CLEAR_EOL).join('\n') + '\n' + CLEAR_BELOW);
  }

  return new Promise((resolve) => {
    let done = false;

    function cleanup() {
      if (done) return;
      done = true;
      clearEscTimer();
      inp.removeListener('data', onData);
      out.removeListener('resize', render);
      out.write(MOUSE_OFF + SHOW_CURSOR + ALT_OFF); // leaving alt screen restores prior terminal
      if (inp.isTTY) inp.setRawMode(false);
      inp.pause();
    }

    function finish(result) {
      cleanup();
      resolve(result);
    }

    function move(delta) {
      const list = filtered();
      if (!list.length) return;
      state.sel = Math.max(0, Math.min(state.sel + delta, list.length - 1));
    }

    function switchTab(delta) {
      state.tab = (state.tab + delta + TABS.length) % TABS.length;
      state.sel = 0;
      state.top = 0;
      state.status = '';
    }

    function commitRename() {
      const list = filtered();
      const cur = list[state.sel];
      if (cur) {
        saveLabel(cur.sessionId, state.buffer);
        const name = state.buffer.trim();
        cur.title = name || stripStar(cur);
        cur.renamed = !!name;
        state.status = name ? 'renamed' : 'name cleared';
      }
      state.mode = 'list';
      state.buffer = '';
    }

    function stripStar(cur) {
      return cur.title || '(untitled)';
    }

    function doDelete() {
      const list = filtered();
      const cur = list[state.sel];
      state.mode = 'list';
      if (!cur) return;
      try {
        trashSession(cur);
        saveLabel(cur.sessionId, ''); // tidy any label
        const i = state.sessions.indexOf(cur);
        if (i >= 0) state.sessions.splice(i, 1);
        state.status = 'moved to trash (~/.resession/trash)';
      } catch (err) {
        state.status = 'delete failed: ' + (err && err.message ? err.message : err);
      }
    }

    // --- input handling -----------------------------------------------------
    // A lone ESC byte is ambiguous: it may be the user pressing Esc, OR the first
    // byte of an arrow/mouse sequence that the terminal delivered in a separate
    // chunk. We debounce: hold a solo ESC briefly; if more bytes arrive they get
    // prepended to the next chunk, otherwise it's treated as a real Esc press.
    let pendingEsc = '';
    let escTimer = null;

    function clearEscTimer() {
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = null;
      }
    }

    function onData(buf) {
      let s = buf.toString('utf8');
      if (pendingEsc) {
        s = pendingEsc + s;
        pendingEsc = '';
        clearEscTimer();
      }
      // Solo ESC: wait to see if a sequence completes.
      if (s === ESC) {
        pendingEsc = ESC;
        escTimer = setTimeout(() => {
          pendingEsc = '';
          escTimer = null;
          handleKey(ESC); // nothing followed -> a genuine Esc
        }, 40);
        if (escTimer.unref) escTimer.unref();
        return;
      }
      handleKey(s);
    }

    function handleKey(s) {
      if (done) return;
      if (s === '\x03') { finish(null); return; } // Ctrl-C always quits

      // mouse wheel (SGR): ESC [ < code ; x ; y (M|m)
      const mouse = s.match(/\x1b\[<(\d+);\d+;\d+[Mm]/);
      if (mouse) {
        const code = Number(mouse[1]);
        if (code === 64) move(-3);
        else if (code === 65) move(3);
        render();
        return;
      }

      if (state.mode === 'rename' || state.mode === 'search') {
        const editing = state.mode === 'rename' ? 'buffer' : 'query';
        if (s === '\r' || s === '\n') {
          if (state.mode === 'rename') commitRename();
          else { // search: Enter resumes the selected match
            const cur = filtered()[state.sel];
            if (cur) { finish(cur); return; }
            state.mode = 'list';
          }
        } else if (s === ESC) {
          if (state.mode === 'search') { state.query = ''; }
          state.mode = 'list';
          state.buffer = '';
        } else if (s === '\x7f' || s === '\b') {
          state[editing] = Array.from(state[editing]).slice(0, -1).join('');
          if (state.mode === 'search') state.sel = 0;
        } else if (s === '\x1b[A') { move(-1); }
        else if (s === '\x1b[B') { move(1); }
        else if (!s.startsWith(ESC) && s >= ' ') {
          state[editing] += s;
          if (state.mode === 'search') state.sel = 0;
        }
        render();
        return;
      }

      if (state.mode === 'confirm') {
        if (s === 'y' || s === 'Y') doDelete();
        else state.mode = 'list';
        render();
        return;
      }

      // list mode
      switch (s) {
        case ESC:
        case 'q':
          finish(null);
          return;
        case '\r':
        case '\n': {
          const cur = filtered()[state.sel];
          if (cur) { finish(cur); return; }
          break;
        }
        case '\x1b[A':
        case 'k':
          move(-1);
          break;
        case '\x1b[B':
        case 'j':
          move(1);
          break;
        case '\x1b[C':
        case 'l':
          switchTab(1);
          break;
        case '\x1b[D':
        case 'h':
          switchTab(-1);
          break;
        case '\x1b[5~': // PageUp
          move(-viewportHeight());
          break;
        case '\x1b[6~': // PageDown
          move(viewportHeight());
          break;
        case 'g':
          state.sel = 0;
          break;
        case 'G':
          state.sel = filtered().length - 1;
          break;
        case '/':
          state.mode = 'search';
          state.status = '';
          break;
        case 'r': {
          const cur = filtered()[state.sel];
          if (cur) {
            state.mode = 'rename';
            state.buffer = cur.title && cur.renamed ? cur.title : '';
          }
          break;
        }
        case 'd':
          if (filtered()[state.sel]) state.mode = 'confirm';
          break;
        default:
          break;
      }
      render();
    }

    if (inp.isTTY) inp.setRawMode(true);
    inp.resume();
    inp.on('data', onData);
    out.on('resize', render);
    out.write(ALT_ON + HIDE_CURSOR + MOUSE_ON);
    render();
  });
}
