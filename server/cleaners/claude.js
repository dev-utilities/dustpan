// Claude data: Claude Code (~/.claude, CLI versions, temp folder) and every Claude desktop app.
import fs from 'node:fs';
import path from 'node:path';
import {
  HOME, MAC, WIN, LIB, ROAMING, DAY, exists, tilde, readJson, dirents, subdirs, verCmp, pathItem,
} from './util.js';

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const PROJECTS = path.join(CLAUDE_HOME, 'projects');
const FILE_HISTORY = path.join(CLAUDE_HOME, 'file-history');
const CLI_DIR = path.join(HOME, '.local', 'share', 'claude');
const INSTANCES = path.join(HOME, '.claude-instances');

const CATEGORIES = [
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

function tempRoot() {
  if (WIN) return null;
  try { return fs.realpathSync(path.join('/tmp', `claude-${process.getuid()}`)); } catch { return null; }
}

// The normal app plus extra copies started with --user-data-dir (e.g. ~/.claude-instances/<name>).
function desktopApps() {
  const apps = [];
  const def = MAC ? path.join(LIB, 'Application Support', 'Claude') : WIN ? path.join(ROAMING, 'Claude') : path.join(HOME, '.config', 'Claude');
  if (exists(path.join(def, 'config.json'))) apps.push({ name: 'Claude', dir: def, isDefault: true });
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
    if (exists(path.join(dir, 'config.json'))) apps.push({ name: names.get(dir) || `Claude (${path.basename(dir)})`, dir });
  }
  return apps;
}

// App data folders whose app is running (main process only, not helpers).
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
  const cwds = new Map();
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

