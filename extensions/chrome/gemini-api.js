// Injected into gemini.google.com (MAIN world) by background.js.
// Calls Gemini's own batchexecute RPCs with the signed-in session, so no cookies
// or tokens ever leave the page. Each signed-in Google account lives at /u/<n>/.
(() => {
  if (window.__dustpanGemini) return;

  const RPC = { LIST: 'MaZiqc', DELETE: 'GzXR5e' };
  const PAGE_SIZE = 100;
  const MAX_ACCOUNTS = 10;
  const sessions = new Map(); // account index -> { email, at, bl, fsid }
  let reqId = Math.floor(Math.random() * 9000) + 1000;

  // Loads /u/<n>/app and reads the WIZ_global_data values Gemini embeds for that account.
  async function loadSession(n) {
    const res = await fetch(`/u/${n}/app`, { credentials: 'include' });
    const html = await res.text();
    const pick = (key) => (html.match(new RegExp(`"${key}":"([^"]*)"`)) || [])[1];
    const at = pick('SNlM0e');
    if (!at) return null;
    // Out-of-range indexes redirect to /u/0.
    const index = Number(new URL(res.url).pathname.match(/^\/u\/(\d+)\//)?.[1] ?? 0);
    return { index, email: pick('oPEP7c') || `account ${index}`, at, bl: pick('cfb2h'), fsid: pick('FdrFJe') };
  }

  async function listAccounts() {
    sessions.clear();
    for (let n = 0; n < MAX_ACCOUNTS; n++) {
      const s = await loadSession(n);
      if (!s || s.index !== n) break;
      sessions.set(n, s);
    }
    if (!sessions.size) throw new Error('Not signed in to Gemini.');
    return [...sessions.values()].map(({ index, email }) => ({ index, email }));
  }

  async function rpc(account, id, payload) {
    if (!sessions.has(account)) await listAccounts();
    const s = sessions.get(account);
    if (!s) throw new Error(`No signed-in account at /u/${account}/`);
    reqId += 100000;
    const query = new URLSearchParams({
      rpcids: id, 'source-path': `/u/${account}/app`, bl: s.bl, 'f.sid': s.fsid,
      hl: 'en', _reqid: String(reqId), rt: 'c',
    });
    const body = new URLSearchParams({
      'f.req': JSON.stringify([[[id, JSON.stringify(payload), null, 'generic']]]),
      at: s.at,
    });
    const res = await fetch(`/u/${account}/_/BardChatUi/data/batchexecute?${query}`, {
      method: 'POST', body, credentials: 'include',
    });
    if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
    const line = (await res.text()).split('\n').find((l) => l.includes('"wrb.fr"'));
    const frame = line && JSON.parse(line).find((f) => f[0] === 'wrb.fr' && f[1] === id);
    if (!frame) throw new Error(`${id}: unexpected response`);
    return frame[2] ? JSON.parse(frame[2]) : null;
  }

  // Entry shape: [id, title, , , , [unixSeconds, nanos], ...]
  async function listChats(account) {
    const chats = new Map();
    for (const pinned of [1, 0]) {
      const seen = new Set();
      let cursor = null;
      do {
        const data = await rpc(account, RPC.LIST, [PAGE_SIZE, cursor, [pinned, null, 1]]);
        for (const e of data?.[2] || []) {
          if (chats.has(e[0])) continue;
          chats.set(e[0], {
            account,
            id: e[0],
            title: e[1] || '(untitled)',
            updated: e[5]?.[0] ? e[5][0] * 1000 : null,
            pinned: pinned === 1,
          });
        }
        cursor = data?.[1] || null;
        if (cursor && seen.has(cursor)) break;
        seen.add(cursor);
      } while (cursor);
    }
    return [...chats.values()];
  }

  async function deleteChat(account, id) {
    await rpc(account, RPC.DELETE, [id]);
    return true;
  }

  window.__dustpanGemini = { listAccounts, listChats, deleteChat };
})();
