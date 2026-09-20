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
      },
    },
  ],
};
