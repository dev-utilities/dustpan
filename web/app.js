const $ = (id) => document.getElementById(id);
const DAY = 24 * 60 * 60 * 1000;
const STATUS_TEXT = { queued: 'Waiting', deleting: 'Deleting…', deleted: 'Deleted', failed: 'Failed', skipped: 'Skipped' };

// ---- Server connection ----
// Calls go page → server → the chosen Chrome profile's extension, and replies come back the same way.
const pending = new Map();
let seq = 0;
let socket = null;
let quitting = false;

function connectServer() {
  socket = new WebSocket(`ws://${location.host}/ws/page`);
  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'profiles') return onProfiles(msg.profiles);
    if (msg.type !== 'reply') return;
    const call = pending.get(msg.id);
    if (!call) return;
    if ('event' in msg) return call.onEvent?.(msg.event);
    pending.delete(msg.id);
    if ('error' in msg) call.reject(new Error(msg.error));
    else call.resolve(msg.result);
  };
  socket.onclose = () => {
    for (const call of pending.values()) call.reject(new Error('Dustpan stopped.'));
    pending.clear();
    showStopped();
  };
}

function call(action, params = {}, { onEvent } = {}) {
  return new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) return reject(new Error('Not connected to dustpan.'));
    const id = ++seq;
    pending.set(id, { resolve, reject, onEvent });
    socket.send(JSON.stringify({ type: 'call', id, profile: profileId, action, params }));
  });
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dustpan': '1' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function showStopped() {
  $('stopped').hidden = false;
  if (quitting) return;
  // Reload if a dustpan comes back on this port.
  setInterval(async () => {
    try {
      if ((await (await fetch('/api/signature')).json()).app === 'dustpan') location.reload();
    } catch {}
  }, 3000);
}

// ---- State ----
let info = {};
let profiles = [];
let profileId = null;
let profileWasOnline = false;
let accounts = [];
const chosenAccounts = new Set();
let chats = [];
const selected = new Set();
const rows = new Map();
let running = false;

const currentProfile = () => profiles.find((p) => p.id === profileId) ?? null;
const emailOf = (index) => accounts.find((a) => a.index === index)?.email ?? `u/${index}`;
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

function profileName(p) {
  const hint = p.googleAccounts?.[0];
  return p.nickname || p.chromeName || p.chromeEmail || (hint ? `Profile with ${hint}` : `Profile ${p.id.slice(0, 6)}`);
}

// ---- Chrome profiles ----
function onProfiles(list) {
  profiles = list;
  if (!profiles.some((p) => p.id === profileId)) {
    const saved = profiles.find((p) => p.id === info.selectedProfile);
    profileId = (saved ?? profiles.find((p) => p.online) ?? profiles[0])?.id ?? null;
  }
  renderProfiles();
}

function renderProfiles() {
  const select = $('profile');
  select.disabled = profiles.length === 0 || running;
  select.replaceChildren(...(profiles.length
    ? profiles.map((p) => new Option(`${profileName(p)}${p.online ? '' : ' (offline)'}`, p.id))
    : [new Option('None connected yet', '')]));
  select.value = profileId ?? '';

  const p = currentProfile();
  $('profile-state').textContent = p ? (p.online ? 'Connected' : 'Offline') : '';
  $('profile-state').className = `state ${p?.online ? 'online' : ''}`;
  $('profile-state').hidden = !p;
  $('rename').hidden = !p || !$('rename-form').hidden;

  $('setup').hidden = profiles.length > 0;
  $('chrome-closed').hidden = info.chromeRunning !== false;
  $('offline').hidden = !p || p.online;
  $('gemini-body').hidden = !p?.online;
  if (p && !p.online) {
    $('offline-title').textContent = `${profileName(p)} isn't connected`;
    $('open-profile').textContent = p.profileDir ? 'Open this profile in Chrome' : 'Open Chrome';
  }
  if (!p?.online) $('actionbar').hidden = true;

  // Load accounts when the chosen profile comes online.
  const online = !!p?.online;
  if (online && !profileWasOnline) loadAccounts();
  profileWasOnline = online;
}

function selectProfile(id) {
  profileId = id;
  profileWasOnline = false;
  accounts = [];
  chosenAccounts.clear();
  chats = [];
  selected.clear();
  $('accounts').replaceChildren();
  $('chats-block').hidden = true;
  $('actionbar').hidden = true;
  api('/api/settings', { key: 'selectedProfile', value: id }).catch(() => {});
  info.selectedProfile = id;
  renderProfiles();
}

