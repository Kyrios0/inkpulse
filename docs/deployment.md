# Deployment

InkPulse uses one Node.js deployment command on Windows and Linux. On Windows,
the transport adapter runs `ssh` and `rsync` through the configured WSL distro;
on Linux, it uses the native commands. The live `current` symlink changes only
after a release has been copied and its Linux production dependencies have
installed successfully.

Requirements:

- Node.js 22 or newer (CI uses 24).
- Windows: a WSL distribution containing `bash`, `ssh`, and
  `rsync`. Set `wslDistribution` in the local deployment config.
- Linux: Node.js plus native `bash`, `ssh`, and `rsync` commands.

## Configuration

Copy `config/deploy.example.json` to `config/deploy.local.json` and set `sshHost`,
`sshUser`, `servicePath`, `listenPort`, and (on Windows) `wslDistribution`.
The local file is gitignored. SSH must work non-interactively in the transport
environment: Windows deployments use WSL's SSH configuration and keys, not native
Windows SSH. `servicePath` must be under `/home/<sshUser>/services/`.
The deploy script binds to loopback; the example's `listenHost` and `publicBaseUrl`
fields are not consumed by it. Configure the public origin separately in the
collector, firmware, and monitor.

Runtime credentials belong in this untracked file on the deployment host:

```text
SERVICE_PATH/shared/runtime.env
```

Use shell assignment syntax and restrict the file to its owning user:

```sh
INKPULSE_DEVICE_TOKEN=replace-with-a-random-token
INKPULSE_AI_INGEST_TOKEN=replace-with-a-different-random-token
INKPULSE_STOCK_SYMBOLS=AAPL,MSFT
```

Choose your own 1-12 stock symbols; the server has no default watchlist.
The file is sourced immediately before PM2 starts the service. Do
not put runtime credentials in the deployment JSON or PM2 configuration.
The existing Nginx `/api/v1/metrics/codex` location also carries the combined
AI usage, battery, and presence payload; no additional public ingest route is required.
Persistent stock, Codex, Claude, and battery caches live under `SERVICE_PATH/shared/data`; they
survive atomic release changes and are writable only by the application user.
The PM2 definition forwards only the documented `INKPULSE_*` settings rather
than copying the deployment shell's complete environment.
Battery device-name configuration stays on the PC and is not deployed. Updating
this feature requires the server and PC collector builds, but no firmware flash.

## First deployment

Before deploying, create the unprivileged SSH account, service directory, and
private `shared/runtime.env` (mode 600). Both tokens must be nonempty and distinct.
The app allows unauthenticated display reads if its display token is absent;
missing ingest credentials disable uploads. Do not expose that development mode.

The isolated application account needs its own Node.js and PM2 runtime. Install
the pinned LTS runtime and deploy with one command from PowerShell:

```powershell
npm run deploy:bootstrap
```

The bootstrap downloads Node.js from the official release site, verifies the
published SHA-256 checksum, installs it below the remote user's home directory,
and installs PM2 without sudo.

Separately configure TLS/reverse proxying, public rate limits, and the PM2
systemd startup unit. Bootstrap does not provision accounts, Nginx, certificates,
firewall rules, or reboot persistence. Keep provider/account credentials on the
PC; only the InkPulse display and ingest tokens belong on the host.

## Later deployments

```powershell
npm run deploy
```

Validate the local build, configuration, and platform adapter without opening
an SSH connection:

```powershell
npm run deploy:dry-run
```

The deployment performs the following operations:

1. Run the complete local build and test suite.
2. Copy `dist`, package manifests, and the PM2 definition into a new release.
3. Run `npm ci --omit=dev` remotely so native packages match Linux.
4. Atomically point `current` at the new release.
5. Replace the PM2 process so it runs the new release's script path.
6. Check the loopback health endpoint and restore the previous release on
   failure.

Old releases are retained for recovery. Cleanup is intentionally a separate,
explicit maintenance operation.

Server deployment does not restart the PC collector or flash the E1001. After
collector changes, rebuild locally and restart its running process. On Windows:

```powershell
Stop-ScheduledTask -TaskName "InkPulse Codex Collector"
& ./scripts/install-windows-collector-task.ps1
```

For first installation, run only the script after creating the PC's `.env.local`
with the ingest URL/token and optional `config/battery.local.json`. The legacy
task name is retained; it runs the combined AI/battery collector at sign-in.
Use native Windows for Bluetooth and input/lock detection. Firmware changes use
`npm run firmware:upload`; server-rendered layout changes need no flash.

The same `npm run deploy` entry point can be called by Linux CI later. CI
currently validates changes but does not deploy them. Production deployments
remain an explicit local operation until protected-environment and rollback
policies are chosen.

## Availability monitoring

The GitHub Actions production monitor runs the same `npm run
monitor:production` probe available to local operators. It uses only the public
base URL and the read-only device token. GitHub scheduling is a useful external
availability signal. Set repository variable `INKPULSE_PUBLIC_BASE_URL` to opt in
and secret `INKPULSE_MONITOR_DEVICE_TOKEN` for authentication. Without the URL,
the job is skipped. Scheduled runs are not a real-time guarantee and can be delayed.

PM2 restarts the Node.js process after application crashes. The deployment host
must also have the PM2-generated systemd startup unit enabled so the saved
process list returns after a host reboot.
