/**
 * PM2 Ecosystem Configuration
 * https://pm2.keymetrics.io/docs/usage/application-declaration/
 *
 * App name: printfarm-planner
 * Port: 3457 (internal — Nginx sits in front)
 */

module.exports = {
  apps: [
    {
      // --- Identity ---
      name: 'printfarm-planner',
      script: 'server.js',

      // --- Runtime ---
      interpreter: 'node',
      instances: 1,            // Single instance (SQLite is not multi-process-safe)
      exec_mode: 'fork',       // Required for SQLite

      // --- Environment ---
      env: {
        NODE_ENV: 'production',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3457,
      },

      // --- Restart policy ---
      autorestart: true,
      watch: false,             // Never watch in production
      max_memory_restart: '256M',
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '10s',

      // --- Logging ---
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',

      // --- Graceful shutdown ---
      kill_timeout: 10000,
      listen_timeout: 5000,
    },
  ],
};