// ---- Accounts ----
async function loadAccounts() {
  $('accounts-status').textContent = 'Finding Google accounts in this profile…';
  $('accounts').replaceChildren();
  $('load-chats').disabled = true;
  const forProfile = profileId;
  try {
    accounts = await call('gemini.accounts');
  } catch (err) {
    if (forProfile === profileId) {
      $('accounts-status').textContent = `Couldn't read accounts: ${err.message} Make sure this profile is signed in to Google.`;
    }
    return;
  }
  if (forProfile !== profileId) return;
  // Keep earlier picks across a reconnect, minus accounts that signed out.
  for (const index of chosenAccounts) if (!accounts.some((a) => a.index === index)) chosenAccounts.delete(index);
  $('load-chats').disabled = chosenAccounts.size === 0 || running;
  $('accounts-status').textContent = `${accounts.length} signed in. Pick the ones to clean.`;
  $('accounts').replaceChildren(...accounts.map((a) => {
    const label = document.createElement('label');
    label.className = 'account';
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', value: a.index, checked: chosenAccounts.has(a.index) });
    box.addEventListener('change', () => {
      box.checked ? chosenAccounts.add(a.index) : chosenAccounts.delete(a.index);
      $('load-chats').disabled = chosenAccounts.size === 0 || running;
    });
    const text = document.createElement('span');
    text.append(a.email, Object.assign(document.createElement('small'), { textContent: `Google account u/${a.index}` }));
    label.append(box, text);
    return label;
  }));
}

async function loadChats() {
  $('load-chats').disabled = true;
  $('chats-block').hidden = false;
  $('chats-status').textContent = 'Loading chats…';
  chats = [];
  selected.clear();
  renderChats();
  const failures = [];
  for (const account of [...chosenAccounts].sort()) {
    try {
      const list = await call('gemini.chats', { account });
      chats.push(...list.map((c) => ({ ...c, state: null, error: null })));
    } catch (err) {
      failures.push(`${emailOf(account)}: ${err.message}`);
    }
  }
  chats.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  $('chats-status').textContent = `${chats.length} chats in ${chosenAccounts.size} account${chosenAccounts.size === 1 ? '' : 's'}.`
    + (failures.length ? ` Couldn't load ${failures.join('; ')}` : '');
  $('load-chats').disabled = false;
  $('actionbar').hidden = false;
  renderChats();
}

// ---- Chats table ----
function visibleChats() {
  const needle = $('search').value.trim().toLowerCase();
  const days = Number($('age').value);
  const cutoff = Date.now() - days * DAY;
  return chats.filter((c) => (!needle || c.title.toLowerCase().includes(needle))
    && (!days || (c.updated && c.updated < cutoff)));
}

function renderRow(tr, c) {
  tr.classList.toggle('is-deleted', c.state === 'deleted');
  const box = tr.querySelector('input');
  box.checked = selected.has(c.id);
  box.disabled = c.state === 'deleted' || running;
  const status = tr.querySelector('.status');
  status.className = `status ${c.state ?? ''}`;
  status.textContent = STATUS_TEXT[c.state] ?? '';
  status.title = c.error ?? '';
}

