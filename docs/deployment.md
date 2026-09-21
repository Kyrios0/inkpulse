# Deployment

InkPulse uses one Node.js deployment command on Windows and Linux. On Windows,
the transport adapter runs `ssh` and `rsync` through the configured WSL distro;
on Linux, it uses the native commands. The live `current` symlink changes only
after a release has been copied and its Linux production dependencies have
installed successfully.

Requirements:

- Windows: Node.js plus a WSL distribution containing `bash`, `ssh`, and
  `rsync`. Set `wslDistribution` in the local deployment config.
- Linux: Node.js plus native `bash`, `ssh`, and `rsync` commands.

## Configuration

Copy `config/deploy.example.json` to `config/deploy.local.json` and set the SSH
host, unprivileged SSH user, service path, loopback port, and eventual public
URL. The local file is gitignored.

Runtime credentials belong in this untracked file on the deployment host:

```text
SERVICE_PATH/shared/runtime.env
```

Use shell assignment syntax and restrict the file to its owning user:

```sh
INKPULSE_DEVICE_TOKEN=replace-with-a-random-token
INKPULSE_CODEX_INGEST_TOKEN=replace-with-a-different-random-token
```

The file is sourced immediately before PM2 starts or reloads the service. Do
not put runtime credentials in the deployment JSON or PM2 configuration.
Persistent stock and Codex caches live under `SERVICE_PATH/shared/data`; they
survive atomic release changes and are writable only by the application user.
The PM2 definition forwards only the documented `INKPULSE_*` settings rather
than copying the deployment shell's complete environment.

## First deployment

The isolated application account needs its own Node.js and PM2 runtime. Install
the pinned LTS runtime and deploy with one command from PowerShell:

```powershell
npm run deploy:bootstrap
```

The bootstrap downloads Node.js from the official release site, verifies the
published SHA-256 checksum, installs it below the remote user's home directory,
and installs PM2 without sudo.

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
5. Start or reload the service with PM2.
6. Check the loopback health endpoint and restore the previous release on
   failure.

Old releases are retained for recovery. Cleanup is intentionally a separate,
explicit maintenance operation.

The same `npm run deploy` entry point can be called by Linux CI later. CI
integration is deliberately deferred until repository ownership, protected
environments, and deployment-secret handling are decided.
