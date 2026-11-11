// App caches: VS Code-style editors, Electron/Chromium apps (Teams, Postman, Slack, browsers…),
// each app's folder in ~/Library/Caches, logs and old temp files. Only caches: sign-ins,
// settings and app data are never touched (unlike wiping a whole app container).
import os from 'node:os';
import path from 'node:path';
import {
  HOME, MAC, WIN, LIB, LOCAL, ROAMING, DAY, exists, tilde, readJson, dirents, subdirs, mtimeOf, sizeOf, pathItem, runningGate,
} from './util.js';

const CATEGORIES = [
  { id: 'editors', label: 'Code editors', desc: 'VS Code, Cursor and similar: caches, old builds, logs and saved state of workspaces.' },
  { id: 'apps', label: 'App web caches', desc: 'Browser caches inside Teams, Postman, Slack, Chrome and other apps. Sign-ins and data stay.' },
  { id: 'library', label: 'Caches folder', desc: "Each app's own cache folder. Apps rebuild them; update downloads (ShipIt) are left from past updates." },
  { id: 'logs', label: 'Logs & crash reports', desc: 'App log folders and crash reports.' },
  { id: 'temp', label: 'Old temp files', desc: 'Temp files not touched for a week.' },
];

const appSupport = (...p) => (MAC ? path.join(LIB, 'Application Support', ...p) : WIN ? path.join(ROAMING, ...p) : path.join(HOME, '.config', ...p));
const running = (bundle) => (procs) => procs.some((c) => c.includes(`/${bundle}/`));

// Editors that share VS Code's folder layout.
const EDITORS = [
  { name: 'VS Code', dir: 'Code', bundle: 'Visual Studio Code.app' },
  { name: 'VS Code Insiders', dir: 'Code - Insiders', bundle: 'Visual Studio Code - Insiders.app' },
  { name: 'Cursor', dir: 'Cursor', bundle: 'Cursor.app' },
  { name: 'Windsurf', dir: 'Windsurf', bundle: 'Windsurf.app' },
  { name: 'VSCodium', dir: 'VSCodium', bundle: 'VSCodium.app' },
];

