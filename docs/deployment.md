# Deployment

## Prerequisites

- Node.js 22+ (CI uses 24), `bash`, `ssh`, and `rsync`.
- Windows uses the configured WSL distro's SSH keys/configuration; Linux uses native tools.
- An unprivileged, key-only SSH account and writable service directory.
- Separately provision TLS/Nginx, firewall/rate limits, and the user's PM2 systemd
  startup unit. Deployment does not create these or configure reboot persistence.

## Configuration

Copy [deploy.example.json](../config/deploy.example.json) to ignored
`config/deploy.local.json`. Set `sshHost`, `sshUser`, `servicePath`,
`listenPort`, and Windows `wslDistribution`. SSH must work non-interactively.
The service path must be under `/home/<sshUser>/services/`.

Deployment binds to loopback; example fields `listenHost` and `publicBaseUrl`
are unused. Configure the public origin separately for collector, firmware, and monitor.

Create `SERVICE_PATH/shared/runtime.env`, owned by the app user with mode 600:

```sh
INKPULSE_DEVICE_TOKEN=replace-with-a-random-token
INKPULSE_AI_INGEST_TOKEN=replace-with-a-different-random-token
INKPULSE_STOCK_SYMBOLS=AAPL,MSFT
```

Choose your own 1–12 symbols and nonempty, distinct tokens. The server refuses to
start in production without a display token (outside production a missing
display token allows unauthenticated reads); missing ingest tokens disable
writes and presence tracking. Keep account
credentials on the PC. Never put secrets in deployment JSON or PM2 definitions.

Runtime settings are sourced before PM2 starts. Caches persist under
`shared/data`; device names stay in ignored PC configuration. Existing
`/api/v1/metrics/codex` ingress accepts combined AI, battery, and presence reports.

## Deploy and verify

```sh
npm run deploy:dry-run    # Build/tests/config validation; no SSH connection
npm run deploy:bootstrap  # First deployment: install isolated Node.js/PM2 too
npm run deploy            # Subsequent releases
```

Bootstrap verifies the official Node.js download checksum and installs without
sudo. Deployment tests locally, copies a new release, installs Linux production
dependencies, switches `current`, and replaces the PM2 process. A failed loopback
health check restores the previous release. Old releases remain for recovery;
cleanup is separate. CI validates changes but does not deploy.

## Update the PC or device

Server deployment neither restarts the collector nor flashes firmware.
After collector changes, rebuild and restart its process. On Windows:

```powershell
npm run build
Stop-ScheduledTask -TaskName "InkPulse Codex Collector"
& ./scripts/install-windows-collector-task.ps1
```

For first installation, omit `Stop-ScheduledTask`; create PC `.env.local`
and optional battery configuration first ([collector setup](data-sources.md)).
The legacy-named task runs the combined collector at sign-in without admin rights.

Firmware changes: `npm run firmware:upload` ([guide](../firmware/e1001/README.md)).
Server-rendered layout changes need no flash.

## Monitoring

Set repository variable `INKPULSE_PUBLIC_BASE_URL` and read-only secret
`INKPULSE_MONITOR_DEVICE_TOKEN` to enable the five-minute GitHub monitor.
Without the URL the job skips. Scheduled runs may be delayed.

Locally, provide those environment variables and run `npm run monitor:production`.
It checks HTTPS health, authentication, manifest freshness, two PNGs, ETags,
and cache revalidation. It never needs the write token or account credentials.

For the two-page upgrade, deploy the server before flashing new firmware and
update the monitor alongside it. Previous firmware accepts two-page manifests;
new firmware migrates legacy caches, dropping the retired AI page. AI ingest
and the Overview's AI section are unchanged.
