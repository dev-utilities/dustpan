// JetBrains IDEs: leftovers of IDE versions you no longer have, and caches of the ones you do.
//
// Each IDE version keeps folders named like PyCharm2026.3 in three places (caches, settings, logs).
// The installed IDEs say which name is theirs (dataDirectoryName in product-info.json), so
// "installed" is read from the apps themselves, not guessed from the newest folder.
import path from 'node:path';
import {
  HOME, MAC, WIN, LIB, LOCAL, ROAMING, XDG_CACHE, exists, readJson, dirents, verCmp, pathItem,
} from './util.js';

const CATEGORIES = [
  { id: 'old', label: 'Old IDE version leftovers', desc: 'Caches and logs of IDE versions that are no longer installed.' },
  { id: 'oldconfig', label: 'Old IDE version settings', desc: 'Settings and plugins of old versions. Kept when they are the only settings of that IDE.' },
  { id: 'current', label: 'Caches of installed IDEs', desc: 'Indexes and caches. The IDE rebuilds them on next start, which takes a while.' },
  { id: 'logs', label: 'Logs', desc: 'IDE log files.' },
  { id: 'tools', label: 'Toolbox & other JetBrains tools', desc: 'Caches of Toolbox, AI agents and other JetBrains helpers.' },
];

// Where version folders live on each OS.
function places() {
  if (MAC) return {
    caches: path.join(LIB, 'Caches', 'JetBrains'),
    config: path.join(LIB, 'Application Support', 'JetBrains'),
    logs: path.join(LIB, 'Logs', 'JetBrains'),
  };
  if (WIN) return { caches: path.join(LOCAL, 'JetBrains'), config: path.join(ROAMING, 'JetBrains'), logs: null };
  return { caches: path.join(XDG_CACHE, 'JetBrains'), config: path.join(HOME, '.config', 'JetBrains'), logs: null, data: path.join(HOME, '.local', 'share', 'JetBrains') };
}

const VERSION_DIR = /^([A-Za-z][A-Za-z-]*?)(\d{4}\.\d+)$/;

// Installed IDEs: { dataDir: 'PyCharm2026.3', name: 'PyCharm', home: '/Applications/PyCharm.app' }
function installedIdes() {
  const found = [];
  const look = (home, infoFile) => {
    const info = readJson(infoFile);
    if (info?.dataDirectoryName) found.push({ dataDir: info.dataDirectoryName, name: info.name || info.dataDirectoryName, home });
  };
  const scanDir = (dir, depth) => {
    for (const d of dirents(dir)) {
      if (!d.isDirectory()) continue;
      const p = path.join(dir, d.name);
      if (MAC && d.name.endsWith('.app')) look(p, path.join(p, 'Contents', 'Resources', 'product-info.json'));
      else if (!MAC && exists(path.join(p, 'product-info.json'))) look(p, path.join(p, 'product-info.json'));
      else if (depth > 0 && !d.name.startsWith('.')) scanDir(p, depth - 1);
    }
  };
  if (MAC) {
    scanDir('/Applications', 1);
    scanDir(path.join(HOME, 'Applications'), 2);
    scanDir(path.join(LIB, 'Application Support', 'JetBrains', 'Toolbox', 'apps'), 4);
  } else if (WIN) {
    scanDir(path.join(LOCAL, 'Programs'), 1);
    scanDir(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'JetBrains'), 1);
    scanDir(path.join(LOCAL, 'JetBrains', 'Toolbox', 'apps'), 4);
  } else {
    scanDir(path.join(HOME, '.local', 'share', 'JetBrains', 'Toolbox', 'apps'), 4);
    scanDir('/opt', 1);
  }
  return found;
}

const isRunning = (ide, procs) => procs.some((c) => c.startsWith(ide.home + path.sep) || c.includes(`${ide.home}${path.sep}`));

export async function context() {
  return { ides: installedIdes() };
}

