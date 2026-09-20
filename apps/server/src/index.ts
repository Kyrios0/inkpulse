import { createMockDashboardData } from "./data.js";
import { renderPageSet } from "./renderer.js";
import { createInkPulseServer } from "./server.js";

const host = process.env.INKPULSE_LISTEN_HOST ?? "127.0.0.1";
const port = parsePort(process.env.INKPULSE_LISTEN_PORT ?? "3810");
const pageSet = await renderPageSet(createMockDashboardData(new Date()));
const displayToken = process.env.INKPULSE_DEVICE_TOKEN;
const server = createInkPulseServer(
  pageSet,
  displayToken ? { displayToken } : {},
);

server.listen(port, host, () => {
  console.log(`InkPulse listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  });
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid INKPULSE_LISTEN_PORT: ${value}`);
  }
  return port;
}