// Chromium-based apps: where their data lives and the app bundle to tell if they run.
const CHROMIUM_APPS = [
  { name: 'Microsoft Teams', bundle: 'Microsoft Teams.app', roots: [MAC && path.join(LIB, 'Group Containers', 'UBF8T346G9.com.microsoft.teams'), MAC && path.join(LIB, 'Containers', 'com.microsoft.teams2'), appSupport('Microsoft', 'Teams'), WIN && path.join(LOCAL, 'Packages', 'MSTeams_8wekyb3d8bbwe')] },
  { name: 'Postman', bundle: 'Postman.app', roots: [appSupport('Postman')] },
  { name: 'Slack', bundle: 'Slack.app', roots: [appSupport('Slack'), MAC && path.join(LIB, 'Containers', 'com.tinyspeck.slackmacgap')] },
  { name: 'Discord', bundle: 'Discord.app', roots: [appSupport('discord')] },
  { name: 'Notion', bundle: 'Notion.app', roots: [appSupport('Notion')] },
  { name: 'Figma', bundle: 'Figma.app', roots: [appSupport('Figma')] },
  { name: 'WhatsApp', bundle: 'WhatsApp.app', roots: [appSupport('WhatsApp')] },
  { name: 'Google Chrome', bundle: 'Google Chrome.app', roots: [appSupport('Google', 'Chrome'), WIN && path.join(LOCAL, 'Google', 'Chrome', 'User Data')] },
  { name: 'Brave', bundle: 'Brave Browser.app', roots: [appSupport('BraveSoftware', 'Brave-Browser'), WIN && path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')] },
  { name: 'Microsoft Edge', bundle: 'Microsoft Edge.app', roots: [appSupport('Microsoft Edge'), WIN && path.join(LOCAL, 'Microsoft', 'Edge', 'User Data')] },
];
const CACHE_DIRS = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache', 'ShaderCache', 'GrShaderCache', 'GPUPersistentCache', 'component_crx_cache']);
const SW_CACHES = ['CacheStorage', 'ScriptCache'];

// ~/Library/Caches folders other tools handle, or that macOS manages.
const LIBRARY_SKIP = /^(com\.apple\.|JetBrains$|claude-cli-nodejs$|pip$|pnpm$|Yarn$|Homebrew$|CocoaPods$|go-build$|pypoetry$|ms-playwright$|node-gyp$|uv$|CloudKit$|FamilyCircle$|GeoServices$|familycircled$)/;
const FRIENDLY = {
  Google: 'Google (Chrome and other Google apps)', BraveSoftware: 'Brave', 'com.spotify.client': 'Spotify',
  'com.microsoft.VSCode': 'VS Code', 'com.tinyspeck.slackmacgap': 'Slack', 'com.postmanlabs.mac': 'Postman',
};
const LIBRARY_APPS = { Google: 'Google Chrome.app', BraveSoftware: 'Brave Browser.app', 'com.microsoft.VSCode': 'Visual Studio Code.app', 'com.spotify.client': 'Spotify.app' };

// Cache folders inside a Chromium app's data, grouped by the profile/partition folder that holds them.
function chromiumCaches(root, depth = 5) {
  const groups = new Map();
  const walk = (dir, d) => {
    for (const e of dirents(dir)) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (CACHE_DIRS.has(e.name)) { groups.set(dir, [...(groups.get(dir) || []), p]); continue; }
      if (e.name === 'Service Worker') {
        for (const sw of SW_CACHES) if (exists(path.join(p, sw))) groups.set(dir, [...(groups.get(dir) || []), path.join(p, sw)]);
        continue;
      }
      if (d > 0 && !['IndexedDB', 'Local Storage', 'Extensions', 'File System', 'databases', 'blob_storage'].includes(e.name)) walk(p, d - 1);
    }
  };
  walk(root, depth);
  return groups;
}

export async function scan(ctx) {
  const { procs } = ctx;
  const items = [];
  const roots = new Set();
  const push = (item, isRunning, app) => item && items.push(runningGate(item, isRunning, app));

  for (const ed of EDITORS) {
    const base = appSupport(ed.dir);
    if (!exists(base)) continue;
    roots.add(base);
    const live = running(ed.bundle)(procs);
    const at = (...p) => path.join(base, ...p);
    push(await pathItem('editors', ed.name, 'Web and GPU caches', ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary'].map((n) => at(n))), live, ed.name);
    // CachedData keeps compiled code per build; only the newest build's is used.
    const builds = subdirs(at('CachedData')).sort((a, b) => mtimeOf(b) - mtimeOf(a));
    if (builds.length > 1) push(await pathItem('editors', ed.name, 'Compiled code of old builds', builds.slice(1), { sub: tilde(at('CachedData')), badges: [{ text: `${builds.length - 1} old build${builds.length > 2 ? 's' : ''}` }] }), live, ed.name);
    push(await pathItem('editors', ed.name, 'Downloaded extension packages', [at('CachedExtensionVSIXs')]), live, ed.name);
    push(await pathItem('editors', ed.name, 'Logs', [at('logs')]), live, ed.name);
    // Saved state per opened folder; the ones for deleted folders are pure leftovers.
    for (const ws of subdirs(at('User', 'workspaceStorage'))) {
      const meta = readJson(path.join(ws, 'workspace.json'));
      const uri = meta?.folder || meta?.workspace || '';
      let folder = null;
      try { folder = uri.startsWith('file://') ? decodeURIComponent(new URL(uri).pathname) : null; } catch {}
      if (WIN && folder) folder = folder.replace(/^\/([A-Za-z]:)/, '$1');
      const gone = folder ? !exists(folder) : false;
      const label = folder ? path.basename(folder) : uri ? uri.replace(/^[a-z-]+:\/\//, '').slice(0, 60) : path.basename(ws);
      push(await pathItem('editors', ed.name, `Workspace state: ${label}`, [ws], {
        sub: folder ? tilde(folder) : tilde(ws), orphan: gone,
        badges: [gone ? { text: 'folder gone', kind: 'warn' } : { text: 'search index, history, extension state' }],
      }), live, ed.name);
    }
  }

  for (const app of CHROMIUM_APPS) {
    const live = running(app.bundle)(procs);
    for (const root of app.roots.filter((r) => r && exists(r))) {
      roots.add(root);
      for (const [parent, dirs] of chromiumCaches(root)) {
        const rel = path.relative(root, parent) || 'main';
        const kinds = [...new Set(dirs.map((d) => (SW_CACHES.includes(path.basename(d)) ? 'site offline cache' : /GPU|Dawn|Shader|Graphite/.test(d) ? 'GPU' : path.basename(d) === 'Code Cache' ? 'script' : 'web')))];
        push(await pathItem('apps', app.name, `${app.name} · ${rel.length > 40 ? `${rel.slice(0, 37)}…` : rel}`, dirs, {
          sub: tilde(parent), badges: kinds.map((k) => ({ text: k })),
        }), live, app.name);
      }
    }
  }

  if (MAC) {
    const caches = path.join(LIB, 'Caches');
    roots.add(caches);
    for (const d of dirents(caches)) {
      if (!d.isDirectory() || LIBRARY_SKIP.test(d.name)) continue;
      const shipIt = /\.ShipIt$/.test(d.name);
      const base = d.name.replace(/\.ShipIt$/, '');
      const label = shipIt ? `${FRIENDLY[base] || base} update downloads` : FRIENDLY[d.name] || d.name;
      const bundle = LIBRARY_APPS[d.name];
      push(await pathItem('library', 'Caches', label, [path.join(caches, d.name)], {
        badges: shipIt ? [{ text: 'old update download' }] : [],
      }), bundle ? running(bundle)(procs) : false, FRIENDLY[d.name] || d.name);
    }
    const logs = path.join(LIB, 'Logs');
    roots.add(logs);
    for (const d of dirents(logs)) {
      if (!d.isDirectory() || ['JetBrains', 'Claude', 'DiagnosticReports'].includes(d.name)) continue;
      push(await pathItem('logs', 'Logs', d.name, [path.join(logs, d.name)]));
    }
    const reports = path.join(logs, 'DiagnosticReports');
    const files = dirents(reports).filter((d) => d.isFile() && !/^Claude/i.test(d.name)).map((d) => path.join(reports, d.name));
    push(await pathItem('logs', 'Logs', 'Crash and hang reports', files, { sub: tilde(reports) }));
  }

  // Temp files untouched for a week (not the Claude temp folder; the Claude tool owns it).
  const tmp = os.tmpdir();
  roots.add(tmp);
  // Judged by the newest file inside, so a folder still being written to stays.
  const stale = [];
  for (const p of dirents(tmp).map((d) => path.join(tmp, d.name))) {
    if (/claude-\d+$/.test(p)) continue;
    const { mtime } = await sizeOf(p);
    if (mtime && mtime < Date.now() - 7 * DAY) stale.push(p);
  }
  push(await pathItem('temp', 'Temp', 'Temp files older than a week', stale, { sub: tilde(tmp), inUse: true }));

  return { categories: CATEGORIES, optIns: [{ id: 'running', label: 'Allow apps that are open (close them soon after, or they may misbehave)' }], items, roots: [...roots], prune: [] };
}
