# Running Oracle Trader on Linux

Status 2026-11-10: the same code base runs on Windows (BEAST, live) and Ubuntu 24.04 (the GT73VR laptop, paper test).
There is no separate Linux branch: the app is Electron and Node, and the differences are in how it is launched and
in the Windows-only helper scripts listed below.

## Setting up a Linux machine

1. Node 24 on the PATH (a user-level install under `~/.local` is enough; no root).
2. Copy the repository (git clone, or a tarball without `node_modules`, `out`, `data`, `tmp`, `logs`).
3. `npx pnpm@9 install --frozen-lockfile`, then `node node_modules/electron-vite/bin/electron-vite.js build`.
4. Electron's sandbox helper must be owned by root and setuid on Ubuntu 24.04, or the app aborts at start:
   `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`.
   Do not start it with `--no-sandbox` instead.
5. Start it on a display: `DISPLAY=:0 node_modules/electron/dist/electron .` from a logged-in desktop session
   (or under Xvfb on a server: `sudo apt install xvfb`, then `xvfb-run -a node_modules/electron/dist/electron .`).
6. App data lives in `~/.config/oracle-trader`. A fresh install starts in **paper** mode with the auto-trader off.
   Keys are stored with Electron safeStorage, which on Linux uses the desktop keyring, so they are re-entered in the
   app's panel on each new machine; Windows-encrypted values in a copied `config.json` cannot be read.
7. Status page: `node scripts/status-page.mjs --dir ~/.config/oracle-trader --port 8787`.

Never run two live copies against the same Kalshi or Polymarket account: every trade would be placed twice.

## Still Windows-only

| Piece | Windows mechanism | Linux replacement to build |
|---|---|---|
| App autostart and restart | Task Scheduler (`Oracle - Trader app`) | systemd user unit with `Restart=always` |
| Recorders, sentinel, backup, hourly jobs | Task Scheduler (`OracleTrader-*`) | systemd user timers / services |
| `crypto15-shadow.cmd`, `ladder15-shadow.cmd`, `mmsim.cmd` | `start /min` launchers | call `node scripts/<name>.mjs` directly |
| Recorder single-instance lock (`scripts/recorder-lock.mjs`) | Windows process scan | `/proc` scan (`test:recorder-lock` fails on Linux until then) |
| Sentinel (`scripts/sentinel.mjs`) | `schtasks`, `tasklist`, PowerShell | `systemctl --user`, `pgrep` |
| Maintenance and repair (`*.ps1`) | PowerShell + Claude CLI | bash; currently off on BEAST too |
| State backup (`scripts/state-backup.py`, `win_share`) | `python`, Windows share-mode reads | `python3`, plain reads |
| IB Gateway | IBC Windows task | IBC on Linux (supported) |

Linux test results at the time of writing: 18 of 22 test suites pass. The four failures are `backup-share` (`python`
vs `python3`), `recorder-lock` (Windows process scan), `review` (one test expects the Windows `EPERM` code for a held
file where Linux reports `EACCES`) and `task-watch` (needs a weather-recorder data folder that a fresh machine lacks).
