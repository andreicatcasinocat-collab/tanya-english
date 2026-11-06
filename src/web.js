import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config, isAdmin, ROOT } from './config.js';
import * as D from './db.js';

const WEBAPP_DIR = path.join(ROOT, 'webapp');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

/** Проверка подписи Telegram WebApp initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app). */
function verifyInitData(initData) {
  if (!initData || !config.botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (!hash || hash.length !== calc.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null;
  return JSON.parse(params.get('user') || 'null');
}

function authUser(req, url) {
  const tgUser = verifyInitData(req.headers['x-init-data']);
  if (tgUser) return D.upsertUser(tgUser);
  // DEV_MODE: открыть панель в обычном браузере без Telegram (только локально!)
  if (config.devMode) {
    const id = Number(url.searchParams.get('as') || config.adminIds[0] || 1);
    return D.getUser(id) || D.upsertUser({ id, first_name: 'Dev' });
  }
  return null;
}

// ---------- защита: лимиты запросов ----------
/** Простое «окно» на N запросов за windowMs по ключу (IP или пользователь). */
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    return ++h.n <= max;
  };
}
const ipLimit = limiter(120, 60_000);      // 120 запросов в минуту с одного IP
const userWriteLimit = limiter(20, 60_000); // 20 изменений в минуту на пользователя
const authFailLimit = limiter(10, 60_000);  // 10 неудачных проверок подписи в минуту с IP
const clientIp = (req) => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000',
};
function cors(req, res) {
  const origin = req.headers.origin;
  const allowed = [config.pagesUrl && new URL(config.pagesUrl).origin, `http://localhost:${config.port}`].filter(Boolean);
  if (origin && allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'content-type, x-init-data');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-max-age', '600');
  }
}

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 20_000) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
});

