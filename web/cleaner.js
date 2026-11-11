// One panel per cleaner tool (Claude data, Docker, JetBrains, …). Every <section class="panel cleaner"
// data-tool="x"> gets the same UI: scan, type cards, filters, grouped table, clean bar.
const DAY = 24 * 60 * 60 * 1000;

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
const option = (value, text) => new Option(text, value);

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

function mount(panel) {
  const tool = panel.dataset.tool;
  const q = (cls) => panel.querySelector(`.${cls}`);

  panel.append(
    el('div', { className: 'block-head' },
      el('span', { className: 'hint cl-status', textContent: 'Not scanned yet.' }),
      el('button', { className: 'cl-rescan', textContent: 'Scan again' })),
    el('p', { className: 'notice cl-notice', hidden: true }),
    el('div', { className: 'cl-apps' }),
    el('div', { className: 'block-head' }, el('h2', { textContent: 'What to show' }), el('button', { className: 'link cl-all-cats', textContent: 'All types' })),
    el('div', { className: 'cl-cats' }),
    el('div', { className: 'toolbar' },
      el('input', { className: 'cl-search', type: 'search', placeholder: 'Filter by name, project or path', ariaLabel: 'Filter by name, project or path' }),
      el('label', {}, 'Where ', el('select', { className: 'cl-where' }, option('', 'everywhere'))),
      el('label', {}, 'Last used ', el('select', { className: 'cl-age' },
        option('0', 'any time'), option('1', 'over a day ago'), option('7', 'over a week ago'), option('30', 'over a month ago'), option('90', 'over 3 months ago'), option('365', 'over a year ago'))),
      el('label', {}, 'Size ', el('select', { className: 'cl-min' },
        option('0', 'any'), option('1000000', 'over 1 MB'), option('10000000', 'over 10 MB'), option('100000000', 'over 100 MB'), option('1000000000', 'over 1 GB'))),
      el('label', {}, 'Sort ', el('select', { className: 'cl-sort' },
        option('size', 'largest first'), option('old', 'oldest first'), option('new', 'newest first'), option('name', 'by name')))),
    el('div', { className: 'toolbar cl-toggles' },
      el('label', { className: 'cl-orphans-wrap' }, el('input', { className: 'cl-orphans', type: 'checkbox' }), ' Only leftovers (their project, app or session is gone)'),
      el('span', { className: 'cl-optins' }),
      el('label', {}, el('input', { className: 'cl-kept', type: 'checkbox' }), ' Show kept and in-use items')),
    el('table', { className: 'chats cl-table' },
      el('thead', {}, el('tr', {},
        el('th', { className: 'c-check' }), el('th', { textContent: 'Item' }), el('th', { className: 'cl-where', textContent: 'Where' }),
        el('th', { className: 'cl-size', textContent: 'Size' }), el('th', { className: 'c-date', textContent: 'Last used' }))),
      el('tbody', { className: 'cl-rows' })),
    el('p', { className: 'empty cl-empty', textContent: 'Nothing matches these filters.', hidden: true }),
    el('footer', { className: 'actionbar cl-actionbar', hidden: true },
      el('span', { className: 'cl-count' }),
      el('span', { className: 'spacer' }),
      el('label', { className: 'cl-mode-wrap' }, 'Then ', el('select', { className: 'cl-mode' }, option('trash', 'move to Trash'), option('delete', 'delete permanently'))),
      el('button', { className: 'danger cl-clean', textContent: 'Clean', disabled: true })),
  );

  let data = null;
  let scanning = false;
  let cleaning = false;
  const activeCats = new Set();
  const selected = new Set();
  const collapsed = new Set();
  const done = new Map();
  const allowed = new Set();

  async function scan() {
    if (scanning || cleaning) return;
    scanning = true;
    q('cl-rescan').disabled = true;
    const started = Date.now();
    q('cl-status').textContent = 'Scanning…';
    const tick = setInterval(() => { q('cl-status').textContent = `Scanning… ${Math.round((Date.now() - started) / 1000)} s (big caches take up to a minute)`; }, 1000);
    try {
      data = await api(`/api/clean/${tool}/scan`);
      if (!activeCats.size) data.categories.forEach((c) => activeCats.add(c.id));
      const ids = new Set(data.items.map((i) => i.id));
      for (const id of selected) if (!ids.has(id)) selected.delete(id);
      done.clear();
      const mode = q('cl-mode');
      for (const o of mode.options) o.hidden = o.disabled = !data.modes.includes(o.value);
      if (!data.modes.includes(mode.value)) mode.value = data.modes[0];
      q('cl-mode-wrap').hidden = data.modes.length < 2;
      q('cl-notice').hidden = !data.notice;
      q('cl-notice').textContent = data.notice || '';
      q('cl-orphans-wrap').hidden = !data.items.some((i) => i.orphan);
      renderOptIns();
      renderSources();
      renderWhere();
      render();
      q('cl-actionbar').hidden = false;
    } catch (err) {
      q('cl-status').textContent = `Scan failed: ${err.message}`;
    } finally {
      clearInterval(tick);
      scanning = false;
      q('cl-rescan').disabled = false;
    }
  }

  // Why an item can't be picked right now, or null.
  function blockedWhy(item) {
    if (done.get(item.id)?.ok) return 'Cleaned';
    if (item.lock) return item.lock;
    if (item.optIn && !allowed.has(item.optIn)) return `Needs: ${data.optIns.find((o) => o.id === item.optIn)?.label.replace(/ \(.*$/, '') ?? item.optIn}`;
    return null;
  }
  const selectable = (item) => !blockedWhy(item) && !cleaning;

  function visible() {
    if (!data) return [];
    const needle = q('cl-search').value.trim().toLowerCase();
    const where = q('cl-where').value;
    const days = Number(q('cl-age').value);
    const min = Number(q('cl-min').value);
    const orphans = q('cl-orphans').checked;
    const kept = q('cl-kept').checked;
    return data.items.filter((i) => activeCats.has(i.cat)
      && (!needle || `${i.label} ${i.sub} ${i.where} ${i.badges.map((b) => b.text).join(' ')}`.toLowerCase().includes(needle))
      && (!where || i.where === where)
      && (!days || (i.mtime && i.mtime < Date.now() - days * DAY))
      && (!min || i.size >= min)
      && (!orphans || i.orphan)
      && (kept || !i.lock || done.has(i.id)));
  }

  function sorted(list) {
    const cmp = {
      size: (a, b) => b.size - a.size,
      old: (a, b) => (a.mtime || 0) - (b.mtime || 0),
      new: (a, b) => (b.mtime || 0) - (a.mtime || 0),
      name: (a, b) => a.label.localeCompare(b.label),
    }[q('cl-sort').value];
    return [...list].sort(cmp);
  }

  function renderOptIns() {
    q('cl-optins').replaceChildren(...data.optIns.map((o) => {
      const box = el('input', { type: 'checkbox', checked: allowed.has(o.id) });
      box.addEventListener('change', () => {
        if (box.checked) allowed.add(o.id);
        else {
          allowed.delete(o.id);
          for (const i of data.items) if (i.optIn === o.id) selected.delete(i.id);
        }
        render();
      });
      return el('label', {}, box, ` ${o.label}`);
    }));
  }

  function renderSources() {
    q('cl-apps').replaceChildren(...data.sources.map((s) => el('span', { className: `cl-app ${s.warn ? 'is-running' : ''}`, title: s.detail || '' },
      el('b', { textContent: s.name }), el('small', { textContent: s.state || '' }))));
  }

  function renderWhere() {
    const select = q('cl-where');
    const current = select.value;
    const places = [...new Set(data.items.map((i) => i.where))].sort();
    select.replaceChildren(option('', 'everywhere'), ...places.map((p) => option(p, p)));
    select.value = places.includes(current) ? current : '';
  }

  function renderCats() {
    const present = new Set(data.items.map((i) => i.cat));
    q('cl-cats').replaceChildren(...data.categories.filter((c) => present.has(c.id)).map((c) => {
      const items = data.items.filter((i) => i.cat === c.id && !done.get(i.id)?.ok);
      const free = items.filter((i) => !i.lock && (!i.optIn || allowed.has(i.optIn))).reduce((s, i) => s + i.size, 0);
      const kept = items.filter((i) => i.lock).length;
      const gated = items.filter((i) => !i.lock && i.optIn && !allowed.has(i.optIn)).reduce((s, i) => s + i.size, 0);
      const btn = el('button', { className: 'cl-cat', type: 'button', title: c.desc },
        el('span', { className: 'cl-cat-name', textContent: c.label }),
        el('span', { className: 'cl-cat-size', textContent: fmtBytes(free) }),
        el('small', { textContent: [plural(items.length, 'item'), kept && `${kept} kept`, gated && `${fmtBytes(gated)} behind a toggle`].filter(Boolean).join(', ') }));
      btn.setAttribute('aria-pressed', String(activeCats.has(c.id)));
      btn.addEventListener('click', () => {
        activeCats.has(c.id) ? activeCats.delete(c.id) : activeCats.add(c.id);
        render();
      });
      return btn;
    }));
  }

  const badge = (text, kind = '') => el('span', { className: `cl-badge ${kind}`, textContent: text });

  function rowFor(item) {
    const why = blockedWhy(item);
    const result = done.get(item.id);
    const box = el('input', { type: 'checkbox', checked: selected.has(item.id), disabled: !selectable(item) });
    box.setAttribute('aria-label', `Select ${item.label}`);
    const flags = [];
    if (result) flags.push(badge(result.ok ? 'Cleaned' : `Failed: ${result.error}`, result.ok ? 'ok' : 'warn'));
    else if (why) flags.push(badge(why, 'lock'));
    flags.push(...item.badges.map((b) => badge(b.text, b.kind)));
    if (item.files > 1) flags.push(badge(plural(item.files, 'file')));
    const tr = el('tr', { className: `${why ? 'is-blocked' : ''} ${result?.ok ? 'is-deleted' : ''}` },
      el('td', { className: 'c-check' }, box),
      el('td', {},
        el('span', { className: 'title', textContent: item.label, title: item.label }),
        el('div', { className: 'cl-sub', textContent: item.sub, title: item.sub }),
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
    q('cl-rows').replaceChildren(...rows);
    q('cl-empty').hidden = shown.length > 0;
    const live = data.items.filter((i) => !done.get(i.id)?.ok);
    const free = live.filter((i) => !i.lock && (!i.optIn || allowed.has(i.optIn))).reduce((s, i) => s + i.size, 0);
    if (!cleaning) q('cl-status').dataset.base = `${plural(live.length, 'item')} found, ${fmtBytes(free)} can be cleaned. Scanned in ${(data.tookMs / 1000).toFixed(1)} s.`;
    if (!q('cl-status').dataset.result) q('cl-status').textContent = q('cl-status').dataset.base;
    renderBar();
  }

  function renderBar() {
    const picked = data.items.filter((i) => selected.has(i.id));
    const size = picked.reduce((s, i) => s + i.size, 0);
    const shownIds = new Set(visible().filter((i) => !collapsed.has(i.cat)).map((i) => i.id));
    const hidden = picked.filter((i) => !shownIds.has(i.id)).length;
    q('cl-count').textContent = picked.length
      ? `${plural(picked.length, 'item')} picked, ${fmtBytes(size)}${hidden ? ` (${hidden} not shown)` : ''}`
      : 'Pick items to clean';
    q('cl-clean').disabled = !picked.length || cleaning;
    q('cl-clean').textContent = cleaning ? 'Cleaning…' : picked.length ? `Clean ${fmtBytes(size)}` : 'Clean';
    q('cl-rescan').disabled = cleaning || scanning;
  }

  async function cleanPicked() {
    const picked = data.items.filter((i) => selected.has(i.id) && selectable(i));
    if (!picked.length) return;
    const mode = q('cl-mode').value;
    const size = picked.reduce((s, i) => s + i.size, 0);
    const lines = data.categories
      .map((c) => [c, picked.filter((i) => i.cat === c.id)])
      .filter(([, list]) => list.length)
      .map(([c, list]) => `• ${c.label}: ${plural(list.length, 'item')}, ${fmtBytes(list.reduce((s, i) => s + i.size, 0))}`);
    const gated = data.optIns.filter((o) => picked.some((i) => i.optIn === o.id)).map((o) => `• ${o.label}`);
    const verb = mode === 'trash'
      ? `Move ${plural(picked.length, 'item')} (${fmtBytes(size)}) to the Trash?`
      : `Permanently delete ${plural(picked.length, 'item')} (${fmtBytes(size)})? This can't be undone.`;
    if (!confirm([verb, '', ...lines, ...(gated.length ? ['', 'Including items you allowed:', ...gated] : [])].join('\n'))) return;

    cleaning = true;
    delete q('cl-status').dataset.result;
    render();
    q('cl-status').textContent = `Cleaning ${fmtBytes(size)}…`;
    try {
      const { results, trashDir } = await api(`/api/clean/${tool}/clean`, { ids: picked.map((i) => i.id), mode, allow: [...allowed] });
      let freed = 0;
      let failed = 0;
      for (const r of results) {
        done.set(r.id, r);
        if (r.ok) { freed += r.freed; selected.delete(r.id); } else failed++;
      }
      const text = (mode === 'trash'
        ? `Moved ${fmtBytes(freed)} to the Trash${trashDir ? ` (${trashDir})` : ''}. Empty the Trash to get the space back.`
        : `Freed ${fmtBytes(freed)}.`) + (failed ? ` ${plural(failed, 'item')} failed: see the red labels.` : '');
      q('cl-status').dataset.result = text;
      q('cl-status').textContent = text;
    } catch (err) {
      q('cl-status').dataset.result = `Cleaning failed: ${err.message}`;
      q('cl-status').textContent = q('cl-status').dataset.result;
    } finally {
      cleaning = false;
      render();
    }
  }

  q('cl-search').addEventListener('input', render);
  for (const cls of ['cl-where', 'cl-age', 'cl-min', 'cl-sort', 'cl-orphans', 'cl-kept']) q(cls).addEventListener('change', render);
  q('cl-all-cats').addEventListener('click', () => { data?.categories.forEach((c) => activeCats.add(c.id)); render(); });
  q('cl-rescan').addEventListener('click', () => { delete q('cl-status').dataset.result; scan(); });
  q('cl-clean').addEventListener('click', cleanPicked);

  return { show: () => { if (!data) scan(); }, busy: () => cleaning };
}

const panels = new Map([...document.querySelectorAll('.panel.cleaner')].map((p) => [p.dataset.tool, mount(p)]));
const showIfOpen = (tool) => { if (!document.getElementById(`panel-${tool}`)?.hidden) panels.get(tool)?.show(); };
window.addEventListener('dustpan:tool', (e) => panels.get(e.detail)?.show());
for (const tool of panels.keys()) showIfOpen(tool);
window.dustpanCleaning = () => [...panels.values()].some((p) => p.busy());
