# dustpan

A local web app for cleaning personal clutter: Gemini chats today, Gmail and computer junk next.

Runs on macOS, Windows and Linux with Google Chrome. No dependencies: Node 22.13+ (built-in `node:sqlite`).

```bash
npm link            # once, puts `dustpan` on your PATH
dustpan             # starts in the background (or reuses the running one) and opens the page in Chrome
dustpan --verbose   # runs in this terminal with logs (Ctrl+C to stop)
dustpan status      # is it running, and where
dustpan stop        # stops it (or use Quit Dustpan on the page)
```

State lives in `~/.dustpan/` (`dustpan.db`, `dustpan.log`). Set `DUSTPAN_HOME` to use another folder.

| Tool | Status |
|------|--------|
| Gemini chats (any Google account, any Chrome profile) | ✅ |
| Gmail | planned |
| Mac system junk (open-source logic or submodule) | planned |
| PyCharm / Teams / VS Code caches (port of existing shell scripts) | planned |

## Starting, ports and stale instances

The server takes the first free port in **47321–47330** and saves `{instance id, port, pid}` in SQLite. `GET /api/signature` returns `{app, version, instance, pid, port}`.

When you run `dustpan`, it reads the saved port and calls `/api/signature`. It only reuses that server if the response is JSON with `app: "dustpan"` **and** the saved instance id. Anything else counts as stale (a 404, a different app, a different dustpan, nothing listening). In that case it clears the saved row and starts a new server on the next free port.

The range is fixed because the extension has to find the server by scanning ports; it can't read files.

## Chrome profiles

```
page ──ws /ws/page──▶ server ──ws /ws/ext──▶ extension (one per Chrome profile) ──▶ hidden Gemini tab
```

- Load the extension once per Chrome profile: `chrome://extensions` → **Developer mode** → **Load unpacked** → `dustpan/extensions/chrome`.
- Each profile's extension generates a stable id and connects to the server on its own. It retries every 30 seconds and on Chrome start-up.
- Profile names: your nickname (set on the page), otherwise Chrome's own profile name (read from Chrome's `Local State`, matched by the Chrome sign-in email), otherwise the email.
- **Extension updates:** the extension reports its manifest version. If the files on disk are newer, the server tells it to reload itself, so bump `version` in `manifest.json` after editing the extension.
- **Chrome closed / profile not open:** the profile shows as offline, with **Open this profile in Chrome**. If it drops mid-delete, unfinished chats are marked failed and stay selected for a retry. Connections that stay silent for 60 seconds are dropped.
- Outside websites can't use the server: WebSocket origins are checked (the page's own origin or `chrome-extension://`), POSTs need an `x-dustpan` header (which forces a CORS preflight), and the server only answers `127.0.0.1` / `localhost` host names.

## Gemini cleaning logic

1. **Accounts**: fetch `gemini.google.com/u/0/app`, `/u/1/app`, … until Google redirects back to `/u/0`. Each page holds that account's email and session values.
2. **Chats**: call Gemini's internal list RPC (`MaZiqc`) for each chosen account, pinned and unpinned, following page cursors.
3. **Delete**: call Gemini's internal delete RPC (`GzXR5e`) once per selected chat, 250 ms apart, reporting `deleting → deleted / failed` per chat. **Stop** skips the rest.

These are the same calls Gemini's own sidebar and Delete menu use. If Google changes them, update `extensions/chrome/gemini-api.js`.
