# EnvSwitch

> Language: [简体中文](README.md) · [English](README_EN.md)

> A small desktop tool that helps you **centrally manage and instantly switch the `.env` environment configs of multiple projects**. It gathers the scattered `.env.xxx` files from each project directory into a single window; one click overwrites the chosen config into `.env` — no more digging through files or copy-pasting that's easy to get wrong.

---

## What is this, and what problem does it solve

In day-to-day development we accumulate more and more projects, and each project directory ends up with a pile of `.env` / `.env.development` / `.env.production` / `.env.staging` …

- It's hard to remember which file maps to which environment, and you have to back up the original `.env` before editing.
- Copy-pasting to switch configs is error-prone — you might miss a line, change the wrong thing, or even paste production config into local.
- Jumping between projects with `cp` in the terminal is inefficient and easy to mix up.

EnvSwitch centralizes these `.env` files:

- **No directory diving, no manual commands**: all env files live in one window; one click overwrites `.env.xxx` into `.env` and takes effect immediately.
- **No fear of mistakes**: the UI lists every `.env.xxx` for the project, so it's clear before you switch; the original `.env` content will be overwritten, so back up anything important first.
- **Always visible**: chokidar watches `.env` for changes and Socket.IO pushes them to the UI in real time, so external edits show up instantly.
- **Centralized multi-project management**: manage several project directories together, drag cards to reorder, and the order is auto-persisted.

In short, it's a **"switcher + manager" for `.env`** that turns repetitive environment switching into a few mouse clicks.

## Core Features

| Feature | Description |
|---------|-------------|
| 📁 **Multi-project management** | Add multiple project directories and centrally manage the env config of all projects |
| ⚡ **One-click env switch** | Lists the project's `.env.xxx` files; one click overwrites the chosen config into `.env` |
| 👀 **Real-time monitoring** | Local paths use chokidar; WSL paths fall back to periodic polling — combined with Socket.IO, `.env` changes are pushed to the UI in real time |
| ↔️ **Drag to reorder** | Drag project cards to reorder; the order is auto-persisted |
| 🟢 **Active config highlight** | Real-time md5 comparison between `.env` and each `.env.xxx`; the matched row is highlighted (light-green background + left green bar) and shows a green "In use" pill; the switch button is always present for one-click re-apply |
| 🔃 **Manual refresh** | The header "Refresh data" button manually re-fetches all projects, covering cases like WSL where changes can't be auto-detected |
| ⚙️ **Settings** | The header "Settings" icon button opens a settings dialog where you can adjust the WSL polling interval, etc. |
| 🐧 **WSL support** | Compatible with Windows Subsystem for Linux paths (`\\wsl.localhost\Ubuntu\...`) |
| 🖥️ **Desktop app** | Packaged with Electron; runs standalone on Windows / macOS without keeping a terminal open |
| 🔄 **Auto-update** | Packaged builds can check GitHub Releases for new versions; release notes are shown in release style |
| 🔒 **OS-assigned port** | The backend listens on port `0` (OS-assigned), combined with a single-instance lock to avoid port clashes / cross-talk between instances |
| ℹ️ **App info** | The header "App info" icon button opens an about dialog showing version, run mode, data/log paths, and source URL |

## How to use

### 1. Install

- **Released builds**: download from GitHub Releases.
  - **Windows**: download the `.exe` (NSIS installer) and double-click to install.
  - **macOS**: download the `.dmg` (both Intel and Apple Silicon builds are provided).
- **Build from source (developers)**: requires Node.js >= 18 and npm >= 9.
  ```bash
  npm install
  cd client && npm install
  npm run electron-build        # build the Windows installer
  # or (must run on macOS)
  npm run electron-build-mac    # build the macOS dmg + zip
  ```
- **Local development**: run directly in an Electron window (embedded server + built frontend).
  ```bash
  npm run electron-dev
  ```
  It auto-generates icons, builds the frontend, and launches the Electron window; the app backend runs inside the window (OS-assigned port).

### 2. Add a project

1. Click the top-right **"+ Add project"** button
2. Enter the project's root directory path (it must contain an `.env` file); both local and WSL paths are supported
3. Click OK

