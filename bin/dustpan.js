#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, PORTS, startServer } from '../server/server.js';
import { openChrome } from '../server/chrome.js';
import * as db from '../server/db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = path.join(db.HOME, 'dustpan.log');
const USAGE = `Usage:
  dustpan            start in the background (or reuse the running one) and open the page
  dustpan --verbose  run in this terminal with logs (Ctrl+C to stop)
  dustpan status     show whether it's running
  dustpan stop       stop it`;

const pageUrl = (port) => `http://127.0.0.1:${port}/`;

// What's on that port, if it's a dustpan. 404s, non-JSON and other apps all count as "not dustpan".
async function signature(port) {
  try {
    const res = await fetch(`${pageUrl(port)}api/signature`, { signal: AbortSignal.timeout(700) });
    const body = await res.json();
    return body?.app === APP ? body : null;
  } catch {
    return null;
  }
}

// The saved instance, only if the process on its port proves it's that same instance.
async function running() {
  const saved = db.instance.get();
  if (!saved) return null;
  const sig = await signature(saved.port);
  if (sig?.instance === saved.instance) return { ...saved, version: sig.version };
  db.instance.clear(saved.instance);
  return null;
}

async function waitFor(instanceId, ms = 6000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) {
    const saved = db.instance.get();
    if (saved?.instance === instanceId && (await signature(saved.port))?.instance === instanceId) return saved;
  }
  return null;
}

async function open(port) {
  if (process.env.DUSTPAN_NO_BROWSER) return;
  try {
    await openChrome({ url: pageUrl(port) });
  } catch {
    console.log(`Couldn't open Chrome. Open ${pageUrl(port)} yourself.`);
  }
}

async function start({ verbose }) {
  const existing = await running();
  if (existing) {
    console.log(`Dustpan is already running at ${pageUrl(existing.port)} (pid ${existing.pid}). Opening it.`);
    return open(existing.port);
  }
  if (verbose) {
    const { port } = await startServer({ verbose: true });
    return open(port);
  }
  const instanceId = crypto.randomUUID();
  const out = fs.openSync(LOG_FILE, 'a');
  spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, DUSTPAN_INSTANCE: instanceId },
  }).unref();
  const started = await waitFor(instanceId);
  if (!started) {
    console.error(`Dustpan didn't start (ports ${PORTS[0]}–${PORTS.at(-1)} may all be busy). See ${LOG_FILE}`);
    process.exit(1);
  }
  console.log(`Dustpan running at ${pageUrl(started.port)} (pid ${started.pid}).
Stop it with Quit Dustpan on the page or \`dustpan stop\`. Logs: ${LOG_FILE}`);
  return open(started.port);
}

async function status() {
  const r = await running();
  console.log(r ? `Running at ${pageUrl(r.port)} (pid ${r.pid}, version ${r.version}).` : 'Not running.');
}

async function stop() {
  const r = await running();
  if (!r) return console.log('Dustpan is not running.');
  await fetch(`${pageUrl(r.port)}api/quit`, { method: 'POST', headers: { 'x-dustpan': '1' } });
  console.log('Dustpan stopped.');
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) console.log(USAGE);
else if (args[0] === 'stop') await stop();
else if (args[0] === 'status') await status();
else if (args.length && !args.every((a) => ['--verbose', '-v'].includes(a))) {
  console.error(USAGE);
  process.exit(1);
} else await start({ verbose: args.length > 0 });
