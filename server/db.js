// SQLite store at ~/.dustpan/dustpan.db (override with DUSTPAN_HOME).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.DUSTPAN_HOME || path.join(os.homedir(), '.dustpan');
fs.mkdirSync(HOME, { recursive: true });

const db = new DatabaseSync(path.join(HOME, 'dustpan.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- The running server, if any. At most one row.
  CREATE TABLE IF NOT EXISTS instance (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    instance TEXT NOT NULL, port INTEGER NOT NULL, pid INTEGER NOT NULL, started_at INTEGER NOT NULL
  );
  -- One row per Chrome profile that has the extension.
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    nickname TEXT,
    chrome_email TEXT,
    google_accounts TEXT,
    last_seen INTEGER NOT NULL
  );
`);

export const settings = {
  get(key, fallback = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  },
  set(key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  },
};

export const instance = {
  get() {
    return db.prepare('SELECT instance, port, pid, started_at AS startedAt FROM instance WHERE id = 1').get() ?? null;
  },
  set({ instance: id, port, pid }) {
    db.prepare(`INSERT INTO instance (id, instance, port, pid, started_at) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET instance = excluded.instance, port = excluded.port, pid = excluded.pid, started_at = excluded.started_at`)
      .run(id, port, pid, Date.now());
  },
  clear(id) {
    if (id) db.prepare('DELETE FROM instance WHERE instance = ?').run(id);
    else db.prepare('DELETE FROM instance').run();
  },
};

const toProfile = (row) => row && {
  id: row.id,
  nickname: row.nickname,
  chromeEmail: row.chrome_email,
  googleAccounts: row.google_accounts ? JSON.parse(row.google_accounts) : [],
  lastSeen: row.last_seen,
};

export const profiles = {
  all() {
    return db.prepare('SELECT * FROM profiles ORDER BY last_seen DESC').all().map(toProfile);
  },
  get(id) {
    return toProfile(db.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
  },
  seen(id, { chromeEmail }) {
    db.prepare(`INSERT INTO profiles (id, chrome_email, last_seen) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET chrome_email = COALESCE(excluded.chrome_email, chrome_email), last_seen = excluded.last_seen`)
      .run(id, chromeEmail || null, Date.now());
  },
  setNickname(id, nickname) {
    db.prepare('UPDATE profiles SET nickname = ? WHERE id = ?').run(nickname || null, id);
  },
  setGoogleAccounts(id, emails) {
    db.prepare('UPDATE profiles SET google_accounts = ? WHERE id = ?').run(JSON.stringify(emails), id);
  },
  remove(id) {
    db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  },
};