### 3. Switch environment

1. The project card shows the current `APP_NAME` and `APP_ENV` from `.env`
2. In the "Environment config switcher" area:
   - The **currently active config** is highlighted (light-green background + left green bar) and shows a green "In use" pill — the criterion is that `.env` and that `.env.xxx` are byte-for-byte identical (switching is a byte-exact copy, so comments / quotes / trailing newlines don't affect the match), making it obvious at a glance which file is really in effect. If several `.env.xxx` files are byte-for-byte identical (equal md5), the one you **switched to most recently** is highlighted (the last-switched name, persisted, acts as the tiebreaker so multiple identical files don't highlight randomly). If `.env` matches none of the source files, no row is highlighted (honestly shown as "not linked").
   - Click the **"Switch" / "Re-apply"** button next to any `.env.xxx` to overwrite its content into `.env`; the switch button is always present on every row for convenient re-applying (e.g. after the source file was changed externally).
3. That config file's content is copied into `.env` and the UI updates in real time

### 4. Reorder & delete

- **Drag to reorder**: hold the drag handle (⠿) and drag the project card to reorder
- **Delete project**: click the "Delete" button at the top-right of the card to remove the project

### 5. Check for updates

- The header "Check for updates" button (upgrade-arrow icon) manually triggers a version check; if a new version is found, a dialog prompts you to download and install it.
- Only **packaged builds** actually connect to GitHub Releases; in dev mode (unpackaged) the check shows "Running in dev mode" and does not go online.
- Platform differences: Windows uses electron-updater (NSIS flow, works without signing); macOS, being an unsigned personal release, uses a **custom updater** — it downloads the GitHub Release zip directly, extracts it with `ditto`, replaces the `.app` via a background script, and strips the quarantine flag, so updates work without signing (bypassing electron-updater's mandatory code-signature check on the running app on macOS, which would otherwise fail with `Could not get code signature for running application`).

### 6. View app info (App Info)

- The header "App info" icon button opens the about dialog.
- You can view: the current version, run mode (Development / Production), full paths to the data and log files (with a Copy button), and the source repository link.
- Clicking the GitHub "Source" link opens it in your system default browser; the paths and version info help locate the data/log directories when troubleshooting.

## Supported platforms

| Platform | Status | Notes |
|----------|--------|-------|
| Windows 10/11 | ✅ | NSIS installer (`.exe`) |
| macOS (Intel) | ✅ | `.dmg` / `.zip` |
| macOS (Apple Silicon) | ✅ | `.dmg` / `.zip` |
| Linux | 🔧 | No package provided |

## FAQ

**Q: Where is the data stored?**
- Desktop app (packaged or `npm run electron-dev`): data is in the Electron user-data directory `app.getPath('userData')/data/data.json`.
- Back up this directory as needed before uninstalling or reinstalling the desktop app.

**Q: Does switching env destroy the original `.env`?**
Yes. Switching overwrites the selected `.env.xxx` content into `.env`, replacing the original `.env` content. Back up important config before switching, or copy an `.env.backup` first.

**Q: I changed `.env` but the UI didn't update?**
- Local project path: the UI monitors `.env` changes in real time via chokidar and pushes updates.
- WSL path (`\\wsl.localhost\...`): chokidar is unreliable there, so it falls back to **periodic polling** (lists files and recomputes md5 every 10 seconds by default; adjustable from 500ms to 1 minute in Settings); changes auto-refresh on the next poll. If you want an immediate refresh, click the header "Refresh data" button to manually re-fetch all projects.

**Q: Auto-update shows dev mode / can't connect?**
Auto-update only works in **packaged builds**; the update source is GitHub Releases (repo `bynow2code/env-switch`). Dev mode only shows a hint and does not go online. If the repo is private, you must supply a token in the update source config.

**Q: Port occupied / multiple windows talking to each other?**
The desktop app's backend listens on port `0` (OS-assigned), and the app uses a single-instance lock: a second launched instance focuses the existing window instead of starting another backend, fundamentally preventing port contention and cross-talk.
