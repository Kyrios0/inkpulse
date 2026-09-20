import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const configPath = isAbsolute(options.configPath)
  ? options.configPath
  : resolve(projectRoot, options.configPath);
const config = JSON.parse(readFileSync(configPath, "utf8"));

validateConfig(config);

runNpm(options.skipTests ? ["run", "build"] : ["test"]);

const remote = `${config.sshUser}@${config.sshHost}`;
const platform = createPlatformAdapter(config);
const releaseId = `${formatUtcTimestamp(new Date())}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;

if (options.dryRun) {
  console.log(
    JSON.stringify(
      {
        bootstrapRuntime: options.bootstrapRuntime,
        platform: process.platform,
        releaseId,
        remote,
        servicePath: config.servicePath,
        transportProjectRoot: platform.projectRoot,
      },
      null,
      2,
    ),
  );
} else {
  if (options.bootstrapRuntime) {
    const bootstrapScript = readFileSync(
      join(projectRoot, "scripts", "bootstrap-remote-runtime.sh"),
      "utf8",
    );
    platform.runSsh(remote, ["bash", "-s", "--", "24.21.0"], bootstrapScript);
  }

  platform.runDeployScript([
    platform.projectRoot,
    config.sshHost,
    config.sshUser,
    config.servicePath,
    String(config.listenPort),
    releaseId,
  ]);
}

function createPlatformAdapter(config) {
  if (process.platform !== "win32") {
    return {
      projectRoot,
      runDeployScript(args) {
        run("bash", [join(projectRoot, "scripts", "deploy-rsync.sh"), ...args]);
      },
      runSsh(remote, args, input) {
        run("ssh", ["-o", "BatchMode=yes", remote, ...args], { input });
      },
    };
  }

  const distribution = config.wslDistribution || "Ubuntu";
  if (!/^[A-Za-z0-9._-]+$/.test(distribution)) {
    throw new Error("Invalid wslDistribution");
  }

  const wslProjectRoot = capture("wsl.exe", [
    "-d",
    distribution,
    "--",
    "wslpath",
    "-a",
    "-u",
    projectRoot.replaceAll("\\", "/"),
  ]).trim();
  if (!wslProjectRoot.startsWith("/")) {
    throw new Error("Could not translate the project path for WSL");
  }

  return {
    projectRoot: wslProjectRoot,
    runDeployScript(args) {
      run("wsl.exe", [
        "-d",
        distribution,
        "--",
        "bash",
        `${wslProjectRoot}/scripts/deploy-rsync.sh`,
        ...args,
      ]);
    },
    runSsh(remote, args, input) {
      run(
        "wsl.exe",
        [
          "-d",
          distribution,
          "--",
          "ssh",
          "-o",
          "BatchMode=yes",
          remote,
          ...args,
        ],
        { input },
      );
    },
  };
}

function parseArguments(args) {
  const parsed = {
    bootstrapRuntime: false,
    configPath: "config/deploy.local.json",
    dryRun: false,
    skipTests: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--bootstrap-runtime") {
      parsed.bootstrapRuntime = true;
    } else if (argument === "--dry-run") {
      parsed.dryRun = true;
    } else if (argument === "--skip-tests") {
      parsed.skipTests = true;
    } else if (argument === "--config") {
      const value = args[index + 1];
      if (!value) throw new Error("--config requires a path");
      parsed.configPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown deployment argument: ${argument}`);
    }
  }

  return parsed;
}

function validateConfig(config) {
  if (!/^[A-Za-z0-9.-]+$/.test(config.sshHost ?? "")) {
    throw new Error("Invalid sshHost");
  }
  if (!/^[a-z_][a-z0-9_-]*$/.test(config.sshUser ?? "")) {
    throw new Error("Invalid sshUser");
  }

  const escapedUser = escapeRegularExpression(config.sshUser);
  const servicePathPattern = new RegExp(
    `^/home/${escapedUser}/services/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$`,
  );
  if (
    !servicePathPattern.test(config.servicePath ?? "") ||
    config.servicePath.includes("..")
  ) {
    throw new Error(`servicePath must be below /home/${config.sshUser}/services/`);
  }

  if (
    !Number.isInteger(config.listenPort) ||
    config.listenPort < 1 ||
    config.listenPort > 65_535
  ) {
    throw new Error("Invalid listenPort");
  }
}

function formatUtcTimestamp(date) {
  return date
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  assertSuccess(command, result);
  return result.stdout;
}

function runNpm(args) {
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, ...args]);
    return;
  }

  if (process.platform === "win32") {
    run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...args]);
    return;
  }

  run("npm", args);
}

function run(command, args, { cwd = projectRoot, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
  assertSuccess(command, result);
}

function assertSuccess(command, result) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}
