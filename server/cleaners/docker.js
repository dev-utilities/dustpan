// Docker: unused images, stopped containers, unused volumes and the build cache, through the `docker` CLI.
import path from 'node:path';
import { LIB, MAC, execFileP, hash, sizeOf, tilde, plural } from './util.js';

const CATEGORIES = [
  { id: 'images', label: 'Images', desc: 'Images no container uses. Pulled or built again when needed.' },
  { id: 'containers', label: 'Stopped containers', desc: 'Containers that are not running, with their writable layer. Running ones are kept.' },
  { id: 'volumes', label: 'Unused volumes', desc: 'Volumes no container uses. Named volumes can hold databases, so they need their toggle.' },
  { id: 'build', label: 'Build cache', desc: 'Layers kept to speed up docker build.' },
];
const ORDER = { containers: 0, images: 1, volumes: 2, build: 3 };

const docker = async (args, timeout = 60000) => (await execFileP('docker', args, { timeout, maxBuffer: 64 * 1024 * 1024 })).stdout;

// "1.5GB", "37.61kB", "0B" -> bytes (Docker uses powers of 1000).
function bytes(text) {
  const m = String(text || '').match(/([\d.]+)\s*([kMGT]?)B/);
  if (!m) return 0;
  return Math.round(Number(m[1]) * 1000 ** ' kMGT'.indexOf(m[2] || ' '));
}
const date = (text) => {
  const t = Date.parse(String(text || '').replace(/ [A-Z]{3,4}$/, '').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2').replace(' ', 'T').replace(' ', ''));
  return Number.isNaN(t) ? 0 : t;
};
const short = (id) => id.replace(/^sha256:/, '').slice(0, 12);

async function state() {
  const df = JSON.parse(await docker(['system', 'df', '-v', '--format', '{{json .}}'], 120000));
  const containers = (await docker(['ps', '-a', '--no-trunc', '--format', '{{json .}}'])).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Which image id each container runs, so images in use can be kept.
  const ids = containers.length ? JSON.parse(await docker(['inspect', '--format', '{{json .}}', ...containers.map((c) => c.ID)]).then((s) => `[${s.trim().split('\n').join(',')}]`)) : [];
  const usage = new Map(); // image id -> [{ name, running }]
  const volumeUse = new Map(); // volume name -> [{ name, running }]
  for (const c of ids) {
    const ref = { name: c.Name.replace(/^\//, ''), running: c.State?.Running };
    usage.set(c.Image, [...(usage.get(c.Image) || []), ref]);
    for (const m of c.Mounts || []) if (m.Type === 'volume') volumeUse.set(m.Name, [...(volumeUse.get(m.Name) || []), ref]);
  }
  const summary = (await docker(['system', 'df', '--format', '{{json .}}'])).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { df, summary, containers, usage, volumeUse };
}

export async function context() {
  try {
    const version = (await docker(['version', '--format', '{{.Server.Version}}'], 8000)).trim();
    return { docker: { version, ...(await state()) } };
  } catch (err) {
    return { docker: null, dockerError: err.code === 'ENOENT' ? 'Docker isn’t installed (no docker command found).' : 'Docker isn’t running. Start Docker Desktop, then scan again.' };
  }
}

const usedBy = (list) => list.map((u) => `${u.name}${u.running ? '' : ' (stopped)'}`).join(', ');

export async function scan(ctx) {
  const d = ctx.docker;
  const base = { categories: CATEGORIES, modes: ['delete'], optIns: [{ id: 'named', label: 'Allow named volumes (they can hold databases)' }] };
  if (!d) return { ...base, notice: ctx.dockerError, items: [] };
  const items = [];

  // Images: one row per tag; extra tags of the same image free nothing on their own.
  const seen = new Map();
  for (const img of d.df.Images) {
    const tagged = img.Repository !== '<none>';
    const name = tagged ? `${img.Repository}:${img.Tag}` : `<untagged> ${short(img.ID)}`;
    const first = seen.get(img.ID);
    seen.set(img.ID, first ?? name);
    const users = d.usage.get(img.ID) || [];
    const badges = [];
    if (!tagged) badges.push({ text: 'dangling', kind: 'warn' });
    if (first) badges.push({ text: `same image as ${first}` });
    if (users.length) badges.push({ text: `used by ${usedBy(users)}`, kind: users.some((u) => !u.running) ? 'warn' : '' });
    const shared = bytes(img.SharedSize);
    if (shared) badges.push({ text: `shares ${img.SharedSize} with other images` });
    items.push({
      id: hash(`img\0${img.ID}\0${name}`), cat: 'images', where: 'Docker', label: name, sub: short(img.ID),
      size: first ? 0 : bytes(img.UniqueSize || img.Size), mtime: date(img.CreatedAt), badges, orphan: !tagged,
      _lock: (c) => {
        if (!c.docker) return 'Docker isn’t running';
        // Stopped users aren't a lock: pick the container too (containers go first), or Docker refuses.
        const now = (c.docker.usage.get(img.ID) || []).filter((u) => u.running);
        return now.length ? `Used by running ${usedBy(now)}` : null;
      },
      _remove: () => docker(['image', 'rm', tagged ? name : img.ID]),
    });
  }

  for (const c of d.containers) {
    const running = c.State === 'running';
    const project = c.Labels?.match(/com\.docker\.compose\.project=([^,]+)/)?.[1];
    const badges = [{ text: c.Status }];
    if (project) badges.push({ text: `compose: ${project}` });
    items.push({
      id: hash(`ctr\0${c.ID}`), cat: 'containers', where: 'Docker', label: c.Names, sub: `${c.Image} · ${short(c.ID)}`,
      size: bytes(c.Size), mtime: date(c.CreatedAt), badges, orphan: false,
      _lock: (ctx2) => {
        if (!ctx2.docker) return 'Docker isn’t running';
        return ctx2.docker.containers.find((x) => x.ID === c.ID)?.State === 'running' ? 'Running' : null;
      },
      _remove: () => docker(['container', 'rm', '-v', c.ID]), // -v: its anonymous volumes too (named ones stay)
    });
    if (running) items.at(-1).badges.unshift({ text: 'running' });
  }

  for (const v of d.df.Volumes) {
    const anonymous = /com\.docker\.volume\.anonymous/.test(v.Labels || '') || /^[0-9a-f]{64}$/.test(v.Name);
    const users = d.volumeUse.get(v.Name) || [];
    const project = v.Labels?.match(/com\.docker\.compose\.project=([^,]+)/)?.[1];
    const badges = [{ text: anonymous ? 'anonymous' : 'named' }];
    if (project) badges.push({ text: `compose: ${project}` });
    if (users.length) badges.push({ text: `used by ${usedBy(users)}` });
    items.push({
      id: hash(`vol\0${v.Name}`), cat: 'volumes', where: 'Docker', label: anonymous ? `Anonymous ${v.Name.slice(0, 12)}` : v.Name,
      sub: v.Mountpoint || v.Name, size: bytes(v.Size), mtime: 0, badges, orphan: !users.length,
      optIn: anonymous ? null : 'named',
      _lock: (c) => {
        if (!c.docker) return 'Docker isn’t running';
        const now = (c.docker.volumeUse.get(v.Name) || []).filter((u) => u.running);
        return now.length ? `Used by running ${usedBy(now)}` : null;
      },
      _remove: () => docker(['volume', 'rm', v.Name]),
    });
  }

  const cache = d.df.BuildCache.filter((b) => b.InUse !== 'true');
  // What `docker builder prune` frees, as Docker itself reports it.
  const cacheSize = bytes(d.summary.find((r) => r.Type === 'Build Cache')?.Reclaimable);
  if (cache.length && cacheSize) {
    items.push({
      id: hash('build'), cat: 'build', where: 'Docker', label: 'Unused build cache', sub: plural(cache.length, 'record'),
      size: cacheSize, mtime: Math.max(0, ...cache.map((b) => date(b.LastUsedAt))), badges: [], orphan: false,
      _lock: (c) => (c.docker ? null : 'Docker isn’t running'),
      _remove: () => docker(['builder', 'prune', '-f'], 300000),
    });
  }

  const raw = MAC ? path.join(LIB, 'Containers', 'com.docker.docker', 'Data', 'vms', '0', 'data', 'Docker.raw') : null;
  const disk = raw ? (await sizeOf(raw)).size : 0;
  return {
    ...base,
    sources: [{
      name: `Docker ${d.version}`,
      detail: raw ? tilde(raw) : '',
      state: `${plural(d.containers.filter((c) => c.State === 'running').length, 'container')} running${disk ? `, disk image uses ${(disk / 1e9).toFixed(1)} GB` : ''}`,
    }],
    items,
  };
}

export const order = (item) => ORDER[item.cat] ?? 9;
