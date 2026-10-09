# Deployment

```sh
npm run deploy:dry-run      # build, test, validate config; no SSH
npm run deploy:bootstrap    # first deploy: also installs Node.js and PM2 for the app user
npm run deploy              # later releases
npm run monitor:production  # probe the live API (needs the monitor variables below)
```

Restart the Windows collector after collector changes (skip `Stop-ScheduledTask` on first install):

```powershell
npm run build
Stop-ScheduledTask -TaskName "InkPulse Codex Collector"
& ./scripts/install-windows-collector-task.ps1
```

Firmware: `npm run firmware:upload` ([guide](../firmware/e1001/README.md)). Layout changes are server-only; no flash needed.

## Prerequisites

- Node.js 22+, `bash`, `ssh`, `rsync`. On Windows these run inside the configured WSL distro with its SSH keys.
- An unprivileged, key-only SSH account. TLS/Nginx, firewall, rate limits, and the PM2 systemd startup unit
  are provisioned separately; deploy does not create them.

## Configure

Copy [deploy.example.json](../config/deploy.example.json) to ignored `config/deploy.local.json` and set
`sshHost`, `sshUser`, `servicePath` (under `/home/<sshUser>/services/`), `listenPort`, and on Windows
`wslDistribution`. `listenHost` and `publicBaseUrl` are unused; the service always binds to loopback.

Create `SERVICE_PATH/shared/runtime.env`, mode 600, owned by the app user:

```sh
INKPULSE_DEVICE_TOKEN=replace-with-a-random-token
INKPULSE_AI_INGEST_TOKEN=replace-with-a-different-random-token
INKPULSE_STOCK_SYMBOLS=AAPL,MSFT
```

The server refuses to start in production without a device token. Without an ingest token, uploads and
presence tracking are off. Keep account credentials on the PC, never in deploy JSON or PM2 files.

## What deploy does

Tests locally, copies a new release, runs `npm ci --omit=dev` on the host, switches `current`, and restarts
PM2. A failed loopback health check restores the previous release. Caches persist in `shared/data`; old
releases are kept for recovery. Bootstrap verifies the Node.js checksum and needs no sudo. CI never deploys.

## Collector

First install: create the PC's `.env.local` and optional battery config ([data sources](data-sources.md)),
then run the install script above. The task, still named "Codex Collector", runs the combined collector at
sign-in without admin rights.

## Monitoring

Set repository variable `INKPULSE_PUBLIC_BASE_URL` and secret `INKPULSE_MONITOR_DEVICE_TOKEN` (read-only)
to enable the five-minute GitHub monitor; without the URL it skips. It checks health, auth, manifest
freshness, both PNGs, ETags, and revalidation, and never needs the write token.

## Two-page upgrade

Deploy the server before flashing new firmware. Old firmware accepts the two-page manifest; new firmware
migrates its cache and drops the retired AI page. AI ingest and the Overview's AI section are unchanged.
