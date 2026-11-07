// Запуск на компьютере (Mac): long polling + локальный сервер + (опционально) туннель Cloudflare.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from './core/store.js';
import { createBot } from './core/bot.js';
import { createApi } from './core/api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const cfg = {
  botToken: process.env.BOT_TOKEN || '',
  adminIds: new Set((process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number)),
  adminCode: process.env.ADMIN_CODE || '',
  tz: process.env.TZ_NAME || 'Asia/Ho_Chi_Minh',
  port: Number(process.env.PORT || 8080),
  webAppUrl: (process.env.WEBAPP_URL || '').replace(/\/$/, ''),
  pagesUrl: (process.env.PAGES_URL || '').replace(/\/$/, ''),
  tunnel: process.env.TUNNEL === '1',
  devMode: process.env.DEV_MODE === '1',
};
const dbPath = process.env.DB_PATH || path.join(ROOT, 'data', 'app.db');
await mkdir(path.dirname(dbPath), { recursive: true });

// ---------- SQLite-адаптер ----------
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
// Миграции: применяем по порядку, запоминаем применённые
db.exec('CREATE TABLE IF NOT EXISTS node_migrations (name TEXT PRIMARY KEY)');
for (const f of readdirSync(path.join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
  if (db.prepare('SELECT 1 FROM node_migrations WHERE name = ?').get(f)) continue;
  try { db.exec(readFileSync(path.join(ROOT, 'migrations', f), 'utf8')); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  db.prepare('INSERT INTO node_migrations(name) VALUES (?)').run(f);
}
const sql = {
  all: async (q, a = []) => db.prepare(q).all(...a),
  first: async (q, a = []) => db.prepare(q).get(...a) ?? null,
  run: async (q, a = []) => { const r = db.prepare(q).run(...a); return { lastId: Number(r.lastInsertRowid), changes: r.changes }; },
};
const store = createStore(sql, cfg);
await store.init();

if (!cfg.botToken && !cfg.devMode) { console.error('❌ Не задан BOT_TOKEN в .env'); process.exit(1); }

const { bot, N, applyStatus, runReminders, setupCommands } = createBot({
  token: cfg.botToken || '0:dev', store, cfg,
  botInfo: cfg.botToken ? undefined : { id: 0, is_bot: true, first_name: 'Dev', username: 'dev_bot' },
});
if (cfg.botToken) await bot.init();
const handleApi = createApi({ store, cfg, bot, N, applyStatus });

// ---------- HTTP: API + статика мини-приложения ----------
const WEBAPP = path.join(ROOT, 'webapp');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
  const origin = req.headers.origin;
  const allowed = [cfg.pagesUrl && new URL(cfg.pagesUrl).origin, `http://localhost:${cfg.port}`].filter(Boolean);
  const corsHeaders = origin && allowed.includes(origin)
    ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'content-type, x-init-data', 'access-control-allow-methods': 'GET, POST, OPTIONS' } : {};
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); return res.end(); }
      const chunks = [];
      for await (const c of req) { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 25_000) { res.writeHead(413); return res.end(); } }
      const request = new Request(`http://localhost${req.url}`, {
        method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const r = await handleApi(request, ip);
      res.writeHead(r.status, { ...Object.fromEntries(r.headers), ...corsHeaders });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const file = path.normalize(path.join(WEBAPP, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(WEBAPP)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(data);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500); res.end();
  }
});
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.listen(cfg.port, '127.0.0.1', () => console.log(`🌐 Сайт локально: http://localhost:${cfg.port}${cfg.devMode ? '  (DEV_MODE)' : ''}`));

// ---------- туннель Cloudflare со сторожем (для временного режима на Mac) ----------
function startTunnel(onUrl) {
  let current = null;
  const run = () => {
    const p = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${cfg.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let found = false;
    const scan = (buf) => {
      const m = !found && String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { found = true; current = { proc: p, url: m[0], fails: 0 }; onUrl(m[0]); }
    };
    p.stdout.on('data', scan); p.stderr.on('data', scan);
    p.on('exit', (code) => { console.error(`⚠️ Туннель остановился (${code}), перезапуск…`); setTimeout(run, 5000); });
    process.once('exit', () => p.kill());
  };
  run();
  let lastTick = Date.now();
  setInterval(async () => {
    const now = Date.now(); const slept = now - lastTick > 90_000; lastTick = now;
    if (!current) return;
    const restart = (why) => { console.error(`⚠️ Перезапуск туннеля: ${why}`); store.log(null, 'system.tunnel_watchdog', { why }); const p = current.proc; current = null; p.kill(); };
    if (slept) return restart('компьютер выходил из сна');
    try { const r = await fetch(`${current.url}/api/health`, { signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(r.status); current.fails = 0; } catch (e) { if (++current.fails >= 3) restart(`недоступен (${e.message})`); }
  }, 30_000);
}

if (cfg.botToken) {
  if (cfg.tunnel && cfg.pagesUrl) {
    startTunnel(async (api) => {
      cfg.webAppUrl = `${cfg.pagesUrl}/?api=${encodeURIComponent(api)}`;
      await store.log(null, 'system.tunnel', { api });
      await setupCommands().catch((e) => console.error('setup', e.message));
      console.log(`📱 Сайт: ${cfg.webAppUrl}`);
    });
  } else {
    await setupCommands();
  }
  setInterval(() => runReminders().catch(console.error), 60_000);
  await store.log(null, 'system.start', { runtime: 'node' });
  bot.start({ onStart: (me) => console.log(`🤖 Бот @${me.username} запущен. Админы: ${[...cfg.adminIds].join(', ') || '—'}`) });
  process.once('SIGINT', () => { bot.stop(); process.exit(0); });
  process.once('SIGTERM', () => { bot.stop(); process.exit(0); });
}
