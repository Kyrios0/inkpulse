const forwardedEnvironment = {};
for (const name of [
  "INKPULSE_AI_INGEST_TOKEN",
  "INKPULSE_CLAUDE_STALE_SECONDS",
  // Keep existing deployments working until runtime.env is renamed.
  "INKPULSE_CODEX_INGEST_TOKEN",
  "INKPULSE_CODEX_STALE_SECONDS",
  "INKPULSE_DATA_DIR",
  "INKPULSE_DEVICE_TOKEN",
  "INKPULSE_DISPLAY_REFRESH_SECONDS",
  "INKPULSE_STOCK_REFRESH_SECONDS",
  "INKPULSE_STOCK_SYMBOLS",
]) {
  if (process.env[name]) forwardedEnvironment[name] = process.env[name];
}

module.exports = {
  apps: [
    {
      name: "inkpulse",
      cwd: __dirname,
      script: "dist/apps/server/src/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "256M",
      env_production: {
        NODE_ENV: "production",
        INKPULSE_LISTEN_HOST: process.env.INKPULSE_LISTEN_HOST || "127.0.0.1",
        INKPULSE_LISTEN_PORT: process.env.INKPULSE_LISTEN_PORT || "3810",
        ...forwardedEnvironment,
      },
    },
  ],
};
