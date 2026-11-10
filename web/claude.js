// "Claude data" panel: scan Claude Code and Claude app data, filter it, and clean picked items.
const $ = (id) => document.getElementById(id);
const DAY = 24 * 60 * 60 * 1000;

let data = null; // last scan
let scanning = false;
let cleaning = false;
const activeCats = new Set();
const selected = new Set();
const collapsed = new Set();
const done = new Map(); // id -> { ok, error }

const fmtBytes = (n) => {
  if (n < 1000) return `${n} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1000; i++; } while (n >= 1000 && i < units.length - 1);
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
};
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k != null && k !== false));
  return node;
};

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dustpan': '1' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ---- Scan ----
async function scan() {
  if (scanning || cleaning) return;
  scanning = true;
  $('cl-rescan').disabled = true;
  $('cl-status').textContent = 'Scanning Claude folders…';
  try {
    data = await api('/api/claude/scan');
    if (!activeCats.size) data.categories.forEach((c) => activeCats.add(c.id));
    const ids = new Set(data.items.map((i) => i.id));
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
    done.clear();
    $('cl-mode').querySelector('[value=trash]').disabled = !data.trash;
    if (!data.trash) $('cl-mode').value = 'delete';
    renderSources();
    renderWhere();
    render();
    $('cl-actionbar').hidden = false;
  } catch (err) {
    $('cl-status').textContent = `Scan failed: ${err.message}`;
  } finally {
    scanning = false;
    $('cl-rescan').disabled = false;
  }
}

// ---- Filters ----
const allowLinked = () => $('cl-linked').checked;

// Why an item can't be picked right now, or null.
function blockedWhy(item) {
  if (done.get(item.id)?.ok) return 'Cleaned';
  if (item.lock) return item.lock;
  if (item.cat === 'transcripts' && item.flags.linked && !allowLinked()) return `Listed in ${item.flags.linked}`;
  return null;
}
const selectable = (item) => !blockedWhy(item) && !cleaning;

function visible() {
  if (!data) return [];
  const needle = $('cl-search').value.trim().toLowerCase();
  const where = $('cl-where').value;
  const days = Number($('cl-age').value);
  const min = Number($('cl-min').value);
  const orphans = $('cl-orphans').checked;
  const kept = $('cl-kept').checked;
  return data.items.filter((i) => activeCats.has(i.cat)
    && (!needle || `${i.label} ${i.sub} ${i.paths.join(' ')} ${i.where}`.toLowerCase().includes(needle))
    && (!where || i.where === where)
    && (!days || (i.mtime && i.mtime < Date.now() - days * DAY))
    && (!min || i.size >= min)
    && (!orphans || i.flags.orphan)
    && (kept || !i.lock || done.has(i.id)));
}

function sorted(list) {
  const by = $('cl-sort').value;
  const cmp = {
    size: (a, b) => b.size - a.size,
    old: (a, b) => (a.mtime || 0) - (b.mtime || 0),
    new: (a, b) => (b.mtime || 0) - (a.mtime || 0),
    name: (a, b) => a.label.localeCompare(b.label),
  }[by];
  return [...list].sort(cmp);
}

// ---- Rendering ----
function renderSources() {
  $('cl-apps').replaceChildren(...data.sources.map((s) => el('span', { className: `cl-app ${s.running ? 'is-running' : ''}`, title: s.dir },
    el('b', { textContent: s.name }),
    el('small', { textContent: s.running ? 'running: quit it to clean its caches and Cowork' : 'closed' }))));
}

function renderWhere() {
  const select = $('cl-where');
  const current = select.value;
  const places = [...new Set(data.items.map((i) => i.where))].sort();
  select.replaceChildren(new Option('everywhere', ''), ...places.map((p) => new Option(p, p)));
  select.value = places.includes(current) ? current : '';
}

function renderCats() {
  $('cl-cats').replaceChildren(...data.categories.map((c) => {
    const items = data.items.filter((i) => i.cat === c.id && !done.get(i.id)?.ok);
    const free = items.filter((i) => !i.lock).reduce((s, i) => s + i.size, 0);
    const btn = el('button', { className: 'cl-cat', type: 'button', title: c.desc },
      el('span', { className: 'cl-cat-name', textContent: c.label }),
      el('span', { className: 'cl-cat-size', textContent: fmtBytes(free) }),
      el('small', { textContent: `${plural(items.length, 'item')}${items.length - items.filter((i) => !i.lock).length ? `, ${items.filter((i) => i.lock).length} kept` : ''}` }));
    btn.setAttribute('aria-pressed', String(activeCats.has(c.id)));
    btn.addEventListener('click', () => {
      activeCats.has(c.id) ? activeCats.delete(c.id) : activeCats.add(c.id);
      render();
    });
    return btn;
  }));
}

function badge(text, kind = '') {
  return el('span', { className: `cl-badge ${kind}`, textContent: text });
}

function rowFor(item) {
  const why = blockedWhy(item);
  const result = done.get(item.id);
  const box = el('input', { type: 'checkbox', checked: selected.has(item.id), disabled: !selectable(item) });
  box.setAttribute('aria-label', `Select ${item.label}`);

  const flags = [];
  if (result) {
    const b = badge(result.ok ? 'Cleaned' : `Failed: ${result.error}`, result.ok ? 'ok' : 'warn');
    flags.push(b);
  } else if (why) flags.push(badge(why, 'lock'));
  if (item.flags.linked) flags.push(badge(`in ${item.flags.linked}${item.flags.archived ? ', archived' : ''}`));
  if (item.flags.orphan) flags.push(badge(item.flags.orphanWhy || (item.cat === 'transcripts' ? 'folder gone' : 'no conversation'), 'warn'));
  if (item.flags.images) flags.push(badge(plural(item.flags.images, 'image')));
  if (item.files > 1) flags.push(badge(plural(item.files, 'file')));

  const tr = el('tr', { className: `${why ? 'is-blocked' : ''} ${result?.ok ? 'is-deleted' : ''}` },
    el('td', { className: 'c-check' }, box),
    el('td', {},
      el('span', { className: 'title', textContent: item.label, title: item.label }),
      el('div', { className: 'cl-sub', textContent: item.sub, title: item.paths.join('\n') }),
      flags.length ? el('div', { className: 'cl-flags' }, ...flags) : null),
    el('td', { className: 'account-cell cl-where', textContent: item.where }),
    el('td', { className: 'cl-size', textContent: fmtBytes(item.size) }),
    el('td', { className: 'date-cell', textContent: fmtDate(item.mtime) }));
  tr.addEventListener('click', (e) => {
    if (!selectable(item)) return;
    if (e.target !== box) box.checked = !box.checked;
    box.checked ? selected.add(item.id) : selected.delete(item.id);
    render();
  });
  return tr;
}

function render() {
  if (!data) return;
  renderCats();
  const shown = sorted(visible());
  const rows = [];
  for (const cat of data.categories) {
    const items = shown.filter((i) => i.cat === cat.id);
    if (!items.length) continue;
    const pickable = items.filter(selectable);
    const picked = pickable.filter((i) => selected.has(i.id));
    const groupBox = el('input', { type: 'checkbox', disabled: !pickable.length });
    groupBox.checked = pickable.length > 0 && picked.length === pickable.length;
    groupBox.indeterminate = picked.length > 0 && !groupBox.checked;
    groupBox.setAttribute('aria-label', `Select all shown in ${cat.label}`);
    groupBox.addEventListener('click', (e) => e.stopPropagation());
    groupBox.addEventListener('change', () => {
      for (const i of pickable) groupBox.checked ? selected.add(i.id) : selected.delete(i.id);
      render();
    });
    const size = items.reduce((s, i) => s + (done.get(i.id)?.ok ? 0 : i.size), 0);
    const isCollapsed = collapsed.has(cat.id);
    const head = el('tr', { className: 'cl-group' },
      el('td', { className: 'c-check' }, groupBox),
      el('td', { colSpan: 4 },
        el('span', { className: 'cl-chevron', textContent: isCollapsed ? '▸' : '▾' }),
        el('b', { textContent: cat.label }),
        el('span', { className: 'hint', textContent: ` ${plural(items.length, 'item')} · ${fmtBytes(size)}${picked.length ? ` · ${picked.length} picked` : ''}` }),
        el('div', { className: 'cl-sub', textContent: cat.desc })));
    head.addEventListener('click', () => {
      isCollapsed ? collapsed.delete(cat.id) : collapsed.add(cat.id);
      render();
    });
    rows.push(head);
    if (!isCollapsed) rows.push(...items.map(rowFor));
  }
  $('cl-rows').replaceChildren(...rows);
  $('cl-empty').hidden = shown.length > 0;
  renderStatus();
  renderBar();
}

function renderStatus() {
  const live = data.items.filter((i) => !done.get(i.id)?.ok);
  const free = live.filter((i) => !i.lock).reduce((s, i) => s + i.size, 0);
  $('cl-status').textContent = `${plural(live.length, 'item')} found, ${fmtBytes(free)} can be cleaned. Scanned in ${(data.tookMs / 1000).toFixed(1)} s.`;
}

function renderBar() {
  const picked = data.items.filter((i) => selected.has(i.id));
  const size = picked.reduce((s, i) => s + i.size, 0);
  const shownIds = new Set(visible().map((i) => i.id));
  const hidden = picked.filter((i) => !shownIds.has(i.id) || collapsed.has(i.cat)).length;
  $('cl-count').textContent = picked.length
    ? `${plural(picked.length, 'item')} picked, ${fmtBytes(size)}${hidden ? ` (${hidden} hidden by filters)` : ''}`
    : 'Pick items to clean';
  $('cl-clean').disabled = !picked.length || cleaning;
  $('cl-clean').textContent = cleaning ? 'Cleaning…' : picked.length ? `Clean ${fmtBytes(size)}` : 'Clean';
  $('cl-rescan').disabled = cleaning || scanning;
}

// ---- Clean ----
async function cleanPicked() {
  const picked = data.items.filter((i) => selected.has(i.id) && selectable(i));
  if (!picked.length) return;
  const mode = $('cl-mode').value;
  const size = picked.reduce((s, i) => s + i.size, 0);
  const lines = data.categories
    .map((c) => [c, picked.filter((i) => i.cat === c.id)])
    .filter(([, list]) => list.length)
    .map(([c, list]) => `• ${c.label}: ${plural(list.length, 'item')}, ${fmtBytes(list.reduce((s, i) => s + i.size, 0))}`);
  const linked = picked.filter((i) => i.cat === 'transcripts' && i.flags.linked).length;
  const warn = [];
  if (picked.some((i) => i.cat === 'transcripts')) warn.push("Deleted conversations can't be resumed.");
  if (linked) warn.push(`${plural(linked, 'conversation')} still listed in a Claude app will open empty there.`);
  const verb = mode === 'trash' ? `Move ${plural(picked.length, 'item')} (${fmtBytes(size)}) to the Trash?` : `Permanently delete ${plural(picked.length, 'item')} (${fmtBytes(size)})? This can't be undone.`;
  if (!confirm([verb, '', ...lines, ...(warn.length ? ['', ...warn] : [])].join('\n'))) return;

  cleaning = true;
  render();
  $('cl-status').textContent = `Cleaning ${fmtBytes(size)}…`;
  try {
    const { results, trashDir } = await api('/api/claude/clean', { ids: picked.map((i) => i.id), mode });
    let freed = 0;
    let failed = 0;
    for (const r of results) {
      done.set(r.id, r);
      if (r.ok) { freed += r.freed; selected.delete(r.id); } else failed++;
    }
    cleaning = false;
    render();
    $('cl-status').textContent = (mode === 'trash'
      ? `Moved ${fmtBytes(freed)} to the Trash${trashDir ? ` (${trashDir})` : ''}. Empty the Trash to get the space back.`
      : `Freed ${fmtBytes(freed)}.`)
      + (failed ? ` ${plural(failed, 'item')} failed: hover its status to see why.` : '');
  } catch (err) {
    cleaning = false;
    render();
    $('cl-status').textContent = `Cleaning failed: ${err.message}`;
  }
}

// ---- Wiring ----
for (const id of ['cl-search']) $(id).addEventListener('input', render);
for (const id of ['cl-where', 'cl-age', 'cl-min', 'cl-sort', 'cl-orphans', 'cl-kept']) $(id).addEventListener('change', render);
$('cl-linked').addEventListener('change', () => {
  if (!$('cl-linked').checked) {
    for (const i of data?.items ?? []) if (i.cat === 'transcripts' && i.flags.linked) selected.delete(i.id);
  }
  render();
});
$('cl-all-cats').addEventListener('click', () => {
  data?.categories.forEach((c) => activeCats.add(c.id));
  render();
});
$('cl-rescan').addEventListener('click', scan);
$('cl-clean').addEventListener('click', cleanPicked);

// Scan the first time the panel opens.
const onShow = () => { if (!data && !$('panel-claude').hidden) scan(); };
window.addEventListener('dustpan:tool', (e) => { if (e.detail === 'claude') onShow(); });
onShow();
