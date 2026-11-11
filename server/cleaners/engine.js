// Runs the cleaner tools: scan → items for the page; clean → remove the items the page picked.
//
// Safety: the page can only name items from the latest scan of that tool (by id). Right before
// removing, each item's lock is checked again with fresh state (running apps, last use), its
// toggle (optIn) must be allowed by the page, and every path must sit inside the tool's roots.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HOME, MAC, IN_USE_MS, exists, tilde, measure, processes } from './util.js';
import * as claude from './claude.js';
import * as docker from './docker.js';
import * as jetbrains from './jetbrains.js';
import * as devcaches from './devcaches.js';
import * as appcaches from './appcaches.js';

const TOOLS = { claude, docker, jetbrains, devcaches, appcaches };
const state = new Map(); // tool id -> { items: Map, roots, prune }
const scanning = new Map(); // tool id -> scan promise (a second scan request joins it)
const cleaning = new Set(); // tool ids being cleaned

function lockOf(item, ctx) {
  const why = item._lock?.(ctx);
  if (why) return why;
  if (item._inUse && item.mtime > Date.now() - IN_USE_MS) return 'Used in the last 30 minutes';
  return null;
}

function toolFor(id) {
  const tool = TOOLS[id];
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  return tool;
}

export function scan(toolId) {
  const tool = toolFor(toolId);
  if (cleaning.has(toolId)) throw new Error('Cleaning is still running. Scan again when it finishes.');
  if (scanning.has(toolId)) return scanning.get(toolId);
  const run = (async () => {
    const started = Date.now();
    const ctx = { procs: await processes(), ...(await tool.context?.()) };
    const out = await tool.scan(ctx);
    const items = out.items.filter(Boolean);
    for (const item of items) item.lock = lockOf(item, ctx);
    state.set(toolId, { items: new Map(items.map((i) => [i.id, i])), roots: out.roots ?? [], prune: out.prune ?? [] });
    return {
      categories: out.categories,
      sources: out.sources ?? [],
      notice: out.notice ?? null,
      optIns: out.optIns ?? [],
      modes: out.modes ?? (MAC ? ['trash', 'delete'] : ['delete']),
      tookMs: Date.now() - started,
      items: items.map(publicItem),
    };
  })().finally(() => scanning.delete(toolId));
  scanning.set(toolId, run);
  return run;
}

function publicItem(item) {
  const out = {};
  for (const [k, v] of Object.entries(item)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

function insideRoots(p, roots) {
  const abs = path.resolve(p);
  return roots.some((r) => abs.startsWith(path.resolve(r) + path.sep));
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

export function clean(toolId, { ids, mode, allow = [] } = {}) {
  const tool = toolFor(toolId);
  if (!Array.isArray(ids) || !ids.length) throw new Error('Nothing selected.');
  if (!['trash', 'delete'].includes(mode)) throw new Error('Unknown clean mode.');
  if (mode === 'trash' && !MAC) throw new Error('Move to Trash is only available on macOS. Use Delete permanently.');
  const allowed = new Set(Array.isArray(allow) ? allow : []);
  if (cleaning.has(toolId) || scanning.has(toolId)) throw new Error('A scan or clean of this tool is still running.');
  cleaning.add(toolId);
  return (async () => {
    const last = state.get(toolId);
    const ctx = { procs: await processes(), ...(await tool.context?.()) };
    const trashDir = mode === 'trash' ? path.join(HOME, '.Trash', `Dustpan ${stamp()}`) : null;
    // Tools can order removals (Docker: containers before the images they use).
    const items = ids.map((id) => last?.items.get(id) ?? { id, missing: true });
    if (tool.order) items.sort((a, b) => tool.order(a) - tool.order(b));
    const results = [];
    for (const item of items) {
      const { id } = item;
      if (item.missing) { results.push({ id, ok: false, error: 'Not in the latest scan. Scan again.' }); continue; }
      if (item.optIn && !allowed.has(item.optIn)) { results.push({ id, ok: false, error: 'Needs its toggle turned on.' }); continue; }
      try {
        if (item._remove) {
          const why = lockOf(item, ctx);
          if (why) { results.push({ id, ok: false, error: why }); continue; }
          await item._remove(ctx);
          last.items.delete(id);
          results.push({ id, ok: true, freed: item.size });
          continue;
        }
        const now = await measure(item._paths);
        const why = lockOf({ ...item, mtime: Math.max(item.mtime, now.mtime) }, ctx);
        if (why) { results.push({ id, ok: false, error: why }); continue; }
        if (!item._paths.every((p) => insideRoots(p, last.roots))) { results.push({ id, ok: false, error: "Outside this tool's folders." }); continue; }
        for (const p of item._paths) {
          if (!exists(p)) continue;
          if (trashDir) {
            await fsp.mkdir(trashDir, { recursive: true });
            const name = `${item.where} - ${item.label}`.replace(/[/:\\]/g, '-').slice(0, 80);
            await fsp.rename(p, uniqueIn(trashDir, item._paths.length > 1 ? `${name} - ${path.basename(p)}` : name));
          } else {
            await fsp.rm(p, { recursive: true, force: true, maxRetries: 2 });
          }
          await pruneEmptyParents(p, last.prune);
        }
        last.items.delete(id);
        results.push({ id, ok: true, freed: now.size });
      } catch (err) {
        const msg = err.code === 'EXDEV' ? "Can't move this to the Trash (different disk). Delete it permanently instead."
          : err.code === 'EACCES' || err.code === 'EPERM' ? `No permission to remove ${tilde(err.path || '')}.`
            : err.message;
        results.push({ id, ok: false, error: msg });
      }
    }
    return { results, trashDir: trashDir && fs.existsSync(trashDir) ? tilde(trashDir) : null };
  })().finally(() => cleaning.delete(toolId));
}