// Reads the start and end of a transcript for its folder, title and last activity.
function transcriptMeta(file) {
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
      for (const line of chunk.split('\n').slice(isTail ? 1 : 0)) {
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
    // unreadable: keep defaults
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return meta;
}

const projectLabel = (cwd) => (!cwd ? null : cwd.includes(`${path.sep}scratch-workspaces${path.sep}`) ? 'App-made folder' : tilde(cwd));

export async function context() {
  const apps = desktopApps();
  return { apps };
}

export async function scan(ctx) {
  const { apps, procs } = ctx;
  ctx.running = runningAppDirs(apps, procs);
  const { byCli, cwds } = appSessions(apps);
  const tmp = tempRoot();
  const items = [];
  const push = (item) => item && items.push(item);

  // Must be closed: caches and Cowork of a running app.
  const closedLock = (app) => (c) => (runningAppDirs(c.apps, c.procs).has(app.dir) ? `Quit ${app.name} first` : null);
  const procLock = (needle) => (c) => (c.procs.some((cmd) => cmd.includes(needle)) ? 'In use by a running Claude Code' : null);

  // Conversations first: temp files and checkpoints borrow their titles.
  const convo = new Map();
  for (const dir of subdirs(PROJECTS)) {
    for (const d of dirents(dir)) {
      if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
      const sid = d.name.slice(0, -6);
      const meta = transcriptMeta(path.join(dir, d.name));
      const linked = byCli.get(sid);
      const title = linked?.title || meta.title || meta.firstPrompt || '(no messages)';
      const project = projectLabel(meta.cwd);
      const orphan = meta.cwd ? !exists(meta.cwd) : false;
      convo.set(sid, { title, project });
      const badges = [];
      if (linked) badges.push({ text: `in ${linked.app}${linked.archived ? ', archived' : ''}` });
      if (orphan) badges.push({ text: 'folder gone', kind: 'warn' });
      push(await pathItem('transcripts', 'Claude Code', title, [path.join(dir, d.name), path.join(dir, sid)], {
        sub: project || tilde(dir), mtime: meta.last, badges, orphan, inUse: true, optIn: linked ? 'linked' : null,
      }));
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
        const orphan = isProject && !c;
        const gone = orphan ? [{ text: 'no conversation', kind: 'warn' }] : [];
        const imgs = path.join(sDir, 'images');
        if (exists(imgs)) {
          const n = dirents(imgs).filter((e) => e.isFile()).length;
          push(await pathItem('images', 'Temp files', label, [imgs], { sub, orphan, inUse: true, badges: [...gone, { text: `${n} image${n === 1 ? '' : 's'}` }] }));
        }
        const rest = dirents(sDir).filter((e) => e.name !== 'images').map((e) => path.join(sDir, e.name));
        if (rest.length) push(await pathItem('temp', 'Temp files', label, rest, { sub, orphan, inUse: true, badges: gone }));
      }
    }
  }
  push(await pathItem('images', 'Claude Code', 'Image cache', [path.join(CLAUDE_HOME, 'image-cache')]));
  push(await pathItem('images', 'Claude Code', 'Paste cache', [path.join(CLAUDE_HOME, 'paste-cache')]));

  for (const dir of subdirs(FILE_HISTORY)) {
    const sid = path.basename(dir);
    const c = convo.get(sid);
    push(await pathItem('checkpoints', 'Claude Code', c?.title || `Session ${sid.slice(0, 8)}`, [dir], {
      sub: c?.project || tilde(dir), orphan: !c, inUse: true, badges: c ? [] : [{ text: 'conversation deleted', kind: 'warn' }],
    }));
  }

  // Claude Code CLI versions: keep the one `claude` points at.
  let current = null;
  try { current = path.basename(fs.realpathSync(path.join(HOME, '.local', 'bin', 'claude'))); } catch {}
  for (const v of dirents(path.join(CLI_DIR, 'versions')).map((d) => d.name).sort(verCmp)) {
    const keep = v === current;
    push(await pathItem('versions', 'Claude Code', `Claude Code ${v}`, [path.join(CLI_DIR, 'versions', v)], {
      keepEmpty: keep, lock: keep ? () => 'Current version' : procLock(`versions${path.sep}${v}`),
    }));
  }

  for (const app of apps) {
    const at = (...p) => path.join(app.dir, ...p);
    const lock = closedLock(app);
    const vers = dirents(at('claude-code')).filter((d) => d.isDirectory()).map((d) => d.name).sort(verCmp);
    for (const v of vers) {
      const keep = v === vers.at(-1);
      push(await pathItem('versions', app.name, `Claude Code ${v} (app copy)`, [at('claude-code', v)], {
        lock: keep ? () => 'Current version' : procLock(`claude-code${path.sep}${v}${path.sep}`),
      }));
    }
    push(await pathItem('cache', app.name, 'Web cache', [at('Cache')], { lock }));
    push(await pathItem('cache', app.name, 'Compiled script cache', [at('Code Cache')], { lock }));
    push(await pathItem('cache', app.name, 'GPU shader caches',
      ['GPUCache', 'GPUPersistentCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache'].map((n) => at(n)), { lock }));
    push(await pathItem('cache', app.name, 'Compression dictionaries', [at('Shared Dictionary')], { lock }));
    push(await pathItem('cache', app.name, 'Crash dumps', [at('Crashpad')], { lock }));
    push(await pathItem('cache', app.name, 'Error-report queue', [at('sentry')], { lock }));
    push(await pathItem('cowork', app.name, 'Virtual machine image', [at('vm_bundles')], { lock }));
    for (const v of dirents(at('claude-code-vm')).map((d) => d.name)) {
      push(await pathItem('cowork', app.name, `Cowork's Claude Code ${v}`, [at('claude-code-vm', v)], { lock }));
    }
    push(await pathItem('cowork', app.name, 'Cowork sessions', [at('local-agent-mode-sessions')], { lock }));

    // App-made folders whose session is gone.
    const used = [...(cwds.get(app.dir) || [])];
    for (const acct of subdirs(at('scratch-workspaces'))) {
      for (const org of subdirs(acct)) {
        for (const dir of subdirs(org)) {
          if (used.some((c) => c === dir || c.startsWith(dir + path.sep))) continue;
          push(await pathItem('scratch', app.name, path.basename(dir), [dir], { orphan: true, inUse: true, badges: [{ text: 'session gone', kind: 'warn' }] }));
        }
      }
    }
  }

  push(await pathItem('logs', 'Claude Code', 'Debug logs', [path.join(CLAUDE_HOME, 'debug')]));
  push(await pathItem('logs', 'Claude Code', 'Telemetry queue', [path.join(CLAUDE_HOME, 'telemetry')]));
  const snaps = path.join(CLAUDE_HOME, 'shell-snapshots');
  const oldSnaps = dirents(snaps).filter((d) => d.isFile()).map((d) => path.join(snaps, d.name))
    .filter((p) => { try { return fs.statSync(p).mtimeMs < Date.now() - DAY; } catch { return false; } });
  push(await pathItem('logs', 'Claude Code', 'Shell snapshots older than a day', oldSnaps, { sub: tilde(snaps) }));
  if (MAC) {
    push(await pathItem('logs', 'Claude apps', 'App logs', [path.join(LIB, 'Logs', 'Claude')]));
    push(await pathItem('cache', 'Claude Code', 'Claude Code download cache', [path.join(LIB, 'Caches', 'claude-cli-nodejs')]));
    const reports = path.join(LIB, 'Logs', 'DiagnosticReports');
    const claudeReports = dirents(reports).filter((d) => d.isFile() && /^Claude/i.test(d.name)).map((d) => path.join(reports, d.name));
    push(await pathItem('logs', 'Claude apps', 'Crash and hang reports', claudeReports, { sub: tilde(reports) }));
  }

  const roots = [...apps.map((a) => a.dir), CLAUDE_HOME, CLI_DIR, tmp].filter(Boolean);
  if (MAC) roots.push(path.join(LIB, 'Logs'), path.join(LIB, 'Caches'));
  return {
    categories: CATEGORIES,
    sources: apps.map((a) => ({
      name: a.name, detail: tilde(a.dir),
      state: ctx.running.has(a.dir) ? 'running: quit it to clean its caches and Cowork' : 'closed',
      warn: ctx.running.has(a.dir),
    })),
    optIns: [{ id: 'linked', label: 'Allow conversations still listed in a Claude app (they open empty there)' }],
    items,
    roots,
    prune: [PROJECTS, FILE_HISTORY, tmp].filter(Boolean),
  };
}
