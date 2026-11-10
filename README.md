# dustpan

A local web app for cleaning personal clutter: Gemini chats and Claude data today, Gmail and computer junk next.

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
| Claude data (Claude Code and every Claude desktop app) | ✅ (macOS first) |
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

## Claude data

The **Claude data** tab scans, with nothing removed until you pick items and press **Clean**:

| Type | What | Where |
|------|------|-------|
| Pasted images & screenshots | `images/` per session | `/tmp/claude-<uid>/<project>/<session>/` |
| Scratchpads & task output | the rest of that session folder | same |
| Claude Code conversations | `<session>.jsonl` + its folder | `~/.claude/projects/` |
| Edit checkpoints | per-session rewind snapshots | `~/.claude/file-history/` |
| Leftover app folders | app-made folders with no session left | `<app data>/scratch-workspaces/` |
| Caches | web, script, GPU caches, crash dumps, error queue | each Claude app's data folder, `~/Library/Caches/claude-cli-nodejs` |
| Old Claude Code versions | every build except the current one | `~/.local/share/claude/versions/`, `<app data>/claude-code/` |
| Cowork | VM image, Cowork's Claude Code, Cowork sessions | `<app data>/vm_bundles`, `claude-code-vm`, `local-agent-mode-sessions` |
| Logs & diagnostics | debug logs, telemetry queue, shell snapshots over a day old, app logs, crash reports | `~/.claude/`, `~/Library/Logs/` |

Apps found: the normal Claude app plus any copy under `~/.claude-instances/<name>/` (named from `NAME=` in `~/.claude-instances/launch-*.sh`). `CLAUDE_CONFIG_DIR` replaces `~/.claude`.

Each item shows its title (the app session's title, else the conversation's own title or first prompt), project, place, size, last use and flags (`in <app>`, `archived`, `folder gone`, image and file counts). Filter by type, place, text, age, size and "only leftovers"; sort by size, age or name; pick per item or per type.

Safety:
- Kept and never selectable: the current Claude Code version, versions a running Claude Code uses, anything used in the last 30 minutes, and caches or Cowork of an app that is still running ("Quit … first").
- Conversations still listed in a Claude app are locked unless **Allow conversations still listed in a Claude app** is on (they open empty in the app afterwards).
- The page can only name items from the latest scan; the server re-checks locks and that every path is inside a Claude folder right before removing.
- **Move to Trash** (macOS) puts everything in one `~/.Trash/Dustpan <date>` folder; the space comes back when you empty the Trash. **Delete permanently** frees it at once.

## Gemini cleaning logic

1. **Accounts**: fetch `gemini.google.com/u/0/app`, `/u/1/app`, … until Google redirects back to `/u/0`. Each page holds that account's email and session values.
2. **Chats**: call Gemini's internal list RPC (`MaZiqc`) for each chosen account, pinned and unpinned, following page cursors.
3. **Delete**: call Gemini's internal delete RPC (`GzXR5e`) once per selected chat, 250 ms apart, reporting `deleting → deleted / failed` per chat. **Stop** skips the rest.

These are the same calls Gemini's own sidebar and Delete menu use. If Google changes them, update `extensions/chrome/gemini-api.js`.
