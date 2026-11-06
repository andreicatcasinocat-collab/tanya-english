import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const config = {
  botToken: process.env.BOT_TOKEN || '',
  adminIds: (process.env.ADMIN_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  port: Number(process.env.PORT || 8080),
  webAppUrl: (process.env.WEBAPP_URL || '').replace(/\/$/, ''),
  tz: process.env.TZ_NAME || 'Europe/Moscow',
  devMode: process.env.DEV_MODE === '1',
  // Адрес мини-приложения на GitHub Pages (фронтенд). API отдаётся через туннель Cloudflare.
  pagesUrl: (process.env.PAGES_URL || '').replace(/\/$/, ''),
  tunnel: process.env.TUNNEL === '1',
  adminCode: process.env.ADMIN_CODE || '',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'teacher.db'),
};

export const isAdmin = (id) => config.adminIds.includes(Number(id));
