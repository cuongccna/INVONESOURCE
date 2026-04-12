// PM2 Ecosystem Config — INVONE Platform
// Production: /opt/INVONESOURCE/
// Domain: autopostvn.cloud | api.autopostvn.cloud

'use strict';

module.exports = {
  apps: [
    // ─── Backend API (Express) ────────────────────────────────────────────────
    {
      name: 'invone-backend',
      cwd: '/opt/INVONESOURCE/backend',
      script: 'node',
      args: '-r dotenv/config dist/src/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/opt/INVONESOURCE/logs/backend-error.log',
      out_file: '/opt/INVONESOURCE/logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ─── Frontend (Next.js) ────────────────────────────────────────────────────
    {
      name: 'invone-frontend',
      cwd: '/opt/INVONESOURCE/frontend',
      script: 'node',
      args: 'start',//'node_modules/.bin/next start -p 3000',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '768M',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
      },
      error_file: '/opt/INVONESOURCE/logs/frontend-error.log',
      out_file: '/opt/INVONESOURCE/logs/frontend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ─── GDT Bot Worker (BullMQ, no HTTP port) ────────────────────────────────
    {
      name: 'invone-bot',
      cwd: '/opt/INVONESOURCE/bot',
      script: 'node',
      // dotenv/config reads bot/.env (symlink → /opt/INVONESOURCE/.env)
      args: '-r dotenv/config dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/opt/INVONESOURCE/logs/bot-error.log',
      out_file: '/opt/INVONESOURCE/logs/bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