export function startWeb({ notifyUser, notifyAdmins, sendFile }) {
  const routes = {
    // ----- общие -----
    'GET /api/me': ({ user }) => ({
      user, admin: isAdmin(user.tg_id), today: D.nowLocal(),
      settings: publicSettings(), tz: config.tz,
    }),
    'GET /api/calendar': ({ q }) => D.calendarRange(q.get('from'), q.get('to')),
    'GET /api/slots': ({ q }) => D.slotsFor(q.get('date')),
    'GET /api/my': ({ user }) => ({
      upcoming: D.userBookings(user.tg_id),
      history: D.userBookings(user.tg_id, { upcoming: false }),
      payments: D.userPayments(user.tg_id),
      balance: D.getUser(user.tg_id).balance,
    }),
    'POST /api/book': async ({ user, body }) => {
      if (!user.registered) throw new Error('Сначала зарегистрируйтесь в боте: /start');
      const b = D.createBooking({ userId: user.tg_id, date: body.date, start: body.start });
      await notifyAdmins(`${b.status === 'pending' ? '📥 Новая заявка' : '📌 Новая запись'} (мини-приложение): <b>${b.name}</b>\n${b.date}, ${b.start}–${b.end}`);
      return b;
    },
    'POST /api/cancel': async ({ user, body }) => {
      const { booking: b, late } = D.cancelByStudent(Number(body.id), user.tg_id);
      await notifyAdmins(`❌ ${b.name} отменил урок ${b.date}, ${b.start}${late ? ' — <b>поздняя отмена</b>' : ''}`);
      return { booking: b, late };
    },

    // ----- админ -----
    'GET /api/admin/day': ({ q }) => {
      const date = q.get('date');
      return {
        date, window: D.dayWindow(date), override: D.getDayOverride(date) || null,
        bookings: D.bookingsBetween(date, date), blocks: D.blocksOn(date), slots: D.slotsFor(date),
      };
    },
    'GET /api/admin/bookings': ({ q }) => D.bookingsBetween(q.get('from'), q.get('to')),
    'GET /api/admin/pending': () => D.pendingBookings(),
    'GET /api/admin/students': () => D.listStudents(),
    'GET /api/admin/student': ({ q }) => {
      const id = Number(q.get('id'));
      return { user: D.getUser(id), bookings: D.userBookings(id, { upcoming: false }), payments: D.userPayments(id), logs: D.getLogs({ userId: id, limit: 50 }) };
    },
    'GET /api/admin/stats': ({ q }) => D.stats(q.get('from'), q.get('to')),
    'GET /api/admin/logs': ({ q }) => D.getLogs({ limit: Number(q.get('limit') || 300) }),
    'GET /api/admin/settings': () => D.getSettings(),
    'POST /api/admin/settings': ({ user, body }) => {
      for (const [k, v] of Object.entries(body)) if (D.getSettings()[k] !== String(v)) D.setSetting(k, v, user.tg_id);
      return D.getSettings();
    },
    'POST /api/admin/status': async ({ user, body }) => {
      const b = D.setBookingStatus(Number(body.id), body.status, user.tg_id, { by: 'teacher', via: 'webapp' });
      const msg = {
        confirmed: `✅ Урок подтверждён: <b>${b.date}, ${b.start}</b>. До встречи!`,
        rejected: `😔 Время ${b.date}, ${b.start} не подошло. Выберите другое: /book`,
        cancelled: `❌ Преподаватель отменил урок ${b.date}, ${b.start}. Выберите другое время: /book`,
      }[b.status];
      if (msg) await notifyUser(b.user_id, msg);
      return b;
    },
    'POST /api/admin/notes': async ({ user, body }) => {
      const b = D.updateBookingNotes(Number(body.id), body, user.tg_id);
      if (body.notify && b.homework) await notifyUser(b.user_id, `📚 <b>Домашнее задание</b> (${b.date})\n${b.topic ? `Тема: ${b.topic}\n` : ''}\n${b.homework}`);
      return b;
    },
    'POST /api/admin/book': async ({ user, body }) => {
      const b = D.createBooking({ userId: Number(body.user_id), date: body.date, start: body.start, actorId: user.tg_id, force: true });
      await notifyUser(b.user_id, `📌 Преподаватель записал вас на урок: <b>${b.date}, ${b.start}</b>`);
      return b;
    },
    'POST /api/admin/reschedule': async ({ user, body }) => {
      const old = D.getBooking(Number(body.id));
      const b = D.rescheduleBooking(old.id, body.date, body.start, user.tg_id);
      await notifyUser(b.user_id, `🔁 Урок перенесён: ${old.date} ${old.start} → <b>${b.date} ${b.start}</b>`);
      return b;
    },
    'POST /api/admin/day': ({ user, body }) => {
      if (body.clear) D.clearDayOverride(body.date, user.tg_id);
      else D.setDayOverride(body.date, body, user.tg_id);
      return { ok: true };
    },
    'POST /api/admin/block': ({ user, body }) => {
      if (body.remove) D.removeBlock(Number(body.remove), user.tg_id);
      else D.addBlock(body.date, body.start, body.end, body.reason, user.tg_id);
      return { ok: true };
    },
    'POST /api/admin/payment': async ({ user, body }) => {
      const u = D.addPayment(Number(body.user_id), Number(body.amount), Number(body.lessons), body.note, user.tg_id);
      await notifyUser(u.tg_id, `💳 Оплата получена: ${body.amount} ₽ (+${body.lessons} ур.). Баланс: <b>${u.balance}</b> ур.`);
      return u;
    },
    'POST /api/admin/export-to-chat': async ({ user, body }) => {
      const csv = D.exportCsv(body.kind);
      if (!csv) throw new Error('Пока нет данных');
      if (!sendFile) throw new Error('Бот не запущен');
      await sendFile(user.tg_id, `${body.kind}_${D.nowLocal().date}.csv`, csv);
      D.log(user.tg_id, 'export', { kind: body.kind, via: 'webapp' });
      return { ok: true };
    },
    'POST /api/admin/student': ({ user, body }) => D.updateUser(Number(body.tg_id), body, user.tg_id),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    cors(req, res);
    const ip = clientIp(req);
    if (!ipLimit(ip)) return send(res, 429, { error: 'Слишком много запросов, подождите минуту' });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'Method not allowed' });
    try {
      if (url.pathname.startsWith('/api/')) {
        const user = authUser(req, url);
        if (!user) {
          if (!authFailLimit(ip)) return send(res, 429, { error: 'Слишком много попыток' });
          return send(res, 401, { error: 'Откройте приложение из Telegram' });
        }
        if (user.blocked && !isAdmin(user.tg_id)) return send(res, 403, { error: 'Доступ закрыт' });
        if (req.method === 'POST' && !userWriteLimit(user.tg_id)) return send(res, 429, { error: 'Слишком много действий, подождите минуту' });
        if (url.pathname.startsWith('/api/admin/') && !isAdmin(user.tg_id)) return send(res, 403, { error: 'Только для преподавателя' });
        if (url.pathname === '/api/admin/export') {
          const csv = D.exportCsv(url.searchParams.get('kind'));
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${url.searchParams.get('kind')}.csv"` });
          return res.end(csv);
        }
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) return send(res, 404, { error: 'Not found' });
        const body = req.method === 'POST' ? await readBody(req) : {};
        return send(res, 200, await handler({ user, body, q: url.searchParams }));
      }
      // статика мини-приложения
      const file = path.normalize(path.join(WEBAPP_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(WEBAPP_DIR)) return send(res, 403, { error: 'Forbidden' });
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    } catch (e) {
      if (e.code === 'ENOENT') return send(res, 404, { error: 'Not found' });
      send(res, 400, { error: e.message });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.listen(config.port, '127.0.0.1', () => console.log(`🌐 Мини-приложение: http://localhost:${config.port}${config.devMode ? '  (DEV_MODE)' : ''}`));
  return server;
}

function publicSettings() {
  const s = D.getSettings();
  return { teacher_name: s.teacher_name, lesson_duration: s.lesson_duration, price: s.price, cancel_hours: s.cancel_hours, rules: s.rules, days_ahead: s.days_ahead };
}
