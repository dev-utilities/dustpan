// Developer caches: package-manager caches, downloaded models and browsers, build caches,
// Python environments and node_modules in project folders.
import fs from 'node:fs';
import path from 'node:path';
import {
  HOME, MAC, WIN, LIB, LOCAL, XDG_CACHE, exists, tilde, readText, dirents, subdirs, mtimeOf, verCmp, pathItem,
} from './util.js';

const CATEGORIES = [
  { id: 'packages', label: 'Package caches', desc: 'Downloads kept by npm, pnpm, Yarn, pip, uv and others. Downloaded again when needed.' },
  { id: 'models', label: 'AI models & datasets', desc: 'Hugging Face models and datasets. Downloaded again on next use, which can be large.' },
  { id: 'browsers', label: 'Test browsers', desc: 'Browsers downloaded by Playwright and Puppeteer. Older builds of the same browser go first.' },
  { id: 'build', label: 'Build caches', desc: 'Xcode, Go, Gradle, Cargo and other build outputs. Rebuilt when needed.' },
  { id: 'envs', label: 'Python environments', desc: 'Virtualenvs, pyenv versions and conda envs. You would need to recreate them.' },
  { id: 'node_modules', label: 'Project node_modules', desc: 'Installed packages in project folders. Run npm install again when you return to a project.' },
  { id: 'other', label: 'Other cache folders', desc: 'Everything else in ~/.cache.' },
];

const mac = (...p) => (MAC ? path.join(LIB, ...p) : null);
const win = (...p) => (WIN ? path.join(LOCAL, ...p) : null);
const nix = (...p) => (!MAC && !WIN ? path.join(XDG_CACHE, ...p) : null);
const home = (...p) => path.join(HOME, ...p);

// [category, tool name, label, paths (first existing ones are used), extra]
const KNOWN = [
  ['packages', 'npm', 'npm download cache', [home('.npm', '_cacache'), win('npm-cache', '_cacache')]],
  ['packages', 'npm', 'npm logs', [home('.npm', '_logs'), win('npm-cache', '_logs')]],
  ['packages', 'pnpm', 'pnpm store', [mac('pnpm', 'store'), home('.local', 'share', 'pnpm', 'store'), win('pnpm', 'store')]],
  ['packages', 'pnpm', 'pnpm cache', [mac('Caches', 'pnpm'), nix('pnpm'), win('pnpm-cache')]],
  ['packages', 'Yarn', 'Yarn cache', [mac('Caches', 'Yarn'), nix('yarn'), win('Yarn', 'Cache'), home('.yarn', 'berry', 'cache')]],
  ['packages', 'Bun', 'Bun cache', [home('.bun', 'install', 'cache')]],
  ['packages', 'pip', 'pip cache', [mac('Caches', 'pip'), nix('pip'), win('pip', 'Cache')]],
  ['packages', 'uv', 'uv cache', [nix('uv'), mac('Caches', 'uv'), home('.cache', 'uv'), win('uv', 'cache')]],
  ['packages', 'Poetry', 'Poetry cache', [mac('Caches', 'pypoetry'), nix('pypoetry'), win('pypoetry', 'Cache')]],
  ['packages', 'Homebrew', 'Homebrew downloads', [mac('Caches', 'Homebrew')]],
  ['packages', 'CocoaPods', 'CocoaPods cache', [mac('Caches', 'CocoaPods')]],
  ['packages', 'Maven', 'Maven repository', [home('.m2', 'repository')]],
  ['packages', 'Cargo', 'Cargo registry cache', [home('.cargo', 'registry', 'cache'), home('.cargo', 'registry', 'src')]],
  ['build', 'Gradle', 'Gradle caches', [home('.gradle', 'caches')]],
  ['build', 'Go', 'Go build cache', [mac('Caches', 'go-build'), nix('go-build'), win('go-build')]],
  ['build', 'Xcode', 'Xcode module cache', [mac('Developer', 'Xcode', 'DerivedData', 'ModuleCache.noindex')]],
  ['build', 'Xcode', 'Simulator caches', [mac('Developer', 'CoreSimulator', 'Caches')]],
  ['build', 'Xcode', 'iOS device support files', [mac('Developer', 'Xcode', 'iOS DeviceSupport')]],
  ['build', 'node-gyp', 'node-gyp headers', [mac('Caches', 'node-gyp'), nix('node-gyp'), win('node-gyp', 'Cache')]],
];
// ~/.cache folders handled above or by other tools.
const HANDLED_IN_CACHE = new Set(['pip', 'uv', 'pypoetry', 'yarn', 'pnpm', 'go-build', 'node-gyp', 'huggingface', 'ms-playwright', 'puppeteer', 'JetBrains', 'claude']);

