// Запуск на Cloudflare Workers: webhook бота + API + статика сайта + напоминания по расписанию (cron).
import { webhookCallback } from 'grammy';
import { createStore } from './core/store.js';
import { createBot } from './core/bot.js';
import { createApi } from './core/api.js';

let app = null; // кэш на время жизни изолята

function d1(db) {
  return {
    all: async (q, a = []) => (await db.prepare(q).bind(...a).all()).results,
    first: async (q, a = []) => (await db.prepare(q).bind(...a).first()) ?? null,
    run: async (q, a = []) => { const r = await db.prepare(q).bind(...a).run(); return { lastId: r.meta.last_row_id, changes: r.meta.changes }; },
  };
}

async function getApp(env, origin) {
  if (app) return app;
  const cfg = {
    botToken: env.BOT_TOKEN,
    adminIds: new Set(String(env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number)),
    adminCode: env.ADMIN_CODE || '',
    tz: env.TZ_NAME || 'Asia/Ho_Chi_Minh',
    webAppUrl: env.WEBAPP_URL || origin || '',
    devMode: false,
  };
  const store = createStore(d1(env.DB), cfg);
  await store.init();
  // BOT_INFO (JSON) — только для локальных тестов без настоящего токена
  const botInfo = env.BOT_INFO ? JSON.parse(env.BOT_INFO) : undefined;
  const { bot, N, applyStatus, runReminders, setupCommands, finishRegistration } = createBot({ token: env.BOT_TOKEN, store, cfg, botInfo });
  if (!botInfo) await bot.init();
  const handleApi = createApi({ store, cfg, bot, N, applyStatus, finishRegistration });
  const onUpdate = webhookCallback(bot, 'cloudflare-mod', { secretToken: env.WEBHOOK_SECRET });
  app = { cfg, store, bot, handleApi, onUpdate, runReminders, setupCommands };
  return app;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') || '?';
    if (url.pathname === '/api/health') return Response.json({ ok: true });
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/tg' && url.pathname !== '/setup') return env.ASSETS.fetch(req);
    // Webhook и настройка — отклоняем без секрета ещё до какой-либо работы
    const secretOk = (h) => !!env.WEBHOOK_SECRET && req.headers.get(h) === env.WEBHOOK_SECRET;
    if (url.pathname === '/tg' && (req.method !== 'POST' || !secretOk('x-telegram-bot-api-secret-token'))) return new Response('forbidden', { status: 403 });
    if (url.pathname === '/setup' && (req.method !== 'POST' || !secretOk('x-setup-key'))) return new Response('forbidden', { status: 403 });
    let a;
    try { a = await getApp(env, url.origin); } catch (e) {
      console.error('init failed', e.message);
      return Response.json({ error: 'Сервис временно недоступен' }, { status: 503 });
    }
    if (!a.cfg.webAppUrl) a.cfg.webAppUrl = env.WEBAPP_URL || url.origin;
    await a.store.loadAdmins();

    // Webhook Telegram: принимаем только с секретным заголовком
    if (url.pathname === '/tg') return a.onUpdate(req);
    // Одноразовая настройка: регистрирует webhook и кнопку «Сайт». Защищено секретом.
    if (url.pathname === '/setup') {
      await a.bot.api.setWebhook(`${url.origin}/tg`, {
        secret_token: env.WEBHOOK_SECRET, drop_pending_updates: false, allowed_updates: ['message', 'callback_query'],
      });
      a.cfg.webAppUrl = env.WEBAPP_URL || url.origin;
      await a.setupCommands();
      await a.store.log(null, 'system.setup', { webhook: `${url.origin}/tg` });
      return Response.json({ ok: true, webhook: `${url.origin}/tg`, site: a.cfg.webAppUrl });
    }
    return a.handleApi(req, ip);
  },

  // Каждую минуту: напоминания ученикам
  async scheduled(_event, env, ctx) {
    const a = await getApp(env);
    await a.store.loadAdmins();
    ctx.waitUntil(a.runReminders());
  },
};
