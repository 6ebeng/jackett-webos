# Prowlarr for webOS

Run [Prowlarr](https://github.com/Prowlarr/Prowlarr) (indexer manager/proxy) **inside your LG TV**, the same way [TorrServer](https://github.com/YouROK/TorrServer) runs on the TV. This packages Prowlarr as a webOS homebrew app (`.ipk`): a small TV launcher UI plus a background service that downloads, runs and supervises the official self-contained Prowlarr build.

You then manage Prowlarr from any device on your LAN at `http://<tv-ip>:9696` and pair it with Sonarr/Radarr/your download client as usual.

> Tested target: a **rooted** webOS TV (Homebrew Channel) at `10.5.50.13`, SSH `root` / `alpine`.

---

## How it works

```
┌─────────────────────────── webOS TV ───────────────────────────┐
│  com.prowlarr.app          (web app – the tile + control UI)    │
│        │  luna bus                                              │
│        ▼                                                        │
│  com.prowlarr.app.service  (node service)                       │
│        │  spawns                                                │
│        ▼                                                        │
│        │                                                        │
│        ▼                                                        │
│  Prowlarr listens on 0.0.0.0:9696  ◀── manage from your PC      │
└─────────────────────────────────────────────────────────────────┘
```

- **No huge `.ipk`.** Prowlarr (~95 MB, bundles its own .NET runtime) is downloaded on first **Start** directly on the TV resolving GLIBC differences by natively loading Alpine Linux `musl` build dependencies isolated inside the bundle.
- Data (config, database, logs) is stored in the first writable + exec-capable path among `/media/developer/prowlarr`, `/home/root/prowlarr`, `/media/internal/.prowlarr`, `/tmp/prowlarr`.
- The process is detached (`nohup`), so it keeps running after you close the app. Optional boot autostart is provided.

---

## Prerequisites

On your **PC** (Windows):

- [Node.js](https://nodejs.org/) (includes `npm`/`npx`) — used only to build the package.
- That's it. `scripts/build.ps1` installs `@webosose/ares-cli` locally on first run.
- For deploying over SSH, either the built-in Windows **OpenSSH** (`ssh`/`scp`) or **PuTTY** (`plink`/`pscp`, enables passwordless `-pw` automation).

On your **TV**:

- A **rooted** webOS TV with the **Homebrew Channel** installed (this is how root SSH `root`/`alpine` and the `elevate-service` helper are available).
- Network access (to download Prowlarr on first launch).

---

## Build

```powershell
npm run build
# or:  powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

This generates icons, vendors the service dependency, normalises the shell scripts to LF, and produces `dist\com.prowlarr.app_1.0.0_all.ipk`.

## Deploy to the TV

```powershell
# Build + copy + install + elevate the service to root:
npm run deploy

# Also install the boot autostart hook:
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -Autostart

# Different address / credentials:
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -TVHost 10.5.50.13 -User root -Password alpine
```

What the deploy script does over SSH:

1. `scp` the `.ipk` to `/tmp/prowlarr.ipk`.
2. Install it via `com.webos.appInstallService/dev/install`.
3. Run the Homebrew Channel **`elevate-service`** for `com.prowlarr.app.service` so it may execute the binary and write its data dir.
4. _(with `-Autostart`)_ copy `prowlarr-autostart` to `/var/lib/webosbrew/init.d/prowlarr`.

> If you have OpenSSH (no PuTTY), you'll be prompted for the `alpine` password a few times. Install PuTTY to avoid prompts.

### Alternative: webOS CLI (ares)

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-device.ps1
node_modules\.bin\ares-install -d prowlarrtv dist\com.prowlarr.app_1.0.0_all.ipk
```

---

## Usage

1. Launch **Prowlarr** from the TV's app list.
2. Press **Start**. First launch downloads Prowlarr (watch the status badge: `downloading → extracting → running`).
3. Manage it from your computer/phone at **`http://<tv-ip>:9696`** (e.g. `http://10.5.50.13:9696`).

UI buttons: **Start / Stop / Restart / Update** (pulls the newest Prowlarr release), **Open Web UI** (opens the UI on the TV), **Logs**.

---

## Security notes

- Prowlarr binds to **all interfaces** so you can reach it from your LAN. On first visit, **set an authentication method / admin account** in Prowlarr (Settings → General → Security). Keep it on your trusted network; do not port-forward it to the internet.
- The TV's SSH (`root`/`alpine`) is a well-known default. If this TV is reachable by others, change that password.
- The service runs as root (required to execute the downloaded binary and persist data on most firmwares). It only manages the Prowlarr process.

---

## Troubleshooting

| Symptom                                          | Fix                                                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Badge stuck on `downloading`                     | TV has no internet, or GitHub is blocked. Check **Logs**; the data dir keeps `release.json`.                                                         |
| `error:asset`                                    | No build matched the CPU. Run `uname -m` on the TV; `x86_64` TVs use `linux-core-x64` (already handled), exotic arches aren't published by Prowlarr. |
| Starts then exits (`error:launch`)               | Open **Logs**. Usually a permissions issue — ensure `elevate-service` ran (re-run `npm run deploy`).                                                 |
| Can't reach `:9696` from PC                      | Confirm the badge says **Running** and use the exact **Access URL** shown in the app.                                                                |
| Service methods do nothing on older webOS (≤3.x) | Native/JS service permissions need the Homebrew Channel `elevate-service` step — re-run deploy.                                                      |

Inspect things directly over SSH:

```sh
DIR=$(sh /media/developer/apps/usr/palm/services/com.prowlarr.app.service/prowlarr-run.sh datadir)
cat "$DIR/state"; tail -n 100 "$DIR/prowlarr.log"
```

---

## Project layout

```
appinfo/                webOS web app (the TV tile + control UI)
  appinfo.json
  index.html  css/  js/
service/                background control service
  services.json  package.json
  service.js            luna <-> shell bridge (node)
  prowlarr-run.sh       arch detect, download, run, supervise
  download.js           node download fallback (no curl/wget)
  prowlarr-autostart    boot hook for /var/lib/webosbrew/init.d
scripts/                make-icons / build / deploy / setup-device (PowerShell)
```

## Credits & licence

- [Prowlarr](https://github.com/Prowlarr/Prowlarr) — the indexer manager that this app downloads and runs (GPL-3.0). This project does **not** redistribute Prowlarr; it fetches official releases at runtime.
- Packaging pattern inspired by [PicCap](https://github.com/TBSniller/piccap) / [hyperion-webos](https://github.com/webosbrew/hyperion-webos) and the [webOS Homebrew](https://www.webosbrew.org/) project.
- This wrapper: MIT.