const PROJECT_ROOTS = ['repos', 'Desktop/repos', 'projects', 'code', 'dev', 'src', 'Developer', 'Documents/GitHub', 'work', 'workspace'].map((p) => home(...p.split('/')));
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'Library', '.Trash', 'dist', 'build', '.next']);

// Folders that hold a Python env: .venv/venv in projects (found with node_modules), and the managers' homes.
const isVenv = (p) => exists(path.join(p, 'pyvenv.cfg')) || exists(path.join(p, 'conda-meta'));
const venvPython = (p) => readText(path.join(p, 'pyvenv.cfg'))?.match(/^version(?:_info)?\s*=\s*(.+)$/m)?.[1]?.trim() ?? null;
const envLock = (p) => (c) => (c.procs.some((cmd) => cmd.startsWith(p + path.sep) || cmd.includes(`${p}${path.sep}bin${path.sep}`)) ? 'A running process uses it' : null);

// One walk of the project roots finds node_modules and project venvs.
function findProjects() {
  const nodeModules = [];
  const venvs = [];
  const walk = (dir, depth) => {
    for (const d of dirents(dir)) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      const p = path.join(dir, d.name);
      if (d.name === 'node_modules') { nodeModules.push(p); continue; }
      if ((d.name === '.venv' || d.name === 'venv' || d.name === 'env') && isVenv(p)) { venvs.push(p); continue; }
      if (SKIP.has(d.name) || d.name.startsWith('.') || depth <= 0) continue;
      walk(p, depth - 1);
    }
  };
  for (const root of PROJECT_ROOTS) if (exists(root)) walk(root, 4);
  return { nodeModules, venvs };
}

