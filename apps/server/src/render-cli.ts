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

// Exercise exception styling without changing the standard healthy preview.
const exceptions = createMockDashboardData();
exceptions.battery!.devices[0]!.percent = 20;
exceptions.battery!.devices[1]!.observedAt = "2026-09-21T11:00:00Z";
exceptions.battery!.devices[2]!.connected = false;
const exceptionPage = (await renderPageSet(exceptions)).pages.get("overview")!;
const exceptionPath = resolve(outputDirectory, "overview-states.png");
await writeFile(exceptionPath, exceptionPage.png);
console.log(`overview-states: ${exceptionPath} (${exceptionPage.png.length} bytes)`);
