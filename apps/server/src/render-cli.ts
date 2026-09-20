import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createMockDashboardData } from "./data.js";
import { renderPageSet } from "./renderer.js";

const outputDirectory = resolve("output", "mock");
const pageSet = await renderPageSet(createMockDashboardData());

await mkdir(outputDirectory, { recursive: true });
for (const page of pageSet.pages.values()) {
  const outputPath = resolve(outputDirectory, `${page.id}.png`);
  await writeFile(outputPath, page.png);
  console.log(`${page.id}: ${outputPath} (${page.png.length} bytes)`);
}
