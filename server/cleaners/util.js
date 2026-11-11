// Shared helpers for the cleaner tools: paths, sizes, processes, items.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execFileP = promisify(execFile);
export const HOME = os.homedir();
export const MAC = process.platform === 'darwin';
export const WIN = process.platform === 'win32';
export const DAY = 24 * 60 * 60 * 1000;
export const IN_USE_MS = 30 * 60 * 1000;

// Per-OS folders. LOCALAPPDATA/APPDATA only exist on Windows.
export const LOCAL = WIN ? (process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')) : null;
export const ROAMING = WIN ? (process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')) : null;
export const LIB = MAC ? path.join(HOME, 'Library') : null;
export const XDG_CACHE = process.env.XDG_CACHE_HOME || path.join(HOME, '.cache');

export const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
export const tilde = (p) => (p.startsWith(HOME + path.sep) ? `~${p.slice(HOME.length)}` : p);
export const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
export const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
export const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
export const dirents = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };
export const subdirs = (p) => dirents(p).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
export const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
export const verCmp = (a, b) => {
  const pa = String(a).split(/[.\-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.\-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Command lines of every running process (empty on Windows or if `ps` fails).
export async function processes() {
  if (WIN) return [];
  try {
    const { stdout } = await execFileP('ps', ['-Ao', 'command='], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ---- Sizes ----
// Caps open file handles while walking big trees (npm caches have 100k+ files).
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= 96) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

// Allocated size like `du` (APFS clones and sparse files count what they really use). Doesn't follow links.
export async function sizeOf(p) {
  const st = await limited(() => fsp.lstat(p)).catch(() => null);
  if (!st) return { size: 0, files: 0, mtime: 0 };
  const own = st.blocks != null ? st.blocks * 512 : st.size;
  if (!st.isDirectory()) return { size: own, files: 1, mtime: st.mtimeMs };
  const out = { size: own, files: 0, mtime: st.mtimeMs };
  const entries = await limited(() => fsp.readdir(p)).catch(() => []);
  const parts = await Promise.all(entries.map((e) => sizeOf(path.join(p, e))));
  for (const r of parts) { out.size += r.size; out.files += r.files; if (r.mtime > out.mtime) out.mtime = r.mtime; }
  return out;
}

export async function measure(paths) {
  const parts = await Promise.all(paths.map(sizeOf));
  return parts.reduce((o, r) => ({ size: o.size + r.size, files: o.files + r.files, mtime: Math.max(o.mtime, r.mtime) }), { size: 0, files: 0, mtime: 0 });
}

// ---- Items ----
// An item is one row on the page. Fields starting with _ stay on the server.
//   cat, where, label, sub, size, files, mtime, badges[{text, kind}], orphan, optIn (id of a toggle it needs)
//   _paths: files/folders removed together; _remove(): custom removal (Docker); _lock(ctx): why it's kept, or null
//   _inUse: lock when used in the last 30 minutes
export async function pathItem(cat, where, label, paths, extra = {}) {
  paths = paths.filter(exists);
  if (!paths.length) return null;
  const m = await measure(paths);
  if (!m.size && !extra.keepEmpty) return null;
  return {
    id: hash(`${cat}\0${paths.join('\0')}`),
    cat, where, label,
    sub: extra.sub ?? tilde(paths[0]),
    size: m.size, files: m.files,
    mtime: Math.max(extra.mtime || 0, m.mtime),
    badges: extra.badges ?? [],
    orphan: extra.orphan ?? false,
    optIn: extra.optIn ?? null,
    _paths: paths,
    _lock: extra.lock ?? null,
    _inUse: extra.inUse ?? false,
  };
}

// Items whose app must be closed: a running app needs the "allow running apps" toggle instead of a hard lock.
export function runningGate(item, running, appName) {
  if (!running) return item;
  item.optIn = 'running';
  item.badges = [{ text: `${appName} is running`, kind: 'warn' }, ...item.badges];
  return item;
}
