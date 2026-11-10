// Finds Claude data that can be cleaned (caches, old versions, Cowork, temp files, old
// conversations) and removes the items the page picks. Nothing is removed by a scan.
//
// Safety: the page can only name items from the latest scan (by id); every path is re-checked to
// sit inside a known Claude folder, and locks (app still running, used in the last 30 minutes,
// current version) are checked again right before removing.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const HOME = os.homedir();
const MAC = process.platform === 'darwin';
const IN_USE_MS = 30 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const PROJECTS = path.join(CLAUDE_HOME, 'projects');
const FILE_HISTORY = path.join(CLAUDE_HOME, 'file-history');
const CLI_DIR = path.join(HOME, '.local', 'share', 'claude');
const INSTANCES = path.join(HOME, '.claude-instances');

export const CATEGORIES = [
  { id: 'images', label: 'Pasted images & screenshots', desc: 'Images pasted into Claude Code and screenshots it took, kept per session in the temp folder.' },
  { id: 'temp', label: 'Scratchpads & task output', desc: 'Per-session temp files: scratchpad files and background task logs.' },
  { id: 'transcripts', label: 'Claude Code conversations', desc: "Conversation history. A deleted conversation can't be resumed." },
  { id: 'checkpoints', label: 'Edit checkpoints', desc: 'File snapshots that let a conversation rewind its edits.' },
  { id: 'scratch', label: 'Leftover app folders', desc: 'Folders a Claude app made for sessions that no longer exist.' },
  { id: 'cache', label: 'Caches', desc: 'Web, GPU and download caches and crash dumps. They rebuild themselves.' },
  { id: 'versions', label: 'Old Claude Code versions', desc: 'Earlier Claude Code builds. The current one is always kept.' },
  { id: 'cowork', label: 'Cowork', desc: "Cowork's virtual machine, its Claude Code and Cowork sessions. Downloaded again if you use Cowork." },
  { id: 'logs', label: 'Logs & diagnostics', desc: 'Debug logs, telemetry queue, old shell snapshots and crash reports.' },
];

// Categories whose files the app holds open while it runs.
const NEEDS_APP_CLOSED = new Set(['cache', 'cowork']);
// Categories a live Claude Code session may still be writing to.
const IN_USE_CHECK = new Set(['images', 'temp', 'transcripts', 'checkpoints', 'scratch']);

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const tilde = (p) => (p.startsWith(HOME + path.sep) ? `~${p.slice(HOME.length)}` : p);
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const dirents = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };
const subdirs = (p) => dirents(p).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
const verCmp = (a, b) => {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

function tempRoot() {
  if (process.platform === 'win32') return null;
  const p = path.join('/tmp', `claude-${process.getuid()}`);
  try { return fs.realpathSync(p); } catch { return null; }
}

// ---- Claude desktop apps ----
// The normal app plus extra copies started with --user-data-dir (e.g. ~/.claude-instances/<name>).
function desktopApps() {
  const apps = [];
  const def = MAC ? path.join(HOME, 'Library', 'Application Support', 'Claude')
    : process.platform === 'win32' ? path.join(process.env.APPDATA || HOME, 'Claude')
      : path.join(HOME, '.config', 'Claude');
  if (exists(path.join(def, 'config.json'))) apps.push({ id: 'app:default', name: 'Claude', dir: def, isDefault: true });

  // Launch scripts like launch-khub.sh name their copy: NAME="Claude - KHUB", DATA="$HOME/.claude-instances/work".
  const names = new Map();
  for (const d of dirents(INSTANCES)) {
    if (!d.isFile() || !d.name.endsWith('.sh')) continue;
    const text = fs.readFileSync(path.join(INSTANCES, d.name), 'utf8');
    const name = text.match(/^NAME="([^"]+)"/m)?.[1];
    const data = text.match(/^DATA="([^"]+)"/m)?.[1]?.replace(/^\$HOME|^~/, HOME);
    if (name && data) names.set(path.resolve(data), name);
  }
  for (const dir of subdirs(INSTANCES)) {
    if (!exists(path.join(dir, 'config.json'))) continue;
    apps.push({ id: `app:${path.basename(dir)}`, name: names.get(dir) || `Claude (${path.basename(dir)})`, dir });
  }
  return apps;
}

