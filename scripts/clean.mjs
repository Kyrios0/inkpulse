import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = resolve(projectRoot, "dist");

if (dirname(buildDirectory) !== projectRoot || basename(buildDirectory) !== "dist") {
  throw new Error(`Refusing to clean unexpected path: ${buildDirectory}`);
}

await rm(buildDirectory, { force: true, recursive: true });