export async function scan() {
  const items = [];
  const push = (item) => item && items.push(item);
  const roots = new Set([XDG_CACHE, home('.npm'), home('.m2'), home('.cargo'), home('.gradle'), home('.bun'), home('.yarn'),
    home('.virtualenvs'), home('.pyenv'), home('.local', 'share', 'pnpm'), ...PROJECT_ROOTS,
    ...['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge'].map((c) => home(c))]);
  if (MAC) roots.add(path.join(LIB, 'Caches')).add(path.join(LIB, 'pnpm')).add(path.join(LIB, 'Developer'));
  if (WIN) roots.add(LOCAL);

  for (const [cat, tool, label, candidates] of KNOWN) {
    const paths = [...new Set(candidates.filter(Boolean))].filter(exists);
    for (const p of paths) push(await pathItem(cat, tool, label, [p]));
  }

  // npx keeps one folder per package run; running ones (e.g. an MCP server) are kept.
  const npx = [home('.npm', '_npx'), win('npm-cache', '_npx')].filter(Boolean);
  for (const dir of npx.flatMap(subdirs)) {
    const pkg = dirents(path.join(dir, 'node_modules')).filter((d) => !d.name.startsWith('.')).map((d) => d.name)
      .find((n) => !n.startsWith('@')) || path.basename(dir);
    push(await pathItem('packages', 'npm', `npx: ${pkg}`, [dir], {
      lock: (c) => (c.procs.some((cmd) => cmd.includes(dir + path.sep)) ? 'Running now' : null),
    }));
  }

  // Hugging Face: one row per model or dataset.
  const hf = process.env.HF_HOME ? path.join(process.env.HF_HOME, 'hub') : path.join(XDG_CACHE, 'huggingface', 'hub');
  roots.add(path.dirname(hf));
  // Newer hub layouts keep files in a shared hub/blobs folder and link to them from each model's
  // snapshots, so a model's row includes the blobs only it uses.
  const repos = subdirs(hf).map((dir) => [dir, path.basename(dir).match(/^(models|datasets|spaces)--(.+)$/)]).filter(([, m]) => m);
  const blobUsers = new Map();
  const linksOf = (dir) => {
    const out = [];
    const walk = (p) => {
      for (const d of dirents(p)) {
        const q = path.join(p, d.name);
        if (d.isSymbolicLink()) { try { out.push(fs.realpathSync(q)); } catch {} } else if (d.isDirectory()) walk(q);
      }
    };
    walk(path.join(dir, 'snapshots'));
    return out.filter((t) => t.startsWith(path.join(hf, 'blobs') + path.sep));
  };
  const links = new Map(repos.map(([dir]) => [dir, linksOf(dir)]));
  for (const [dir, list] of links) for (const b of list) blobUsers.set(b, [...(blobUsers.get(b) || []), dir]);
  for (const [dir, m] of repos) {
    const own = [...new Set(links.get(dir))].filter((b) => blobUsers.get(b).length === 1);
    const shared = links.get(dir).length - own.length;
    push(await pathItem('models', 'Hugging Face', m[2].replace('--', '/'), [dir, ...own], {
      sub: tilde(dir), badges: [{ text: m[1].replace(/s$/, '') }, ...(shared ? [{ text: `${shared} files shared with other models` }] : [])],
    }));
  }
  push(await pathItem('models', 'Hugging Face', 'Other Hugging Face files', subdirs(path.join(XDG_CACHE, 'huggingface')).filter((p) => p !== hf)));

  // Playwright / Puppeteer: newest build of each browser is marked, older ones go first.
  for (const [tool, root] of [
    ['Playwright', process.env.PLAYWRIGHT_BROWSERS_PATH || (MAC ? path.join(LIB, 'Caches', 'ms-playwright') : WIN ? path.join(LOCAL, 'ms-playwright') : path.join(XDG_CACHE, 'ms-playwright'))],
    ['Puppeteer', path.join(XDG_CACHE, 'puppeteer')],
  ]) {
    roots.add(path.dirname(root));
    const builds = subdirs(root);
    const newest = new Map();
    for (const b of builds) {
      const [, kind, ver] = path.basename(b).match(/^(.*?)[-_]?(\d[\d.]*)$/) || [null, path.basename(b), '0'];
      if (!newest.has(kind) || verCmp(ver, newest.get(kind)) > 0) newest.set(kind, ver);
    }
    for (const b of builds) {
      const [, kind, ver] = path.basename(b).match(/^(.*?)[-_]?(\d[\d.]*)$/) || [null, path.basename(b), '0'];
      const old = newest.get(kind) !== ver;
      push(await pathItem('browsers', tool, path.basename(b), [b], { orphan: old, badges: [{ text: old ? 'older build' : 'newest build', kind: old ? 'warn' : '' }] }));
    }
  }

  // Xcode DerivedData: one row per project build.
  for (const dir of subdirs(mac('Developer', 'Xcode', 'DerivedData') || '')) {
    if (path.basename(dir) === 'ModuleCache.noindex') continue;
    const ws = readText(path.join(dir, 'info.plist'))?.match(/<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    const gone = ws ? !exists(ws) : false;
    push(await pathItem('build', 'Xcode', `DerivedData: ${path.basename(dir).replace(/-[a-z]{28}$/, '')}`, [dir], {
      sub: ws ? tilde(ws) : undefined, orphan: gone, badges: gone ? [{ text: 'project gone', kind: 'warn' }] : [],
    }));
  }

  // Python environments.
  const { nodeModules, venvs } = findProjects();
  const pyenvGlobal = readText(home('.pyenv', 'version'))?.trim().split('\n')[0];
  const envSources = [
    ...subdirs(home('.virtualenvs')).filter(isVenv).map((p) => ['virtualenv', p]),
    ...subdirs(home('.pyenv', 'versions')).map((p) => ['pyenv', p]),
    ...['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge'].flatMap((c) => subdirs(home(c, 'envs')).map((p) => ['conda', p])),
    ...venvs.map((p) => ['project venv', p]),
  ];
  for (const [kind, p] of envSources) {
    const py = venvPython(p);
    const project = kind === 'project venv' ? path.dirname(p) : null;
    const isGlobal = kind === 'pyenv' && path.basename(p) === pyenvGlobal;
    const badges = [{ text: kind }];
    if (py) badges.push({ text: `Python ${py}` });
    // Last use: newest of the env folder, its bin and site-packages (not every file).
    const used = Math.max(mtimeOf(p), mtimeOf(path.join(p, 'bin')), ...dirents(path.join(p, 'lib')).map((d) => mtimeOf(path.join(p, 'lib', d.name, 'site-packages'))));
    push(await pathItem('envs', kind === 'project venv' ? 'Projects' : kind, kind === 'project venv' ? `${path.basename(project)}/${path.basename(p)}` : path.basename(p), [p], {
      mtime: used, badges,
      lock: isGlobal ? () => 'pyenv global version' : envLock(p),
    }));
  }

  // node_modules: "last used" is when packages were last installed there.
  for (const p of nodeModules) {
    const project = path.dirname(p);
    const item = await pathItem('node_modules', 'Projects', path.basename(project), [p], { sub: tilde(project) });
    if (item) { item.mtime = mtimeOf(p); push(item); }
  }

  // Anything else in ~/.cache, one row per folder.
  for (const d of dirents(XDG_CACHE)) {
    if (!d.isDirectory() || HANDLED_IN_CACHE.has(d.name)) continue;
    push(await pathItem('other', '~/.cache', d.name, [path.join(XDG_CACHE, d.name)], {
      lock: (c) => (c.procs.some((cmd) => cmd.includes(path.join(XDG_CACHE, d.name) + path.sep)) ? 'In use by a running program' : null),
    }));
  }

  return { categories: CATEGORIES, items, roots: [...roots], prune: [] };
}
