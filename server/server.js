// Local HTTP + WebSocket server for the dustpan UI. Binds to 127.0.0.1 only.
//
// Pages connect to /ws/page, the Chrome extension (one per Chrome profile) to /ws/ext.
// The server relays a page's calls to the extension of the profile it picked.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as db from './db.js';
import { acceptWebSocket } from './ws.js';
import { chromeProfiles, isChromeRunning, openChrome } from './chrome.js';

export const APP = 'dustpan';
// The extension scans this range to find the server, so it must match background.js.
export const PORTS = Array.from({ length: 10 }, (_, i) => 47321 + i);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const webDir = path.join(root, 'web');
const extDir = path.join(root, 'extensions', 'chrome');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

// Read fresh each time so editing the extension makes connected copies reload.
const extVersion = () => JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8')).version;

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startServer({ verbose = false, instanceId = crypto.randomUUID() } = {}) {
  const log = verbose ? (...a) => console.log(new Date().toISOString(), ...a) : () => {};
  let port = null;
  const allowedHost = (host) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  const pageOrigin = (origin) => origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;

  // ---- Hub state ----
  const exts = new Map(); // profileId -> { conn, version }
  const pages = new Set();
  const pending = new Map(); // relay id -> { page, pageCallId, profileId, action }
  let nextId = 1;

  function profileList() {
    const named = chromeProfiles();
    return db.profiles.all().map((p) => {
      const chrome = p.chromeEmail ? named.find((c) => c.email === p.chromeEmail) : null;
      return {
        ...p,
        chromeName: chrome?.name ?? null,
        profileDir: chrome?.dir ?? null,
        online: exts.has(p.id),
        extVersion: exts.get(p.id)?.version ?? null,
      };
    });
  }
  const broadcast = () => {
    const msg = { type: 'profiles', profiles: profileList() };
    for (const page of pages) page.send(msg);
  };

  function onExtension(conn) {
    let profileId = null;
    conn.on('message', (msg) => {
      if (msg.type === 'hello') {
        if (typeof msg.profileId !== 'string' || !/^[\w-]{8,64}$/.test(msg.profileId)) return conn.close();
        profileId = msg.profileId;
        const expected = extVersion();
        if (msg.version !== expected) {
          log(`extension ${profileId} is ${msg.version}, files are ${expected}: asking it to reload`);
          conn.send({ type: 'reload' });
        }
        exts.get(profileId)?.conn.close();
        exts.set(profileId, { conn, version: msg.version });
        db.profiles.seen(profileId, { chromeEmail: msg.chromeEmail });
        log(`extension connected: ${profileId} (${msg.chromeEmail || 'no Chrome sign-in'})`);
        return broadcast();
      }
      if (msg.type === 'reply') {
        const call = pending.get(msg.id);
        if (!call) return;
        const { id, type, ...rest } = msg;
        call.page.send({ type: 'reply', id: call.pageCallId, ...rest });
        if ('event' in msg) return;
        pending.delete(msg.id);
        if (call.action === 'gemini.accounts' && Array.isArray(msg.result)) {
          db.profiles.setGoogleAccounts(call.profileId, msg.result.map((a) => a.email));
          broadcast();
        }
      }
    });
    conn.on('close', () => {
      if (!profileId || exts.get(profileId)?.conn !== conn) return;
      exts.delete(profileId);
      log(`extension disconnected: ${profileId}`);
      for (const [id, call] of pending) {
        if (call.profileId !== profileId) continue;
        call.page.send({ type: 'reply', id: call.pageCallId, error: 'The Chrome profile disconnected. Chrome may have closed.' });
        pending.delete(id);
      }
      broadcast();
    });
  }

  function onPage(conn) {
    pages.add(conn);
    conn.send({ type: 'profiles', profiles: profileList() });
    conn.on('message', (msg) => {
      if (msg.type !== 'call') return;
      const ext = exts.get(msg.profile);
      if (!ext) return conn.send({ type: 'reply', id: msg.id, error: "This Chrome profile isn't connected." });
      const id = nextId++;
      pending.set(id, { page: conn, pageCallId: msg.id, profileId: msg.profile, action: msg.action });
      ext.conn.send({ type: 'call', id, action: msg.action, params: msg.params || {} });
    });
    conn.on('close', () => {
      pages.delete(conn);
      for (const [id, call] of pending) {
        if (call.page !== conn) continue;
        // Nobody is watching any more, so don't keep deleting.
        if (call.action === 'gemini.delete') exts.get(call.profileId)?.conn.send({ type: 'call', id: nextId++, action: 'stop' });
        pending.delete(id);
      }
    });
  }

  // ---- HTTP ----
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutting down');
    db.instance.clear(instanceId);
    for (const { conn } of exts.values()) conn.close();
    for (const page of pages) page.close();
    server.close();
    setTimeout(() => process.exit(0), 100);
  }

  const routes = {
    'GET /api/signature': () => ({ app: APP, version: VERSION, instance: instanceId, pid: process.pid, port }),
    'GET /api/info': async () => ({
      extensionPath: extDir,
      extensionVersion: extVersion(),
      chromeRunning: await isChromeRunning(),
      selectedProfile: db.settings.get('selectedProfile'),
    }),
    'POST /api/quit': () => { setTimeout(shutdown, 50); return { ok: true }; },
    'POST /api/settings': ({ key, value }) => {
      if (!['selectedProfile'].includes(key)) throw new Error('unknown setting');
      db.settings.set(key, value);
      return { ok: true };
    },
    'POST /api/profiles/nickname': ({ id, nickname }) => {
      db.profiles.setNickname(id, String(nickname || '').trim().slice(0, 60));
      broadcast();
      return { ok: true };
    },
    'POST /api/profiles/forget': ({ id }) => {
      db.profiles.remove(id);
      broadcast();
      return { ok: true };
    },
    'POST /api/chrome/open': async ({ profileId }) => {
      const profile = profileId ? profileList().find((p) => p.id === profileId) : null;
      await openChrome({ profileDir: profile?.profileDir });
      return { ok: true };
    },
  };

  const server = http.createServer(async (req, res) => {
    // Blocks DNS rebinding: only answer requests addressed to this machine.
    if (!allowedHost(req.headers.host)) return json(res, 403, { error: 'forbidden host' });
    const { pathname } = new URL(req.url, `http://127.0.0.1:${port}`);
    if (pathname !== '/api/signature') log(req.method, pathname);

    // The extension probes this from its own origin to find the server; it holds nothing secret.
    if (req.method === 'GET' && pathname === '/api/signature') {
      return json(res, 200, routes['GET /api/signature'](), { 'access-control-allow-origin': '*' });
    }
    const route = routes[`${req.method} ${pathname}`];
    if (route) {
      // The custom header forces a CORS preflight, so other sites can't call POST routes.
      if (req.method === 'POST' && req.headers['x-dustpan'] !== '1') return json(res, 400, { error: 'missing x-dustpan header' });
      try {
        const body = req.method === 'POST' ? await readJson(req) : {};
        return json(res, 200, await route(body));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    const file = path.join(webDir, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(webDir + path.sep)) return json(res, 404, { error: 'not found' });
    try {
      const body = await fs.promises.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      json(res, 404, { error: 'not found' });
    }
  });

  server.on('upgrade', (req, socket) => {
    const { pathname } = new URL(req.url, `http://127.0.0.1:${port}`);
    const origin = req.headers.origin || '';
    // Browsers don't apply CORS to WebSockets, so check who is connecting.
    const ok = allowedHost(req.headers.host) && (
      (pathname === '/ws/page' && pageOrigin(origin))
      || (pathname === '/ws/ext' && origin.startsWith('chrome-extension://')));
    if (!ok) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const conn = acceptWebSocket(req, socket);
    if (!conn) return;
    if (pathname === '/ws/page') onPage(conn);
    else onExtension(conn);
  });

  for (const candidate of PORTS) {
    port = candidate;
    try {
      await listen(server, candidate);
      db.instance.set({ instance: instanceId, port, pid: process.pid });
      log(`dustpan ${VERSION} listening on http://127.0.0.1:${port}`);
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      return { server, port, instanceId };
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      log(`port ${candidate} is busy`);
    }
  }
  throw new Error(`No free port between ${PORTS[0]} and ${PORTS.at(-1)}.`);
}

// Run directly (this is how the launcher starts it in the background).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer({ verbose: true, instanceId: process.env.DUSTPAN_INSTANCE || undefined }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
