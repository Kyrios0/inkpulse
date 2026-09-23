import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const project = join(root, "firmware", "e1001");
const command = process.argv[2] ?? "build";
const localPio = join(
  root,
  ".tmp",
  "pio-venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "pio.exe" : "pio",
);
const pio = existsSync(localPio) ? localPio : "pio";
const localCore = join(root, ".tmp", "platformio-core");
const env = { ...process.env };
if (!env.PLATFORMIO_CORE_DIR && existsSync(localCore)) {
  env.PLATFORMIO_CORE_DIR = localCore;
}

const actions = {
  build: ["run", "--project-dir", project],
  upload: ["run", "--project-dir", project, "--target", "upload"],
  monitor: ["device", "monitor", "--project-dir", project, "--baud", "115200"],
};
const args = actions[command];
if (!args) {
  console.error(`Unknown firmware action: ${command}`);
  process.exit(2);
}

const result = spawnSync(pio, args, { env, stdio: "inherit" });
if (result.error?.code === "ENOENT") {
  console.error("PlatformIO is missing. Install PlatformIO Core, then retry.");
  process.exit(2);
}
if (result.error) throw result.error;
process.exit(result.status ?? 1);