async function processes() {
  if (process.platform === 'win32') return [];
  try {
    const { stdout } = await execFileP('ps', ['-Ao', 'command='], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// Which app data folders have their app running right now (main process only, not helpers).
function runningAppDirs(apps, procs) {
  const dirs = new Set();
  for (const cmd of procs) {
    if (!/\/Contents\/MacOS\/Claude(\s|$)/.test(cmd)) continue;
    const custom = cmd.match(/--user-data-dir=(.+?)(?=\s--|$)/)?.[1];
    if (custom) dirs.add(path.resolve(custom.replace(/^["']|["']$/g, '')));
    else dirs.add(apps.find((a) => a.isDefault)?.dir);
  }
  return dirs;
}

// Desktop-app sessions, keyed by every Claude Code session id they point at.
function appSessions(apps) {
  const byCli = new Map();
  const cwds = new Map(); // app dir -> Set of session folders
  for (const app of apps) {
    const set = new Set();
    cwds.set(app.dir, set);
    for (const acct of subdirs(path.join(app.dir, 'claude-code-sessions'))) {
      for (const org of subdirs(acct)) {
        for (const d of dirents(org)) {
          if (!d.isFile() || !/^local_.*\.json$/.test(d.name)) continue;
          const s = readJson(path.join(org, d.name));
          if (!s) continue;
          for (const c of [s.cwd, s.originCwd]) if (c) set.add(c);
          const ref = { app: app.name, title: s.title || null, archived: !!s.isArchived };
          for (const id of [s.cliSessionId, s.lastAssistantCliSessionId, ...(s.priorCliSessionIds || [])]) {
            if (typeof id === 'string') byCli.set(id, ref);
          }
        }
      }
    }
  }
  return { byCli, cwds };
}

// ---- Sizes ----
// Allocated size like `du` (APFS clones and sparse files count what they really use). Doesn't follow links.
async function sizeOf(p) {
  let st;
  try { st = await fsp.lstat(p); } catch { return { size: 0, files: 0, mtime: 0 }; }
  const own = st.blocks != null ? st.blocks * 512 : st.size;
  if (!st.isDirectory()) return { size: own, files: 1, mtime: st.mtimeMs };
  const out = { size: own, files: 0, mtime: st.mtimeMs };
  let entries;
  try { entries = await fsp.readdir(p); } catch { return out; }
  for (let i = 0; i < entries.length; i += 64) {
    const parts = await Promise.all(entries.slice(i, i + 64).map((e) => sizeOf(path.join(p, e))));
    for (const r of parts) { out.size += r.size; out.files += r.files; if (r.mtime > out.mtime) out.mtime = r.mtime; }
  }
  return out;
}

async function measure(paths) {
  const out = { size: 0, files: 0, mtime: 0 };
  for (const p of paths) {
    const r = await sizeOf(p);
    out.size += r.size; out.files += r.files; if (r.mtime > out.mtime) out.mtime = r.mtime;
  }
  return out;
}

// ---- Conversations ----
// Reads the start and end of a transcript for its folder, title and last activity.
function readTranscriptMeta(file) {
  const meta = { cwd: null, title: null, firstPrompt: null, last: 0 };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const read = (pos, len) => {
      const buf = Buffer.alloc(Math.min(len, size - pos));
      fs.readSync(fd, buf, 0, buf.length, pos);
      return buf.toString('utf8');
    };
    const head = read(0, 256 * 1024);
    const tail = size > 256 * 1024 ? read(Math.max(0, size - 128 * 1024), 128 * 1024) : '';
    for (const [chunk, isTail] of [[head, false], [tail, true]]) {
      const lines = chunk.split('\n');
      for (const line of lines.slice(isTail ? 1 : 0)) {
        if (!line.startsWith('{')) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (!meta.cwd && o.cwd) meta.cwd = o.cwd;
        if (o.type === 'custom-title' && o.customTitle) meta.title = o.customTitle;
        else if (o.type === 'summary' && o.summary && !meta.title) meta.title = o.summary;
        if (o.timestamp) { const t = Date.parse(o.timestamp); if (t > meta.last) meta.last = t; }
        if (!meta.firstPrompt && o.type === 'user' && !o.isMeta && !o.isSidechain) {
          const c = o.message?.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x.type === 'text')?.text : null;
          if (text && !text.startsWith('<') && !text.startsWith('Caveat:')) meta.firstPrompt = text.replace(/\s+/g, ' ').trim().slice(0, 100);
        }
      }
    }
  } catch {
    // unreadable: leave defaults
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return meta;
}

function projectLabel(cwd) {
  if (!cwd) return null;
  if (cwd.includes(`${path.sep}scratch-workspaces${path.sep}`)) return 'App-made folder';
  return tilde(cwd);
}

// ---- Scan ----
let last = { items: new Map(), roots: [], prune: [] };
let busy = false;

function lockFor(item, ctx) {
  if (item.keep) return item.keep;
  if (NEEDS_APP_CLOSED.has(item.cat) && item.appDir && ctx.running.has(item.appDir)) return `Quit ${item.where} first`;
  if (item.procMatch && ctx.procs.some((c) => c.includes(item.procMatch))) return 'In use by a running Claude Code';
  if (IN_USE_CHECK.has(item.cat) && item.mtime > Date.now() - IN_USE_MS) return 'Used in the last 30 minutes';
  return null;
}

export async function scan() {
  if (busy) throw new Error('A scan or clean is already running.');
  busy = true;
  const started = Date.now();
  try {
    return await doScan(started);
  } finally {
    busy = false;
  }
}

async function doScan(started) {
  const procs = await processes();
  const apps = desktopApps();
  const running = runningAppDirs(apps, procs);
  const ctx = { procs, running };
  const { byCli, cwds } = appSessions(apps);
  const tmp = tempRoot();
  const items = [];

  async function add(cat, where, label, paths, extra = {}) {
    paths = paths.filter(exists);
    if (!paths.length) return;
    const m = await measure(paths);
    if (!m.size && !extra.keep) return;
    const item = {
      id: hash(`${cat}\0${paths.join('\0')}`),
      cat, where, label,
      sub: extra.sub ?? tilde(paths[0]),
      paths, size: m.size, files: m.files, mtime: extra.mtime || m.mtime,
      appDir: extra.appDir ?? null,
      procMatch: extra.procMatch ?? null,
      keep: extra.keep ?? null,
      flags: extra.flags ?? {},
    };
    item.mtime = Math.max(item.mtime, m.mtime);
    item.lock = lockFor(item, ctx);
    items.push(item);
  }

  // Conversations first: temp files and checkpoints borrow their titles.
  const convo = new Map(); // session id -> { title, project }
  for (const dir of subdirs(PROJECTS)) {
    for (const d of dirents(dir)) {
      if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
      const sid = d.name.slice(0, -6);
      const file = path.join(dir, d.name);
      const meta = readTranscriptMeta(file);
      const linked = byCli.get(sid);
      const title = linked?.title || meta.title || meta.firstPrompt || '(no messages)';
      const project = projectLabel(meta.cwd);
      convo.set(sid, { title, project });
      await add('transcripts', 'Claude Code', title, [file, path.join(dir, sid)], {
        sub: project || tilde(dir),
        mtime: meta.last,
        flags: {
          linked: linked?.app ?? null,
          archived: linked?.archived ?? false,
          orphan: meta.cwd ? !exists(meta.cwd) : false,
          sid,
        },
      });
    }
  }

  // Temp folder: <root>/<project>/<session id>/{images, scratchpad, tasks, …}
  if (tmp) {
    for (const projDir of subdirs(tmp)) {
      // Project folders are encoded paths (-Users-me-repo); others (e.g. bash-edit-diff) are tool scratch.
      const isProject = path.basename(projDir).startsWith('-');
      for (const sDir of subdirs(projDir)) {
        const sid = path.basename(sDir);
        const c = convo.get(sid);
        const label = c?.title || `${isProject ? 'Session' : path.basename(projDir)} ${sid.slice(0, 8)}`;
        const sub = c?.project || tilde(sDir);
        const flags = { sid, orphan: isProject && !c };
        const imgs = path.join(sDir, 'images');
        if (exists(imgs)) {
          const n = dirents(imgs).filter((e) => e.isFile()).length;
          await add('images', 'Temp files', label, [imgs], { sub, flags: { ...flags, images: n } });
        }
        const rest = dirents(sDir).filter((e) => e.name !== 'images').map((e) => path.join(sDir, e.name));
        if (rest.length) await add('temp', 'Temp files', label, rest, { sub, flags });
      }
    }
  }
  for (const name of ['image-cache', 'paste-cache']) {
    await add('images', 'Claude Code', name === 'image-cache' ? 'Image cache' : 'Paste cache', [path.join(CLAUDE_HOME, name)]);
  }

  // Edit checkpoints, one folder per conversation.
  for (const dir of subdirs(FILE_HISTORY)) {
    const sid = path.basename(dir);
    const c = convo.get(sid);
    await add('checkpoints', 'Claude Code', c?.title || `Session ${sid.slice(0, 8)}`, [dir], {
      sub: c?.project || tilde(dir),
      flags: { sid, orphan: !c, orphanWhy: c ? null : 'conversation deleted' },
    });
  }

  // Claude Code CLI versions: keep the one `claude` points at.
  let current = null;
  try { current = path.basename(fs.realpathSync(path.join(HOME, '.local', 'bin', 'claude'))); } catch {}
  for (const v of dirents(path.join(CLI_DIR, 'versions')).map((d) => d.name).sort(verCmp)) {
    const p = path.join(CLI_DIR, 'versions', v);
    await add('versions', 'Claude Code', `Claude Code ${v}`, [p], {
      keep: v === current ? 'Current version' : null,
      procMatch: `versions${path.sep}${v}`,
    });
  }

  for (const app of apps) {
    const at = (...p) => path.join(app.dir, ...p);
    const base = { appDir: app.dir };

    // Claude Code bundled with the app: the newest is kept.
    const vers = dirents(at('claude-code')).filter((d) => d.isDirectory()).map((d) => d.name).sort(verCmp);
    for (const v of vers) {
      await add('versions', app.name, `Claude Code ${v} (app copy)`, [at('claude-code', v)], {
        ...base, keep: v === vers.at(-1) ? 'Current version' : null, procMatch: `claude-code${path.sep}${v}${path.sep}`,
      });
    }

    await add('cache', app.name, 'Web cache', [at('Cache')], base);
    await add('cache', app.name, 'Compiled script cache', [at('Code Cache')], base);
    await add('cache', app.name, 'GPU shader caches',
      ['GPUCache', 'GPUPersistentCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache'].map((n) => at(n)), base);
    await add('cache', app.name, 'Compression dictionaries', [at('Shared Dictionary')], base);
    await add('cache', app.name, 'Crash dumps', [at('Crashpad')], base);
    await add('cache', app.name, 'Error-report queue', [at('sentry')], base);

    await add('cowork', app.name, 'Virtual machine image', [at('vm_bundles')], base);
    for (const v of dirents(at('claude-code-vm')).map((d) => d.name)) {
      await add('cowork', app.name, `Cowork's Claude Code ${v}`, [at('claude-code-vm', v)], base);
    }
    await add('cowork', app.name, 'Cowork sessions', [at('local-agent-mode-sessions')], base);

    // App-made folders whose session is gone.
    const used = [...(cwds.get(app.dir) || [])];
    for (const acct of subdirs(at('scratch-workspaces'))) {
      for (const org of subdirs(acct)) {
        for (const dir of subdirs(org)) {
          if (used.some((c) => c === dir || c.startsWith(dir + path.sep))) continue;
          await add('scratch', app.name, path.basename(dir), [dir], { flags: { orphan: true, orphanWhy: 'session gone' } });
        }
      }
    }
  }

  // Logs and diagnostics.
  await add('logs', 'Claude Code', 'Debug logs', [path.join(CLAUDE_HOME, 'debug')]);
  await add('logs', 'Claude Code', 'Telemetry queue', [path.join(CLAUDE_HOME, 'telemetry')]);
  const snaps = path.join(CLAUDE_HOME, 'shell-snapshots');
  const oldSnaps = dirents(snaps).filter((d) => d.isFile())
    .map((d) => path.join(snaps, d.name))
    .filter((p) => { try { return fs.statSync(p).mtimeMs < Date.now() - DAY; } catch { return false; } });
  await add('logs', 'Claude Code', 'Shell snapshots older than a day', oldSnaps, { sub: tilde(snaps) });
  if (MAC) {
    await add('logs', 'Claude apps', 'App logs', [path.join(HOME, 'Library', 'Logs', 'Claude')]);
    await add('cache', 'Claude Code', 'Claude Code download cache', [path.join(HOME, 'Library', 'Caches', 'claude-cli-nodejs')]);
    const reports = path.join(HOME, 'Library', 'Logs', 'DiagnosticReports');
    const claudeReports = dirents(reports).filter((d) => d.isFile() && /^Claude/i.test(d.name)).map((d) => path.join(reports, d.name));
    await add('logs', 'Claude apps', 'Crash and hang reports', claudeReports, { sub: tilde(reports) });
  }

  const roots = [...apps.map((a) => a.dir), CLAUDE_HOME, CLI_DIR, tmp].filter(Boolean);
  if (MAC) roots.push(path.join(HOME, 'Library', 'Logs'), path.join(HOME, 'Library', 'Caches'));
  last = { items: new Map(items.map((i) => [i.id, i])), roots, prune: [PROJECTS, FILE_HISTORY, tmp].filter(Boolean) };

  return {
    categories: CATEGORIES,
    sources: [
      ...apps.map((a) => ({ name: a.name, dir: tilde(a.dir), running: running.has(a.dir) })),
    ],
    trash: MAC,
    tookMs: Date.now() - started,
    items: items.map(({ paths, appDir, procMatch, keep, ...rest }) => ({ ...rest, paths: paths.map(tilde) })),
  };
}

// ---- Clean ----
function insideRoots(p, roots) {
  const abs = path.resolve(p);
  return roots.some((r) => abs.startsWith(path.resolve(r) + path.sep));
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

function uniqueIn(dir, name) {
  let candidate = name;
  for (let n = 2; exists(path.join(dir, candidate)); n++) candidate = `${name} ${n}`;
  return path.join(dir, candidate);
}

// Removes folders left empty, up to (not including) the nearest of `stops` that holds the path.
async function pruneEmptyParents(p, stops) {
  const stop = stops.filter((s) => p.startsWith(s + path.sep)).sort((a, b) => b.length - a.length)[0];
  if (!stop) return;
  let dir = path.dirname(p);
  while (dir.startsWith(stop + path.sep)) {
    try { await fsp.rmdir(dir); } catch { return; } // not empty, or gone
    dir = path.dirname(dir);
  }
}

export async function clean(ids, mode) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('Nothing selected.');
  if (!['trash', 'delete'].includes(mode)) throw new Error('Unknown clean mode.');
  if (mode === 'trash' && !MAC) throw new Error('Move to Trash is only available on macOS. Use Delete permanently.');
  if (busy) throw new Error('A scan or clean is already running.');
  busy = true;
  try {
    const procs = await processes();
    const ctx = { procs, running: runningAppDirs(desktopApps(), procs) };
    const trashDir = mode === 'trash' ? path.join(HOME, '.Trash', `Dustpan ${stamp()}`) : null;
    const results = [];
    for (const id of ids) {
      const item = last.items.get(id);
      if (!item) { results.push({ id, ok: false, error: 'Not in the latest scan. Scan again.' }); continue; }
      const now = await measure(item.paths);
      const lock = lockFor({ ...item, mtime: Math.max(item.mtime, now.mtime) }, ctx);
      if (lock) { results.push({ id, ok: false, error: lock }); continue; }
      if (!item.paths.every((p) => insideRoots(p, last.roots))) { results.push({ id, ok: false, error: 'Outside the Claude folders.' }); continue; }
      try {
        for (const p of item.paths) {
          if (!exists(p)) continue;
          if (trashDir) {
            await fsp.mkdir(trashDir, { recursive: true });
            const name = `${item.where} - ${item.label}`.replace(/[/:\\]/g, '-').slice(0, 80);
            const dest = uniqueIn(trashDir, item.paths.length > 1 ? `${name} - ${path.basename(p)}` : name);
            await fsp.rename(p, dest);
          } else {
            await fsp.rm(p, { recursive: true, force: true });
          }
          await pruneEmptyParents(p, last.prune);
        }
        last.items.delete(id);
        results.push({ id, ok: true, freed: now.size });
      } catch (err) {
        results.push({ id, ok: false, error: err.code === 'EXDEV' ? "Can't move this to the Trash (different disk). Delete it permanently instead." : err.message });
      }
    }
    return { results, trashDir: trashDir && exists(trashDir) ? tilde(trashDir) : null };
  } finally {
    busy = false;
  }
}
