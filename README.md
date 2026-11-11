# dustpan

A local web app for cleaning personal clutter: Gemini chats, Claude data, Docker, JetBrains IDEs, developer caches and app caches. Gmail next.

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
| Claude data (Claude Code and every Claude desktop app) | ✅ |
| Docker (images, stopped containers, volumes, build cache) | ✅ |
| JetBrains IDEs (old versions, caches) | ✅ |
| Developer caches (npm, pnpm, pip, uv, models, test browsers, venvs, node_modules…) | ✅ |
| App caches (VS Code-style editors, Teams, Postman, Slack, browsers, ~/Library/Caches, logs) | ✅ macOS first |
| Gmail | planned |

Everything is Node with no dependencies and no shell scripts, so it can run on Windows. External programs are only called directly (`ps`, `docker`), never through a shell.

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

## Cleaner tools

Every tab under **This computer** works the same way: **scan** (nothing is removed), then pick items and press **Clean**. Code: `server/cleaners/<tool>.js` finds items, `server/cleaners/engine.js` removes them, `web/cleaner.js` draws every panel.

The page shows, per tool: what it found (apps, IDEs, Docker), a card per type with its cleanable size (click to show or hide that type), and a table grouped by type. Each row has a name, project or path, where it's from, size, last use and labels (`not installed`, `folder gone`, `used by …`, `running`, file counts). Filters: text, where, last used, size, sort, "only leftovers", plus the tool's own toggles. Pick single rows or a whole type.

| Tool | What it lists |
|------|---------------|
| Claude data | Pasted images and screenshots, scratchpads, conversations, edit checkpoints, leftover app folders, caches, old Claude Code versions, Cowork, logs. Apps: the normal Claude app plus copies under `~/.claude-instances/<name>/` (named from `NAME=` in `launch-*.sh`). `CLAUDE_CONFIG_DIR` replaces `~/.claude`. |
| Docker | Images (one row per tag, unique size), stopped containers (removed with their anonymous volumes), unused volumes, build cache (Docker's own reclaimable size). Uses the `docker` CLI; says so if Docker isn't running. |
| JetBrains IDEs | Installed IDEs are read from their `product-info.json` (`dataDirectoryName`), not guessed from the newest folder. Versions not installed: caches, logs, settings (settings only when a newer settings folder exists). Installed versions: caches and logs. Toolbox and other JetBrains caches. |
| Developer caches | npm (`_cacache`, each npx package), pnpm, Yarn, Bun, pip, uv, Poetry, Homebrew, CocoaPods, Maven, Cargo, Gradle, Go, Xcode (DerivedData per project, simulator caches, device support), Hugging Face (per model, including blobs only that model uses), Playwright/Puppeteer browsers (older builds marked), Python envs (virtualenvs, pyenv, conda, project `.venv`), `node_modules` in `~/repos`, `~/projects`, `~/code` and similar, other `~/.cache` folders. |
| App caches | VS Code, Cursor, Windsurf, VSCodium: caches, compiled code of old builds, extension packages, logs, saved state per workspace (marked when the folder is gone). Web caches inside Teams, Postman, Slack, Discord, Notion, Figma, WhatsApp, Chrome, Brave, Edge (only `Cache`, `Code Cache`, GPU and service-worker caches; never cookies, IndexedDB or local storage). Each `~/Library/Caches` folder (not `com.apple.*`), old update downloads (`*.ShipIt`), `~/Library/Logs`, crash reports, temp files untouched for a week. |

Safety:
- **Kept** (never selectable): current versions, anything used in the last 30 minutes, things a running program uses (Claude apps, IDEs, Docker containers, npx servers, venvs), the pyenv global version.
- **Behind a toggle**: conversations still listed in a Claude app, named Docker volumes, the last settings of an IDE that isn't installed, caches of apps that are open.
- The page can only name items from the tool's latest scan; right before removing, the server checks locks again with fresh state, checks the toggles, and checks every path is inside that tool's folders.
- **Move to Trash** (macOS) puts everything in one `~/.Trash/Dustpan <date>` folder; the space comes back when you empty the Trash. **Delete permanently** frees it at once. Docker items are always removed through Docker.

## Gemini cleaning logic

1. **Accounts**: fetch `gemini.google.com/u/0/app`, `/u/1/app`, … until Google redirects back to `/u/0`. Each page holds that account's email and session values.
2. **Chats**: call Gemini's internal list RPC (`MaZiqc`) for each chosen account, pinned and unpinned, following page cursors.
3. **Delete**: call Gemini's internal delete RPC (`GzXR5e`) once per selected chat, 250 ms apart, reporting `deleting → deleted / failed` per chat. **Stop** skips the rest.

These are the same calls Gemini's own sidebar and Delete menu use. If Google changes them, update `extensions/chrome/gemini-api.js`.