export async function scan(ctx) {
  const where = places();
  const ides = ctx.ides;
  const installed = new Map(ides.map((i) => [i.dataDir, i]));
  const items = [];
  const push = (item) => item && items.push(item);

  // Every version folder name seen anywhere, grouped by product (PyCharm, PyCharmCE, WebStorm, …).
  const byProduct = new Map();
  for (const root of [where.caches, where.config, where.logs, where.data].filter(Boolean)) {
    for (const d of dirents(root)) {
      const m = d.isDirectory() && d.name.match(VERSION_DIR);
      if (!m) continue;
      const list = byProduct.get(m[1]) || new Set();
      list.add(m[2]);
      byProduct.set(m[1], list);
    }
  }
  // Without any detected install (unknown install place), fall back to "newest version is current".
  const fallback = ides.length === 0;

  for (const [product, versionSet] of byProduct) {
    const versions = [...versionSet].sort(verCmp);
    for (const v of versions) {
      const name = `${product}${v}`;
      const ide = installed.get(name);
      const current = ide || (fallback && v === versions.at(-1));
      const label = `${ide?.name || product} ${v}`;
      const runLock = (c) => (ide && isRunning(ide, c.procs) ? `Quit ${ide.name} first` : null);
      const badges = current ? [{ text: ide ? 'installed' : 'newest (install not found)' }] : [{ text: 'not installed', kind: 'warn' }];
      const cacheDir = path.join(where.caches, name);
      const logDirs = [where.logs && path.join(where.logs, name), !where.logs && path.join(cacheDir, 'log')].filter(Boolean);

      if (current) {
        // Logs live inside the cache folder off macOS; keep them as their own row.
        const inner = dirents(cacheDir).filter((d) => d.name !== 'log').map((d) => path.join(cacheDir, d.name));
        push(await pathItem('current', label, `${label} caches`, inner, { sub: cacheDir, badges, lock: runLock }));
        push(await pathItem('logs', label, `${label} logs`, logDirs, { badges }));
        continue;
      }
      push(await pathItem('old', label, `${label} caches`, [cacheDir], { badges, orphan: true, lock: runLock }));
      if (where.logs) push(await pathItem('old', label, `${label} logs`, logDirs, { badges, orphan: true }));
      if (where.data) push(await pathItem('old', label, `${label} plugins and data`, [path.join(where.data, name)], { badges, orphan: true }));

      // Settings: keep the last copy of an IDE's settings unless the toggle allows it.
      const configDir = path.join(where.config, name);
      if (exists(configDir)) {
        const newer = versions.filter((x) => verCmp(x, v) > 0 && exists(path.join(where.config, `${product}${x}`)));
        const cfgBadges = newer.length ? [...badges, { text: `newer settings: ${newer.at(-1)}` }] : [...badges, { text: 'only settings of this IDE', kind: 'warn' }];
        push(await pathItem('oldconfig', label, `${label} settings and plugins`, [configDir], {
          badges: cfgBadges, orphan: true, optIn: newer.length ? null : 'lastconfig', lock: runLock,
        }));
      }
    }
  }

  // Toolbox and other non-version folders in the caches and logs roots.
  const toolboxRunning = (procs) => procs.some((c) => /JetBrains Toolbox|jetbrains-toolbox/.test(c));
  for (const root of [where.caches, where.logs].filter(Boolean)) {
    for (const d of dirents(root)) {
      if (!d.isDirectory() || VERSION_DIR.test(d.name)) continue;
      const p = path.join(root, d.name);
      const isToolbox = /^Toolbox/.test(d.name);
      push(await pathItem('tools', 'JetBrains', `${d.name} ${root === where.logs ? 'logs' : 'cache'}`, [p], {
        lock: isToolbox ? (c) => (toolboxRunning(c.procs) ? 'Quit JetBrains Toolbox first' : null) : null,
      }));
    }
  }

  return {
    categories: CATEGORIES,
    sources: ides.length
      ? ides.map((i) => ({ name: `${i.name}`, detail: i.home, state: isRunning(i, ctx.procs) ? 'running: quit it to clean its caches' : `uses ${i.dataDir}`, warn: isRunning(i, ctx.procs) }))
      : [{ name: 'No installed JetBrains IDE found', detail: '', state: 'the newest version of each IDE is treated as installed' }],
    optIns: [{ id: 'lastconfig', label: "Allow the last settings of IDEs that aren't installed" }],
    items,
    roots: [where.caches, where.config, where.logs, where.data].filter(Boolean),
    prune: [],
  };
}

