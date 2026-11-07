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
  const { bot, N, applyStatus, runReminders, setupCommands } = createBot({ token: env.BOT_TOKEN, store, cfg });
  await bot.init();
  const handleApi = createApi({ store, cfg, bot, N, applyStatus });
  const onUpdate = webhookCallback(bot, 'cloudflare-mod', { secretToken: env.WEBHOOK_SECRET });
  app = { cfg, store, bot, handleApi, onUpdate, runReminders, setupCommands };
  return app;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') || '?';
    const a = await getApp(env, url.origin);
    await a.store.loadAdmins();

    // Webhook Telegram: принимаем только с секретным заголовком
    if (url.pathname === '/tg' && req.method === 'POST') {
      if (req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      return a.onUpdate(req);
    }
    // Одноразовая настройка: регистрирует webhook и кнопку «Сайт». Защищено секретом.
    if (url.pathname === '/setup' && req.method === 'POST') {
      if (req.headers.get('x-setup-key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      await a.bot.api.setWebhook(`${url.origin}/tg`, {
        secret_token: env.WEBHOOK_SECRET, drop_pending_updates: false, allowed_updates: ['message', 'callback_query'],
      });
      a.cfg.webAppUrl = env.WEBAPP_URL || url.origin;
      await a.setupCommands();
      await a.store.log(null, 'system.setup', { webhook: `${url.origin}/tg` });
      return Response.json({ ok: true, webhook: `${url.origin}/tg`, site: a.cfg.webAppUrl });
    }
    if (url.pathname.startsWith('/api/')) return a.handleApi(req, ip);
    return env.ASSETS.fetch(req);
  },

  // Каждую минуту: напоминания ученикам
  async scheduled(_event, env, ctx) {
    const a = await getApp(env);
    await a.store.loadAdmins();
    ctx.waitUntil(a.runReminders());
  },
};
