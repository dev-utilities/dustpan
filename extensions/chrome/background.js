// Background worker, one per Chrome profile. Finds the local dustpan server, connects
// over a WebSocket and runs its commands inside a background Gemini tab, so they use
// this profile's Google sign-ins.

// Must match PORTS in server/server.js.
const PORTS = Array.from({ length: 10 }, (_, i) => 47321 + i);
const GEMINI_URL = 'https://gemini.google.com/app';
const DELETE_DELAY_MS = 250;
const KEEPALIVE_MS = 20000; // An active WebSocket keeps the worker alive if it talks at least every 30s.
const WORKER_TAB_IDLE_MS = 60000;

let ws = null;
let connecting = false;
let stopRequested = false;
let opening = null;
let idleTimer = null;

// ---- Identity of this profile ----
async function profileId() {
  const { profileId: id } = await chrome.storage.local.get('profileId');
  if (id) return id;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ profileId: fresh });
  return fresh;
}

async function chromeEmail() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    return info.email || null;
  } catch {
    return null;
  }
}

// ---- Connection to the server ----
async function findServer() {
  for (const port of PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/signature`, { signal: AbortSignal.timeout(500) });
      if ((await res.json())?.app === 'dustpan') return port;
    } catch {}
  }
  return null;
}

async function connect() {
  if (ws || connecting) return;
  connecting = true;
  try {
    const port = await findServer();
    chrome.action.setBadgeText({ text: port ? '' : 'off' });
    if (!port) return;
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/ext`);
    ws = sock;
    sock.onopen = async () => {
      sock.send(JSON.stringify({
        type: 'hello',
        profileId: await profileId(),
        version: chrome.runtime.getManifest().version,
        chromeEmail: await chromeEmail(),
      }));
    };
    sock.onmessage = (e) => onServerMessage(JSON.parse(e.data));
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      stopRequested = true;
      chrome.action.setBadgeText({ text: 'off' });
      setTimeout(connect, 2000);
    };
  } finally {
    connecting = false;
  }
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function onServerMessage(msg) {
  if (msg.type === 'reload') return chrome.runtime.reload();
  if (msg.type !== 'call') return;
  const { id, action, params } = msg;
  const handler = handlers[action];
  if (!handler) return send({ type: 'reply', id, error: `Unknown action: ${action}` });
  try {
    send({ type: 'reply', id, result: await handler(params || {}, (event) => send({ type: 'reply', id, event })) });
  } catch (err) {
    send({ type: 'reply', id, error: String(err?.message || err) });
  }
}

// ---- Background Gemini tab ----
async function waitForLoad(tabId, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    if ((await chrome.tabs.get(tabId)).status === 'complete') return;
  }
  throw new Error('Gemini took too long to load.');
}

async function geminiTab() {
  clearTimeout(idleTimer);
  const { workerTabId } = await chrome.storage.session.get('workerTabId');
  if (workerTabId != null) {
    try {
      const tab = await chrome.tabs.get(workerTabId);
      if (tab.url?.startsWith('https://gemini.google.com/')) return workerTabId;
    } catch {}
  }
  // Parallel calls share one tab instead of each opening their own.
  opening ??= (async () => {
    let tab;
    try {
      tab = await chrome.tabs.create({ url: GEMINI_URL, active: false, pinned: true });
    } catch {
      // This profile has no open window.
      const win = await chrome.windows.create({ url: GEMINI_URL, focused: false, state: 'minimized' });
      [tab] = win.tabs;
    }
    await waitForLoad(tab.id);
    await chrome.storage.session.set({ workerTabId: tab.id });
    return tab.id;
  })().finally(() => { opening = null; });
  return opening;
}

function closeGeminiTabLater() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const { workerTabId } = await chrome.storage.session.get('workerTabId');
    await chrome.storage.session.remove('workerTabId');
    if (workerTabId != null) chrome.tabs.remove(workerTabId).catch(() => {});
  }, WORKER_TAB_IDLE_MS);
}

async function inGemini(method, args) {
  const tabId = await geminiTab();
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['gemini-api.js'] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (m, a) => {
        try { return { ok: true, value: await window.__dustpanGemini[m](...a) }; }
        catch (err) { return { ok: false, error: String(err?.message || err) }; }
      },
      args: [method, args],
    });
    if (!result?.ok) throw new Error(result?.error || `${method} failed`);
    return result.value;
  } finally {
    closeGeminiTabLater();
  }
}

// ---- Commands ----
const handlers = {
  'gemini.accounts': () => inGemini('listAccounts', []),
  'gemini.chats': ({ account }) => inGemini('listChats', [account]),
  // items: [{ account, id }]; reports each chat's state as it goes.
  'gemini.delete': async ({ items }, emit) => {
    stopRequested = false;
    const summary = { deleted: 0, failed: 0, stopped: false };
    for (const { account, id } of items) {
      if (stopRequested) {
        summary.stopped = true;
        emit({ id, state: 'skipped' });
        continue;
      }
      emit({ id, state: 'deleting' });
      try {
        await inGemini('deleteChat', [account, id]);
        summary.deleted++;
        emit({ id, state: 'deleted' });
      } catch (err) {
        summary.failed++;
        emit({ id, state: 'failed', error: err.message });
      }
      await new Promise((r) => setTimeout(r, DELETE_DELAY_MS));
    }
    return summary;
  },
  stop: () => { stopRequested = true; return true; },
};

// ---- Lifecycle ----
setInterval(() => send({ type: 'ping' }), KEEPALIVE_MS);
chrome.alarms.create('connect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'connect') connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.action.onClicked.addListener(async () => {
  const port = await findServer();
  if (port) chrome.tabs.create({ url: `http://127.0.0.1:${port}/` });
  else chrome.action.setTitle({ title: 'Dustpan is not running. Start it with `dustpan` in Terminal.' });
});
connect();
