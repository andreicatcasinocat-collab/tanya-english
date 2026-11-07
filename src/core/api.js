// API мини-приложения на стандартных Request/Response (работает в Node и Cloudflare Workers).
import { isDate, isTime, isValidTz, TIMEZONES, tzLabel, fmtDate } from './time.js';
import { lessons, money } from './notify.js';
import { NOTIFY_TYPES } from './notify.js';

// ---------- защита: лимиты ----------
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return ++h.n <= max;
  };
}
const ipLimit = limiter(120, 60_000);
const userWriteLimit = limiter(30, 60_000);
const authFailLimit = limiter(10, 60_000);

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000',
  'cache-control': 'no-store',
};
const json = (code, body, extra = {}) => new Response(JSON.stringify(body), {
  status: code, headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra },
});

// ---------- проверка подписи Telegram initData (WebCrypto) ----------
const enc = new TextEncoder();
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function verifyInitData(initData, token) {
  if (!initData || !token || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', token);
  if (!safeEqual(hex(await hmac(secret, check)), hash)) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}

export function createApi({ store, cfg, bot, N, applyStatus, finishRegistration }) {
  const T = store.T;
  const need = (cond, msg = 'Некорректные данные') => { if (!cond) throw new Error(msg); };
  const range = (q) => {
    const from = q.get('from'); const to = q.get('to');
    need(isDate(from) && isDate(to) && from <= to, 'Неверный период');
    return [from, to];
  };
  const publicSettings = (s) => ({
    teacher_name: s.teacher_name, lesson_duration: s.lesson_duration, price: s.price, currency: s.currency,
    cancel_hours: s.cancel_hours, rules: s.rules, days_ahead: s.days_ahead, payment_details: s.payment_details,
  });

  const routes = {
    // ----- ученик / общие -----
    'GET /api/me': async ({ u, tgId }) => {
      const s = await store.getSettings();
      const admin = store.isAdmin(tgId);
      const tz = admin ? cfg.tz : (u.tz || 'Europe/Moscow');
      return {
        user: u, admin, settings: publicSettings(s), price: store.priceOf(u, s),
        tz, teacher_tz: cfg.tz, today: store.nowIn(tz), now: Date.now(),
        timezones: TIMEZONES.map(([z, n]) => [z, n, tzLabel(z)]),
      };
    },
    // auto: true — пояс определён по устройству (меняем, только если ученик не выбрал вручную или включает авто);
    // auto: false — ученик выбрал сам.
    'POST /api/tz': async ({ u, tgId, body }) => {
      need(isValidTz(body.tz), 'Неизвестный часовой пояс');
      const st = await store.getState(tgId);
      const registering = st?.type === 'reg_tz';
      if (body.auto && !u.tz_auto && !body.force && !registering) return { tz: u.tz, label: tzLabel(u.tz), auto: false, changed: false };
      const changed = u.tz !== body.tz;
      await store.updateUser(u.id, { tz: body.tz, tz_auto: body.auto ? 1 : 0 }, tgId);
      if (registering) await finishRegistration(tgId, u.id);
      else if (body.notify && changed) await bot.api.sendMessage(tgId, `🌍 Часовой пояс: <b>${tzLabel(body.tz)}</b> ✅\nВремя уроков теперь показывается по нему.`, { parse_mode: 'HTML' }).catch(() => {});
      return { tz: body.tz, label: tzLabel(body.tz), auto: !!body.auto, changed, registered: registering || !!u.registered };
    },
    'GET /api/month': async ({ q }) => {
      const [from, to] = range(q);
      return store.calendarRange(from, to, { withSlots: true });
    },
    'GET /api/slots': async ({ q }) => { need(isDate(q.get('date'))); return store.slotsFor(q.get('date')); },
    'GET /api/my': async ({ u }) => {
      const s = await store.getSettings();
      const fresh = await store.getUser(u.id);
      const withAt = (list) => list.map((b) => ({ ...b, at: store.atUtc(b.date, b.start) }));
      return {
        upcoming: withAt(await store.userBookings(u.id)),
        history: withAt(await store.userBookings(u.id, { upcoming: false })),
        payments: await store.userPayments(u.id),
        receipts: (await store.userReceipts(u.id)).map(({ file_id, ...r }) => r),
        balance: fresh.balance, price: store.priceOf(fresh, s),
        notify: Object.fromEntries(NOTIFY_TYPES.map(([k]) => [k, !!fresh[k]])),
        notify_types: NOTIFY_TYPES,
      };
    },
    'POST /api/book': async ({ u, body }) => {
      need(u.registered, 'Сначала зарегистрируйтесь в боте: /start');
      need(isDate(body.date) && isTime(body.start));
      const b = await store.createBooking({ userId: u.id, date: body.date, start: body.start });
      const local = store.tzOf(u) !== cfg.tz ? `\n🌍 У ученика: ${N.when(u, b.date, b.start, { tz: 'always' })}` : '';
      await N.toAdmins(`${b.status === 'pending' ? '📥 Новая заявка' : '📌 Новая запись'} (сайт): <b>${b.name}</b>\n${fmtDate(b.date)}, ${b.start}–${b.end}${local}`);
      return b;
    },
    'POST /api/cancel': async ({ tgId, body }) => {
      const { booking: b, late } = await store.cancelByStudent(Number(body.id), tgId);
      await N.toAdmins(`❌ ${b.name} отменил урок ${fmtDate(b.date)}, ${b.start}${late ? ' — <b>поздняя отмена</b>' : ''}`);
      return { booking: b, late };
    },
    'POST /api/notify': async ({ u, tgId, body }) => {
      need(NOTIFY_TYPES.some(([k]) => k === body.key));
      const r = await store.updateUser(u.id, { [body.key]: body.value ? 1 : 0 }, tgId);
      return { [body.key]: !!r[body.key] };
    },
    'POST /api/receipt-start': async ({ tgId }) => {
      await store.setState(tgId, { type: 'receipt' });
      await bot.api.sendMessage(tgId, '📎 Пришлите сюда скриншот или файл чека об оплате одним сообщением.');
      return { ok: true };
    },

    // ----- преподаватель -----
    'GET /api/admin/day': async ({ q }) => {
      const date = q.get('date'); need(isDate(date));
      const r = (await store.slotsRange(date, date))[date];
      return {
        date, window: r.window, override: (await store.getDayOverride(date)) || null,
        bookings: await store.bookingsBetween(date, date), blocks: await store.blocksOn(date), slots: r.slots,
      };
    },
    'GET /api/admin/pending': () => store.pendingBookings(),
    'GET /api/admin/receipts': async () => (await store.pendingReceipts()).map(({ file_id, ...r }) => r),
    'POST /api/admin/receipt': async ({ tgId, body }) => {
      const id = Number(body.id);
      if (body.action === 'reject') {
        const r = await store.rejectReceipt(id, tgId);
        await N.toUser(r, '⚠️ Преподаватель не смог подтвердить оплату по этому чеку. Пожалуйста, проверьте перевод или свяжитесь с преподавателем.');
        return r;
      }
      const n = Number(body.lessons);
      need(Number.isInteger(n) && n > 0 && n < 100, 'Укажите количество уроков');
      const { user, amount } = await store.acceptReceipt(id, n, body.amount, tgId);
      await N.toUser(user, `✅ <b>Оплата подтверждена!</b> +${lessons(n)}.\n💳 Оплаченных уроков: <b>${user.balance}</b>. Спасибо!`);
      return { user, amount };
    },
    'GET /api/admin/students': () => store.listStudents(),
    'GET /api/admin/student': async ({ q }) => {
      const id = Number(q.get('id'));
      const user = await store.getUser(id);
      need(user, 'Ученик не найден');
      return {
        user, bookings: await store.userBookings(id, { upcoming: false }), payments: await store.userPayments(id),
        receipts: (await store.userReceipts(id)).map(({ file_id, ...r }) => r), logs: await store.getLogs({ userId: id, limit: 50 }),
      };
    },
    'GET /api/admin/tg-candidates': async () => (await store.tgCandidates()).filter((u) => !store.isAdmin(u.tg_id)),
    'POST /api/admin/student-merge': async ({ tgId, body }) => {
      const u = await store.mergeTelegram(Number(body.card_id), Number(body.user_id), tgId, 'manual');
      await N.toUser(u, `✅ Ваш Telegram подключён к карточке ученика у преподавателя.\n💳 Оплаченных уроков: <b>${u.balance}</b>`);
      return u;
    },
    'GET /api/admin/month-detail': ({ q }) => store.monthDetail(...range(q)),
    'POST /api/admin/student-delete': async ({ tgId, body }) => {
      const { user, cancelled } = await store.deleteStudent(Number(body.id), tgId);
      if (body.notify && user.tg_id && cancelled.length) {
        await N.toUser(user, `❌ Запланированные уроки отменены преподавателем:\n${cancelled.map((b) => '• ' + N.when(user, b.date, b.start)).join('\n')}`);
      }
      return { ok: true, cancelled: cancelled.length };
    },
    'POST /api/admin/student': ({ tgId, body }) => store.updateUser(Number(body.id), body, tgId),
    'POST /api/admin/student-add': ({ tgId, body }) => store.addManualStudent(body, tgId),
    'POST /api/admin/student-link': async ({ body }) => {
      const u = await store.getUser(Number(body.id));
      need(u && !u.tg_id, 'У ученика уже есть Telegram');
      const code = await store.ensureLinkCode(u.id);
      return { url: `https://t.me/${bot.botInfo.username}?start=link_${code}`, bot: bot.botInfo.username };
    },
    'POST /api/admin/remind-payment': async ({ tgId, body }) => {
      const u = await store.getUser(Number(body.id));
      need(u?.tg_id, 'У ученика нет Telegram');
      const ok = await N.paymentReminder(u);
      await store.log(tgId, 'payment.reminder', { user_id: u.id, manual: true });
      return { ok };
    },
    'GET /api/admin/stats': ({ q }) => store.stats(...range(q)),
    'GET /api/admin/logs': ({ q }) => store.getLogs({ limit: Math.min(1000, Number(q.get('limit') || 300)) }),
    'GET /api/admin/settings': () => store.getSettings(true),
    'POST /api/admin/settings': async ({ tgId, body }) => {
      const cur = await store.getSettings(true);
      for (const [k, v] of Object.entries(body)) if (k !== 'admin_ids' && k in cur && cur[k] !== String(v)) await store.setSetting(k, v, tgId);
      return store.getSettings(true);
    },
    'POST /api/admin/status': async ({ tgId, body }) => {
      need(['confirmed', 'rejected', 'done', 'no_show', 'cancelled'].includes(body.status));
      return applyStatus(Number(body.id), body.status, tgId, 'site');
    },
    'POST /api/admin/notes': async ({ tgId, body }) => {
      const b = await store.updateBookingNotes(Number(body.id), { topic: body.topic, homework: body.homework }, tgId);
      if (body.notify && b.homework) await N.homework(b);
      return b;
    },
    'POST /api/admin/book': async ({ tgId, body }) => {
      need(isDate(body.date) && isTime(body.start));
      const b = await store.createBooking({ userId: Number(body.user_id), date: body.date, start: body.start, actorTgId: tgId, force: true });
      await N.toUser(b, `📌 Преподаватель записал вас на урок: <b>${N.when(await store.getUser(b.user_id), b.date, b.start)}</b>`);
      return b;
    },
    'POST /api/admin/reschedule': async ({ tgId, body }) => {
      need(isDate(body.date) && isTime(body.start));
      const old = await store.getBooking(Number(body.id));
      const b = await store.rescheduleBooking(old.id, body.date, body.start, tgId);
      const su = await store.getUser(b.user_id);
      await N.toUser(b, `🔁 Урок перенесён: ${N.when(su, old.date, old.start)} → <b>${N.when(su, b.date, b.start)}</b>`);
      return b;
    },
    'POST /api/admin/day': async ({ tgId, body }) => {
      need(isDate(body.date));
      if (body.clear) await store.clearDayOverride(body.date, tgId);
      else { need(body.is_off || (isTime(body.start) && isTime(body.end))); await store.setDayOverride(body.date, body, tgId); }
      return { ok: true };
    },
    'POST /api/admin/block': async ({ tgId, body }) => {
      if (body.remove) await store.removeBlock(Number(body.remove), tgId);
      else { need(isDate(body.date) && isTime(body.start) && isTime(body.end)); await store.addBlock(body.date, body.start, body.end, String(body.reason || '').slice(0, 200), tgId); }
      return { ok: true };
    },
    'POST /api/admin/payment': async ({ tgId, body }) => {
      need(Number(body.amount) >= 0 && Number.isInteger(Number(body.lessons)));
      const u = await store.addPayment(Number(body.user_id), Number(body.amount), Number(body.lessons), String(body.note || '').slice(0, 200), tgId);
      const s = await store.getSettings();
      await N.toUser(u, `💳 Оплата получена: ${money(body.amount, s)} (+${lessons(Number(body.lessons))}). Оплаченных уроков: <b>${u.balance}</b>. Спасибо!`);
      return u;
    },
    'POST /api/admin/export-to-chat': async ({ tgId, body }) => {
      const csv = await store.exportCsv(body.kind);
      need(csv, 'Пока нет данных');
      const { InputFile } = await import('grammy');
      await bot.api.sendDocument(tgId, new InputFile(new TextEncoder().encode(csv), `${body.kind}_${T.now().date}.csv`));
      await store.log(tgId, 'export', { kind: body.kind, via: 'site' });
      return { ok: true };
    },
  };

  /** Картинка чека: проксируем файл из Telegram, не раскрывая токен. */
  async function receiptFile(q) {
    const r = await store.getReceipt(Number(q.get('id')));
    if (!r) return json(404, { error: 'Not found' });
    const f = await bot.api.getFile(r.file_id);
    const res = await fetch(`https://api.telegram.org/file/bot${cfg.botToken}/${f.file_path}`);
    const type = r.file_type === 'photo' ? 'image/jpeg' : (res.headers.get('content-type') || 'application/octet-stream');
    return new Response(res.body, { headers: { 'content-type': type, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline' } });
  }

  return async function handle(req, ip) {
    const url = new URL(req.url);
    if (!ipLimit(ip)) return json(429, { error: 'Слишком много запросов, подождите минуту' });
    if (url.pathname === '/api/health') return json(200, { ok: true });
    if (!['GET', 'POST'].includes(req.method)) return json(405, { error: 'Method not allowed' });

    let tgUser = await verifyInitData(req.headers.get('x-init-data'), cfg.botToken);
    if (!tgUser && cfg.devMode) tgUser = { id: Number(url.searchParams.get('as') || [...cfg.adminIds][0] || 1), first_name: 'Dev' };
    if (!tgUser) {
      if (!authFailLimit(ip)) return json(429, { error: 'Слишком много попыток' });
      return json(401, { error: 'Откройте приложение из Telegram' });
    }
    const u = await store.upsertTgUser(tgUser);
    if (u._justLinked) await N.toAdmins(`🔗 ${u.name}${u.username ? ` (@${u.username})` : ''} открыл бота — Telegram автоматически привязан к его карточке.`);
    const admin = store.isAdmin(tgUser.id);
    if (u.blocked && !admin) return json(403, { error: 'Доступ закрыт' });
    if (url.pathname.startsWith('/api/admin/') && !admin) return json(403, { error: 'Только для преподавателя' });
    if (req.method === 'POST' && !userWriteLimit(tgUser.id)) return json(429, { error: 'Слишком много действий, подождите минуту' });

    try {
      if (url.pathname === '/api/admin/receipt-file') return await receiptFile(url.searchParams);
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) return json(404, { error: 'Not found' });
      let body = {};
      if (req.method === 'POST') {
        const text = await req.text();
        if (text.length > 20_000) return json(413, { error: 'Слишком большой запрос' });
        try { body = text ? JSON.parse(text) : {}; } catch { return json(400, { error: 'Bad JSON' }); }
      }
      return json(200, await handler({ u, tgId: tgUser.id, body, q: url.searchParams }));
    } catch (e) {
      return json(400, { error: e.message || 'Ошибка' });
    }
  };
}