function renderChats() {
  rows.clear();
  const shown = visibleChats();
  $('chat-rows').replaceChildren(...shown.map((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="c-check"><input type="checkbox"></td>
      <td><span class="title"></span></td><td class="account-cell"></td>
      <td class="date-cell"></td><td><span class="status"></span></td>`;
    tr.querySelector('input').setAttribute('aria-label', `Select ${c.title}`);
    tr.querySelector('.title').textContent = c.title;
    tr.querySelector('.title').title = c.title;
    if (c.pinned) tr.children[1].append(Object.assign(document.createElement('span'), { className: 'pin', textContent: 'pinned' }));
    tr.querySelector('.account-cell').textContent = emailOf(c.account);
    tr.querySelector('.date-cell').textContent = fmtDate(c.updated);
    tr.addEventListener('click', (e) => {
      if (running || c.state === 'deleted') return;
      if (e.target.tagName !== 'INPUT') tr.querySelector('input').checked = !selected.has(c.id);
      tr.querySelector('input').checked ? selected.add(c.id) : selected.delete(c.id);
      updateSelection();
    });
    rows.set(c.id, tr);
    renderRow(tr, c);
    return tr;
  }));
  $('empty').hidden = shown.length > 0 || chats.length === 0;
  updateSelection();
}

function updateSelection() {
  const n = selected.size;
  $('selection-count').textContent = n ? `${n} chat${n === 1 ? '' : 's'} selected` : 'Select chats to delete';
  $('delete').textContent = n ? `Delete ${n} chat${n === 1 ? '' : 's'}` : 'Delete chats';
  $('delete').disabled = n === 0 || running;
  const selectable = visibleChats().filter((c) => c.state !== 'deleted');
  const box = $('select-shown');
  box.checked = selectable.length > 0 && selectable.every((c) => selected.has(c.id));
  box.indeterminate = !box.checked && selectable.some((c) => selected.has(c.id));
  box.disabled = running || selectable.length === 0;
}

function setRunning(on) {
  running = on;
  $('stop').hidden = !on;
  $('search').disabled = $('age').disabled = on;
  $('load-chats').disabled = on || chosenAccounts.size === 0;
  $('accounts').querySelectorAll('input').forEach((el) => { el.disabled = on; });
  $('profile').disabled = on || profiles.length === 0;
  for (const c of chats) if (rows.has(c.id)) renderRow(rows.get(c.id), c);
  updateSelection();
}

// ---- Delete ----
async function deleteSelected() {
  const targets = chats.filter((c) => selected.has(c.id) && c.state !== 'deleted');
  if (!targets.length) return;
  if (!confirm(`Delete ${targets.length} Gemini chat${targets.length === 1 ? '' : 's'}? This can't be undone.`)) return;
  const byId = new Map(targets.map((c) => [c.id, c]));
  for (const c of targets) { c.state = 'queued'; c.error = null; }
  setRunning(true);
  $('chats-status').textContent = `Deleting ${targets.length} chats…`;
  try {
    const summary = await call('gemini.delete', { items: targets.map(({ account, id }) => ({ account, id })) }, {
      onEvent: ({ id, state, error }) => {
        const c = byId.get(id);
        if (!c) return;
        c.state = state;
        c.error = error ?? null;
        if (state === 'deleted') selected.delete(id);
        if (rows.has(id)) renderRow(rows.get(id), c);
        updateSelection();
      },
    });
    $('chats-status').textContent = `Deleted ${summary.deleted}`
      + (summary.failed ? `, ${summary.failed} failed (hover a status to see why)` : '')
      + (summary.stopped ? '. Stopped before the rest.' : '.');
  } catch (err) {
    $('chats-status').textContent = `Deleting stopped: ${err.message}`;
    for (const c of targets) {
      if (c.state === 'queued' || c.state === 'deleting') { c.state = 'failed'; c.error = err.message; }
    }
  } finally {
    setRunning(false);
  }
}

// ---- Wiring ----
document.querySelectorAll('.tool').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('is-active', b === btn));
  const isGemini = btn.dataset.tool === 'gemini';
  $('panel-gemini').hidden = !isGemini;
  $('panel-soon').hidden = isGemini;
  $('soon-title').textContent = btn.firstChild.textContent.trim();
  if (!isGemini) $('actionbar').hidden = true;
  else if (chats.length && currentProfile()?.online) $('actionbar').hidden = false;
}));

$('quit').addEventListener('click', async () => {
  if (running && !confirm('Chats are still being deleted. Quit anyway?')) return;
  quitting = true;
  try { await api('/api/quit', {}); } catch {}
  showStopped();
});

$('profile').addEventListener('change', (e) => selectProfile(e.target.value));
$('rename').addEventListener('click', () => {
  $('nickname').value = currentProfile()?.nickname ?? '';
  $('rename-form').hidden = false;
  $('rename').hidden = true;
  $('nickname').focus();
});
$('rename-cancel').addEventListener('click', () => {
  $('rename-form').hidden = true;
  renderProfiles();
});
$('rename-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/profiles/nickname', { id: profileId, nickname: $('nickname').value });
  $('rename-form').hidden = true;
  renderProfiles();
});
$('open-chrome').addEventListener('click', () => api('/api/chrome/open', {}));
$('open-profile').addEventListener('click', () => api('/api/chrome/open', { profileId }));
$('forget-profile').addEventListener('click', async () => {
  if (!confirm(`Forget ${profileName(currentProfile())}? It comes back if it connects again.`)) return;
  await api('/api/profiles/forget', { id: profileId });
});

$('load-chats').addEventListener('click', loadChats);
$('search').addEventListener('input', renderChats);
$('age').addEventListener('change', renderChats);
$('delete').addEventListener('click', deleteSelected);
$('stop').addEventListener('click', () => call('stop'));
$('select-shown').addEventListener('change', (e) => {
  for (const c of visibleChats()) {
    if (c.state === 'deleted') continue;
    e.target.checked ? selected.add(c.id) : selected.delete(c.id);
  }
  renderChats();
});

// Chrome may open or close while the page is up.
async function refreshInfo() {
  try {
    info = { ...info, ...(await api('/api/info')) };
    $('ext-path').textContent = info.extensionPath;
    renderProfiles();
  } catch {}
}

await refreshInfo();
connectServer();
setInterval(refreshInfo, 5000);
// The server drops connections that stay silent for 60s.
setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}'); }, 20000);
