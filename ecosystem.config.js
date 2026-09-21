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
        TZ: 'Asia/Ho_Chi_Minh',
        // Thư mục chứa bản gốc hoá đơn (ZIP + PDF) — dùng chung với detail worker
        INVOICE_STORAGE_DIR: '/opt/INVONESOURCE/storage/invoices',
      },
      error_file: '/opt/INVONESOURCE/logs/backend-error.log',
      out_file: '/opt/INVONESOURCE/logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ─── Frontend (Next.js) ────────────────────────────────────────────────────
    {
      name: 'invone-frontend',
      cwd: '/opt/INVONESOURCE/frontend',
      script: '../node_modules/next/dist/bin/next',
      args: 'start',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '768M',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        TZ: 'Asia/Ho_Chi_Minh',
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
        TZ: 'Asia/Ho_Chi_Minh',
      },
      error_file: '/opt/INVONESOURCE/logs/bot-error.log',
      out_file: '/opt/INVONESOURCE/logs/bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ─── GDT Detail Worker (Phase 2 — async detail fetch) ────────────────────
    // Polls invoice_detail_queue, fetches /detail JSON, inserts line_items.
    // Separate process from invone-bot (Phase 1 = list sync).
    // One crash here NEVER affects list sync (invone-bot).
    {
      name: 'invone-detail-worker',
      cwd: '/opt/INVONESOURCE/bot',
      script: 'node',
      args: '-r dotenv/config dist/detail.worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Ho_Chi_Minh',
        // Nơi lưu gói bản gốc từ GDT + bản thể hiện PDF đã render
        INVOICE_STORAGE_DIR: '/opt/INVONESOURCE/storage/invoices',
      },
      error_file: '/opt/INVONESOURCE/logs/detail-worker-error.log',
      out_file: '/opt/INVONESOURCE/logs/detail-worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ─── MST Verification Worker (tra cứu trạng thái NNT tại cổng Cục Thuế) ──
    // Queue 'company-verification' + vòng quét định kỳ MST hết hạn cache.
    // Tách riêng process: lỗi tra cứu MST không bao giờ ảnh hưởng sync hoá đơn.
    // Bắt buộc proxy + 2Captcha — không tra bằng IP server.
    {
      name: 'invone-verify-worker',
      cwd: '/opt/INVONESOURCE/bot',
      script: 'node',
      args: '-r dotenv/config dist/verification.worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '384M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Ho_Chi_Minh',
      },
      error_file: '/opt/INVONESOURCE/logs/verify-worker-error.log',
      out_file: '/opt/INVONESOURCE/logs/verify-worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
