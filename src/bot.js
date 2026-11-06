import { Bot, InlineKeyboard, Keyboard, InputFile } from 'grammy';
import { config, isAdmin } from './config.js';
import * as D from './db.js';

export const STATUS = {
  pending: '⏳ ждёт подтверждения',
  confirmed: '✅ подтверждён',
  cancelled: '❌ отменён',
  late_cancel: '⚠️ поздняя отмена',
  rejected: '🚫 отклонён',
  done: '🎓 проведён',
  no_show: '🙈 неявка',
};
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'Не знаю'];
const GOALS = ['Разговорный', 'IELTS / TOEFL', 'Для работы', 'Путешествия', 'Школа / ВУЗ', 'Другое'];

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export function fmtDate(date, opts = { weekday: 'short', day: 'numeric', month: 'long' }) {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('ru-RU', { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}
const hm = (t) => t.replace(':', '');
const unhm = (t) => `${t.slice(0, 2)}:${t.slice(2)}`;
const who = (u) => `${esc(u.name)}${u.username ? ` (@${esc(u.username)})` : ''}`;

/** Состояния диалогов «жду текст от пользователя». */
const waiting = new Map();

export function createBot() {
  const bot = new Bot(config.botToken);

  // ---------- клавиатуры ----------
  const studentMenu = () => {
    const kb = new Keyboard().text('📅 Записаться').text('📋 Мои уроки').row()
      .text('💳 Баланс').text('📚 Домашка').row();
    if (config.webAppUrl) kb.webApp('🗓 Календарь', config.webAppUrl);
    return kb.text('ℹ️ Правила').resized();
  };
  const adminMenu = () => {
    const kb = new Keyboard().text('📆 Сегодня').text('🗓 Неделя').row()
      .text('⏳ Заявки').text('👥 Ученики').row()
      .text('📊 Статистика').text('📢 Рассылка').row()
      .text('📤 Экспорт');
    if (config.webAppUrl) kb.webApp('🖥 Админ-панель', config.webAppUrl);
    return kb.resized();
  };

  // ---------- общие middleware ----------
  // Антифлуд: не больше 25 сообщений/нажатий за 20 секунд от одного человека
  const flood = new Map();
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || isAdmin(id)) return next();
    const now = Date.now();
    const f = flood.get(id) || { n: 0, reset: now + 20_000, warned: false };
    if (f.reset < now) Object.assign(f, { n: 0, reset: now + 20_000, warned: false });
    f.n++;
    flood.set(id, f);
    if (f.n > 25) {
      if (!f.warned) { f.warned = true; D.log(id, 'security.flood', { count: f.n }); await ctx.reply('⏳ Слишком много сообщений. Подождите немного.').catch(() => {}); }
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    await next();
  });
  setInterval(() => { const now = Date.now(); for (const [k, v] of flood) if (v.reset < now) flood.delete(k); }, 60_000).unref();

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      const u = D.upsertUser(ctx.from);
      if (u.blocked && !isAdmin(ctx.from.id)) return; // заблокированные ученики игнорируются
    }
    await next();
  });

  async function notifyAdmins(text, extra = {}) {
    for (const id of config.adminIds) {
      await bot.api.sendMessage(id, text, { parse_mode: 'HTML', ...extra }).catch((e) => console.error('notify admin', e.message));
    }
  }
  const notifyUser = (id, text, extra = {}) =>
    bot.api.sendMessage(id, text, { parse_mode: 'HTML', ...extra }).catch((e) => console.error('notify user', e.message));

  // ---------- /start и регистрация ----------
  bot.command('start', async (ctx) => {
    const s = D.getSettings();
    if (isAdmin(ctx.from.id)) {
      D.updateUser(ctx.from.id, { registered: 0 }, ctx.from.id);
      return ctx.reply(`👋 Режим преподавателя. Ваш ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML', reply_markup: adminMenu() });
    }
    const u = D.getUser(ctx.from.id);
    if (u.registered) return ctx.reply(`С возвращением, ${esc(u.name)}! 👋`, { parse_mode: 'HTML', reply_markup: studentMenu() });
    waiting.set(ctx.from.id, { type: 'reg_name' });
    D.log(ctx.from.id, 'user.start', { username: ctx.from.username });
    await ctx.reply(
      `Hello! 👋 Это бот для записи на уроки английского.\nПреподаватель — <b>${esc(s.teacher_name)}</b>.\n\nКак вас зовут?`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text(`Оставить «${u.name}»`, 'reg|name') },
    );
  });

  bot.callbackQuery('reg|name', async (ctx) => {
    await ctx.answerCallbackQuery();
    await askLevel(ctx);
  });
  async function askLevel(ctx) {
    waiting.set(ctx.from.id, { type: 'reg_level' });
    const kb = new InlineKeyboard();
    LEVELS.forEach((l, i) => { kb.text(l, `reg|lvl|${l}`); if (i % 3 === 2) kb.row(); });
    await ctx.reply('Ваш уровень английского?', { reply_markup: kb });
  }
  bot.callbackQuery(/^reg\|lvl\|(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    D.updateUser(ctx.from.id, { level: ctx.match[1] }, ctx.from.id);
    const kb = new InlineKeyboard();
    GOALS.forEach((g, i) => { kb.text(g, `reg|goal|${i}`); if (i % 2) kb.row(); });
    await ctx.editMessageText(`Уровень: <b>${ctx.match[1]}</b>\n\nКакая главная цель?`, { parse_mode: 'HTML', reply_markup: kb });
  });
  bot.callbackQuery(/^reg\|goal\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    waiting.delete(ctx.from.id);
    const u = D.updateUser(ctx.from.id, { goal: GOALS[Number(ctx.match[1])], registered: 1 }, ctx.from.id);
    D.log(ctx.from.id, 'user.registered', { name: u.name, level: u.level, goal: u.goal });
    await ctx.editMessageText(`Цель: <b>${esc(u.goal)}</b> ✅`, { parse_mode: 'HTML' });
    await ctx.reply('Готово! Теперь можно записаться на урок 👇', { reply_markup: studentMenu() });
    await notifyAdmins(`🆕 Новый ученик: ${who(u)}\nУровень: ${esc(u.level)} · Цель: ${esc(u.goal)}`,
      { reply_markup: new InlineKeyboard().text('Открыть карточку', `stu|${u.tg_id}`) });
  });

  // ---------- выбор даты/времени (общий для записи, переноса и записи админом) ----------
  // mode: bk — ученик записывается; ab — админ записывает ученика (arg = uid); rs — перенос (arg = bookingId)
  async function showDays(ctx, mode, arg, offset = 0, edit = false) {
    const s = D.getSettings();
    const today = D.nowLocal().date;
    const span = Number(s.days_ahead);
    const kb = new InlineKeyboard();
    let shown = 0;
    let i = offset;
    for (; i <= span && shown < 8; i++) {
      const d = D.addDays(today, i);
      const free = D.freeSlots(d, s).length;
      if (!free) continue;
      kb.text(`${fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' })} · ${free}`, `d|${mode}|${arg}|${d}`);
      if (++shown % 2 === 0) kb.row();
    }
    if (shown % 2) kb.row();
    if (offset > 0) kb.text('◀️ Раньше', `dl|${mode}|${arg}|${Math.max(0, offset - 8)}`);
    if (i <= span) kb.text('Дальше ▶️', `dl|${mode}|${arg}|${i}`);
    const text = shown
      ? 'Выберите день (цифра — сколько свободных окон):'
      : 'Свободных окон пока нет 😔 Напишите преподавателю — постараемся найти время.';
    return edit ? ctx.editMessageText(text, { reply_markup: kb }) : ctx.reply(text, { reply_markup: kb });
  }
  bot.callbackQuery(/^dl\|(\w+)\|(\d+)\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDays(ctx, ctx.match[1], ctx.match[2], Number(ctx.match[3]), true);
  });
  bot.callbackQuery(/^d\|(\w+)\|(\d+)\|([\d-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, mode, arg, date] = ctx.match;
    const slots = D.freeSlots(date);
    const kb = new InlineKeyboard();
    slots.forEach((sl, i) => { kb.text(sl.start, `t|${mode}|${arg}|${date}|${hm(sl.start)}`); if (i % 4 === 3) kb.row(); });
    kb.row().text('◀️ К датам', `dl|${mode}|${arg}|0`);
    await ctx.editMessageText(slots.length ? `${fmtDate(date)} — выберите время:` : 'На этот день окон уже нет.', { reply_markup: kb });
  });
  bot.callbackQuery(/^t\|(\w+)\|(\d+)\|([\d-]+)\|(\d{4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, mode, arg, date, t] = ctx.match;
    const start = unhm(t);
    try {
      if (mode === 'bk') {
        const s = D.getSettings();
        return ctx.editMessageText(
          `Записаться на <b>${fmtDate(date)}, ${start}</b>?\nДлительность: ${s.lesson_duration} мин · ${s.price} ₽`,
          { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('✅ Записаться', `ok|${date}|${t}`).text('◀️ Назад', `d|bk|0|${date}`) },
        );
      }
      if (mode === 'ab') {
        if (!isAdmin(ctx.from.id)) return;
        const b = D.createBooking({ userId: Number(arg), date, start, actorId: ctx.from.id, force: true });
        await ctx.editMessageText(`✅ Урок добавлен: ${esc(b.name)}, ${fmtDate(date)} ${start}`, { parse_mode: 'HTML' });
        return notifyUser(b.user_id, `📌 Преподаватель записал вас на урок: <b>${fmtDate(date)}, ${start}</b>`);
      }
      if (mode === 'rs') {
        const old = D.getBooking(Number(arg));
        if (!old || (old.user_id !== ctx.from.id && !isAdmin(ctx.from.id))) return;
        const b = D.rescheduleBooking(old.id, date, start, ctx.from.id);
        const line = `${fmtDate(old.date)} ${old.start} → <b>${fmtDate(date)} ${start}</b>`;
        await ctx.editMessageText(`🔁 Урок перенесён: ${line}`, { parse_mode: 'HTML' });
        if (isAdmin(ctx.from.id)) await notifyUser(b.user_id, `🔁 Преподаватель перенёс урок: ${line}`);
        else await notifyAdmins(`🔁 ${who(b)} перенёс урок: ${line}`);
      }
    } catch (e) {
      await ctx.editMessageText(`⚠️ ${e.message}`, { reply_markup: new InlineKeyboard().text('Выбрать другое время', `dl|${mode}|${arg}|0`) });
    }
  });
  bot.callbackQuery(/^ok\|([\d-]+)\|(\d{4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = D.getUser(ctx.from.id);
    if (!u.registered) return ctx.reply('Сначала пройдите регистрацию: /start');
    try {
      const b = D.createBooking({ userId: ctx.from.id, date: ctx.match[1], start: unhm(ctx.match[2]) });
      await ctx.editMessageText(
        `${b.status === 'confirmed' ? '✅ Вы записаны' : '⏳ Заявка отправлена'}: <b>${fmtDate(b.date)}, ${b.start}–${b.end}</b>` +
        (b.status === 'pending' ? '\nПреподаватель подтвердит её в ближайшее время.' : ''),
        { parse_mode: 'HTML' },
      );
      const kb = new InlineKeyboard();
      if (b.status === 'pending') kb.text('✅ Подтвердить', `adm|confirm|${b.id}`).text('❌ Отклонить', `adm|reject|${b.id}`);
      await notifyAdmins(
        `${b.status === 'pending' ? '📥 Новая заявка' : '📌 Новая запись'}: ${who(u)}\n<b>${fmtDate(b.date)}, ${b.start}–${b.end}</b>\nБаланс ученика: ${u.balance} ур.`,
        { reply_markup: kb },
      );
    } catch (e) {
      await ctx.editMessageText(`⚠️ ${e.message}`, { reply_markup: new InlineKeyboard().text('Выбрать другое время', 'dl|bk|0|0') });
    }
  });

  // ---------- меню ученика ----------
  bot.hears('📅 Записаться', (ctx) => showDays(ctx, 'bk', 0));
  bot.command('book', (ctx) => showDays(ctx, 'bk', 0));

  bot.hears('📋 Мои уроки', async (ctx) => {
    const list = D.userBookings(ctx.from.id);
    if (!list.length) return ctx.reply('У вас нет запланированных уроков.', { reply_markup: new InlineKeyboard().text('📅 Записаться', 'dl|bk|0|0') });
    for (const b of list) {
      await ctx.reply(`<b>${fmtDate(b.date)}, ${b.start}–${b.end}</b>\n${STATUS[b.status]}`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔁 Перенести', `rsq|${b.id}`).text('❌ Отменить', `cnq|${b.id}`),
      });
    }
  });
  bot.callbackQuery(/^rsq\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const b = D.getBooking(Number(ctx.match[1]));
    if (!b || (b.user_id !== ctx.from.id && !isAdmin(ctx.from.id))) return;
    const s = D.getSettings();
    if (!isAdmin(ctx.from.id) && D.minutesUntil(b.date, b.start) < Number(s.cancel_hours) * 60) {
      return ctx.reply(`Перенос возможен не позднее чем за ${s.cancel_hours} ч. Напишите преподавателю напрямую.`);
    }
    await showDays(ctx, 'rs', b.id);
  });
  bot.callbackQuery(/^cnq\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const b = D.getBooking(Number(ctx.match[1]));
    if (!b || b.user_id !== ctx.from.id) return;
    const s = D.getSettings();
    const late = b.status === 'confirmed' && D.minutesUntil(b.date, b.start) < Number(s.cancel_hours) * 60;
    await ctx.editMessageText(
      `Отменить урок ${fmtDate(b.date)}, ${b.start}?` + (late ? `\n\n⚠️ До урока меньше ${s.cancel_hours} ч — урок будет списан с баланса.` : ''),
      { reply_markup: new InlineKeyboard().text('Да, отменить', `cn|${b.id}`).text('Нет', 'noop') },
    );
  });
  bot.callbackQuery(/^cn\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const { booking: b, late } = D.cancelByStudent(Number(ctx.match[1]), ctx.from.id);
      await ctx.editMessageText(`❌ Урок ${fmtDate(b.date)}, ${b.start} отменён${late ? ' (поздняя отмена, урок списан)' : ''}.`);
      await notifyAdmins(`❌ ${who(b)} отменил урок ${fmtDate(b.date)}, ${b.start}${late ? ' — <b>поздняя отмена</b>' : ''}`);
    } catch (e) { await ctx.editMessageText(`⚠️ ${e.message}`); }
  });
  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery('Ок').then(() => ctx.deleteMessage().catch(() => {})));

  bot.hears('💳 Баланс', async (ctx) => {
    const u = D.getUser(ctx.from.id);
    const s = D.getSettings();
    const pays = D.userPayments(ctx.from.id).slice(0, 5);
    await ctx.reply(
      `💳 Оплачено уроков: <b>${u.balance}</b>${u.balance < 0 ? ' (задолженность)' : ''}\nСтоимость урока: ${s.price} ₽\n\n` +
      (pays.length ? `Последние оплаты:\n${pays.map((p) => `• ${p.created_at.slice(0, 10)} — ${p.amount} ₽ (${p.lessons} ур.)`).join('\n')}` : 'Оплат пока не было.'),
      { parse_mode: 'HTML' },
    );
  });
  bot.hears('📚 Домашка', async (ctx) => {
    const hw = D.userBookings(ctx.from.id, { upcoming: false }).filter((b) => b.homework).slice(0, 5);
    if (!hw.length) return ctx.reply('Домашних заданий пока нет 🎉');
    await ctx.reply(hw.map((b) => `📚 <b>${fmtDate(b.date)}</b>${b.topic ? ` · ${esc(b.topic)}` : ''}\n${esc(b.homework)}`).join('\n\n'), { parse_mode: 'HTML' });
  });
  bot.hears('ℹ️ Правила', (ctx) => {
    const s = D.getSettings();
    return ctx.reply(`ℹ️ <b>Правила</b>\n\n${esc(s.rules)}\n\nУрок: ${s.lesson_duration} мин · ${s.price} ₽`, { parse_mode: 'HTML' });
  });

  // ---------- админка ----------
  const admin = bot.filter((ctx) => isAdmin(ctx.from?.id));

  function lessonCard(b) {
    const kb = new InlineKeyboard();
    if (b.status === 'pending') kb.text('✅ Подтвердить', `adm|confirm|${b.id}`).text('❌ Отклонить', `adm|reject|${b.id}`).row();
    if (['pending', 'confirmed'].includes(b.status)) {
      kb.text('🎓 Проведён', `adm|done|${b.id}`).text('🙈 Неявка', `adm|noshow|${b.id}`).row()
        .text('🔁 Перенести', `rsq|${b.id}`).text('🗑 Отменить', `adm|cancel|${b.id}`).row();
    }
    kb.text('📚 Домашка', `adm|hw|${b.id}`).text('👤 Ученик', `stu|${b.user_id}`);
    return {
      text: `<b>${b.start}–${b.end}</b> · ${who(b)}\n${STATUS[b.status]}${b.topic ? `\nТема: ${esc(b.topic)}` : ''}${b.homework ? `\nДЗ: ${esc(b.homework)}` : ''}`,
      kb,
    };
  }

  admin.hears('📆 Сегодня', async (ctx) => {
    const today = D.nowLocal().date;
    const list = D.bookingsBetween(today, today).filter((b) => !['cancelled', 'rejected'].includes(b.status));
    if (!list.length) return ctx.reply(`📆 ${fmtDate(today)} — уроков нет. Отдыхайте ☕️`);
    await ctx.reply(`📆 <b>${fmtDate(today)}</b> — уроков: ${list.length}`, { parse_mode: 'HTML' });
    for (const b of list) { const c = lessonCard(b); await ctx.reply(c.text, { parse_mode: 'HTML', reply_markup: c.kb }); }
  });
  admin.hears('🗓 Неделя', async (ctx) => {
    const today = D.nowLocal().date;
    const cal = D.calendarRange(today, D.addDays(today, 6));
    const list = D.bookingsBetween(today, D.addDays(today, 6)).filter((b) => ['pending', 'confirmed', 'done'].includes(b.status));
    const bar = (l) => '▓'.repeat(Math.round(l * 10)) + '░'.repeat(10 - Math.round(l * 10));
    const lines = cal.map((d) => {
      const head = `<b>${fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b> ${d.off ? '— выходной' : `${bar(d.load)} ${d.lessons}/${d.capacity}`}`;
      const items = list.filter((b) => b.date === d.date).map((b) => `   ${b.start} ${esc(b.name)}${b.status === 'pending' ? ' ⏳' : ''}`);
      return [head, ...items].join('\n');
    });
    await ctx.reply(`🗓 <b>Неделя</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });
  admin.hears('⏳ Заявки', async (ctx) => {
    const list = D.pendingBookings();
    if (!list.length) return ctx.reply('Новых заявок нет ✨');
    for (const b of list) {
      await ctx.reply(`📥 ${who(b)}\n<b>${fmtDate(b.date)}, ${b.start}–${b.end}</b>`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('✅ Подтвердить', `adm|confirm|${b.id}`).text('❌ Отклонить', `adm|reject|${b.id}`),
      });
    }
  });

  admin.callbackQuery(/^adm\|(\w+)\|(\d+)$/, async (ctx) => {
    const [, action, idStr] = ctx.match;
    const id = Number(idStr);
    const map = { confirm: 'confirmed', reject: 'rejected', done: 'done', noshow: 'no_show', cancel: 'cancelled' };
    if (action === 'hw') {
      await ctx.answerCallbackQuery();
      waiting.set(ctx.from.id, { type: 'hw', bookingId: id });
      return ctx.reply('Напишите тему урока и домашнее задание.\nФормат: первая строка — тема, дальше — ДЗ.');
    }
    if (!map[action]) return ctx.answerCallbackQuery();
    try {
      const b = D.setBookingStatus(id, map[action], ctx.from.id, { by: 'teacher' });
      await ctx.answerCallbackQuery(STATUS[b.status]);
      const c = lessonCard(b);
      await ctx.editMessageText(c.text, { parse_mode: 'HTML', reply_markup: c.kb }).catch(() => {});
      const msg = {
        confirmed: `✅ Урок подтверждён: <b>${fmtDate(b.date)}, ${b.start}</b>. До встречи!`,
        rejected: `😔 К сожалению, время ${fmtDate(b.date)}, ${b.start} не подошло. Выберите другое: /book`,
        cancelled: `❌ Преподаватель отменил урок ${fmtDate(b.date)}, ${b.start}. Выберите другое время: /book`,
      }[b.status];
      if (msg) await notifyUser(b.user_id, msg);
    } catch (e) { await ctx.answerCallbackQuery(e.message); }
  });

  // карточка ученика
  async function studentCard(ctx, uid, edit = false) {
    const u = D.getUser(uid);
    if (!u) return ctx.reply('Ученик не найден');
    const hist = D.userBookings(uid, { upcoming: false });
    const done = hist.filter((b) => b.status === 'done').length;
    const next = D.userBookings(uid)[0];
    const text = `👤 <b>${esc(u.name)}</b>${u.username ? ` · @${esc(u.username)}` : ''}\n` +
      `Уровень: ${esc(u.level || '—')} · Цель: ${esc(u.goal || '—')}\n` +
      `Баланс: <b>${u.balance}</b> ур. · Проведено: ${done}\n` +
      `Ближайший: ${next ? `${fmtDate(next.date)}, ${next.start}` : '—'}\n` +
      (u.notes ? `📝 ${esc(u.notes)}\n` : '') + (u.blocked ? '🚫 Заблокирован\n' : '');
    const kb = new InlineKeyboard()
      .text('💳 Оплата', `stu_pay|${uid}`).text('➕ Урок', `dl|ab|${uid}|0`).row()
      .text('📝 Заметка', `stu_note|${uid}`).text('✉️ Написать', `stu_msg|${uid}`).row()
      .text(u.blocked ? '✅ Разблокировать' : '🚫 Заблокировать', `stu_blk|${uid}`);
    return edit ? ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }) : ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
  admin.hears('👥 Ученики', async (ctx) => {
    const list = D.listStudents();
    if (!list.length) return ctx.reply('Учеников пока нет. Поделитесь ссылкой на бота: https://t.me/' + ctx.me.username);
    const kb = new InlineKeyboard();
    list.forEach((u, i) => { kb.text(`${u.name} · ${u.balance}`, `stu|${u.tg_id}`); if (i % 2) kb.row(); });
    await ctx.reply(`👥 Учеников: ${list.length} (цифра — баланс уроков)`, { reply_markup: kb });
  });
  admin.callbackQuery(/^stu\|(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await studentCard(ctx, Number(ctx.match[1])); });
  admin.callbackQuery(/^stu_blk\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = D.getUser(Number(ctx.match[1]));
    D.updateUser(u.tg_id, { blocked: u.blocked ? 0 : 1 }, ctx.from.id);
    await studentCard(ctx, u.tg_id, true);
  });
  for (const [key, prompt] of [
    ['pay', 'Введите оплату: <code>сумма количество_уроков [комментарий]</code>\nНапример: <code>6000 4 пакет ноябрь</code>'],
    ['note', 'Напишите заметку об ученике (заменит текущую):'],
    ['msg', 'Напишите сообщение — я перешлю его ученику:'],
  ]) {
    admin.callbackQuery(new RegExp(`^stu_${key}\\|(\\d+)$`), async (ctx) => {
      await ctx.answerCallbackQuery();
      waiting.set(ctx.from.id, { type: `stu_${key}`, uid: Number(ctx.match[1]) });
      await ctx.reply(prompt, { parse_mode: 'HTML' });
    });
  }

  admin.hears('📊 Статистика', async (ctx) => {
    const today = D.nowLocal().date;
    const monthStart = today.slice(0, 8) + '01';
    const st = D.stats(monthStart, today);
    const wk = D.stats(D.addDays(today, -6), D.addDays(today, 7));
    const wd = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    await ctx.reply(
      `📊 <b>${fmtDate(today, { month: 'long', year: 'numeric' })}</b>\n` +
      `🎓 Проведено: ${st.done}\n⏳ Впереди: ${st.upcoming}\n❌ Отмены: ${st.cancelled} · 🙈 Неявки: ${st.no_show}\n` +
      `💰 Оплачено: ${st.income.toLocaleString('ru-RU')} ₽\n👥 Учеников: ${st.students}\n` +
      `📈 Загрузка (±7 дней): ${Math.round(wk.load * 100)}%\n\n` +
      `По дням недели: ${st.byWeekday.map((c, i) => `${wd[i]} ${c}`).join(' · ')}` +
      (st.top.length ? `\n\n🏆 Самые активные:\n${st.top.map((t) => `• ${esc(t.name)} — ${t.c}`).join('\n')}` : ''),
      { parse_mode: 'HTML' },
    );
  });
  admin.hears('📢 Рассылка', async (ctx) => {
    waiting.set(ctx.from.id, { type: 'broadcast' });
    await ctx.reply('Напишите текст рассылки для всех учеников. /cancel — отмена.');
  });
  admin.callbackQuery('bc|send', async (ctx) => {
    await ctx.answerCallbackQuery();
    const st = waiting.get(ctx.from.id);
    if (st?.type !== 'broadcast_confirm') return;
    waiting.delete(ctx.from.id);
    let ok = 0;
    for (const u of D.listStudents().filter((x) => !x.blocked)) {
      try { await bot.api.sendMessage(u.tg_id, `📢 ${st.text}`); ok++; } catch {}
    }
    D.log(ctx.from.id, 'broadcast', { text: st.text, delivered: ok });
    await ctx.editMessageText(`📢 Рассылка отправлена: ${ok} получателей.`);
  });
  admin.hears('📤 Экспорт', (ctx) => ctx.reply('Что выгрузить в CSV (открывается в Excel)?', {
    reply_markup: new InlineKeyboard().text('Уроки', 'exp|bookings').text('Ученики', 'exp|students').row().text('Оплаты', 'exp|payments').text('Журнал', 'exp|logs'),
  }));
  admin.callbackQuery(/^exp\|(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const csv = D.exportCsv(ctx.match[1]);
    if (!csv) return ctx.reply('Пока нет данных.');
    D.log(ctx.from.id, 'export', { kind: ctx.match[1] });
    await ctx.replyWithDocument(new InputFile(Buffer.from(csv), `${ctx.match[1]}_${D.nowLocal().date}.csv`));
  });

  // Стать преподавателем: /admin <код из .env>. Неверные попытки логируются и ограничены.
  const adminTries = new Map();
  bot.command('admin', async (ctx) => {
    if (isAdmin(ctx.from.id)) return ctx.reply('Вы уже преподаватель 👍', { reply_markup: adminMenu() });
    const tries = (adminTries.get(ctx.from.id) || 0) + 1;
    adminTries.set(ctx.from.id, tries);
    if (tries > 5) return;
    if (!config.adminCode || ctx.match.trim() !== config.adminCode) {
      D.log(ctx.from.id, 'security.admin_code_fail', { tries });
      return ctx.reply('Неверный код.');
    }
    D.addAdmin(ctx.from.id);
    D.updateUser(ctx.from.id, { registered: 0 }, ctx.from.id);
    await ctx.reply('✅ Вы — преподаватель. Добро пожаловать в панель управления!', { reply_markup: adminMenu() });
  });

  bot.command('cancel', async (ctx) => { waiting.delete(ctx.from.id); await ctx.reply('Ок, отменено.'); });
  bot.command('id', (ctx) => ctx.reply(`Ваш Telegram ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' }));

  // ---------- текстовые ответы в состояниях ----------
  bot.on('message:text', async (ctx) => {
    const st = waiting.get(ctx.from.id);
    const text = ctx.message.text.trim();
    if (!st) return ctx.reply('Не понял 🙂 Воспользуйтесь меню ниже.', { reply_markup: isAdmin(ctx.from.id) ? adminMenu() : studentMenu() });

    if (st.type === 'reg_name') {
      D.updateUser(ctx.from.id, { name: text.slice(0, 60) }, ctx.from.id);
      return askLevel(ctx);
    }
    if (!isAdmin(ctx.from.id)) return;
    waiting.delete(ctx.from.id);

    if (st.type === 'hw') {
      const [topic, ...rest] = text.split('\n');
      const b = D.updateBookingNotes(st.bookingId, { topic, homework: rest.join('\n').trim() || topic }, ctx.from.id);
      await ctx.reply('📚 Сохранено и отправлено ученику.');
      return notifyUser(b.user_id, `📚 <b>Домашнее задание</b> (${fmtDate(b.date)})\n${b.topic ? `Тема: ${esc(b.topic)}\n` : ''}\n${esc(b.homework)}`);
    }
    if (st.type === 'stu_pay') {
      const m = text.match(/^(\d+)\s+(-?\d+)\s*(.*)$/);
      if (!m) { waiting.set(ctx.from.id, st); return ctx.reply('Формат: <code>6000 4 комментарий</code>', { parse_mode: 'HTML' }); }
      const u = D.addPayment(st.uid, Number(m[1]), Number(m[2]), m[3], ctx.from.id);
      await ctx.reply(`💳 Оплата записана. Баланс ${esc(u.name)}: ${u.balance} ур.`, { parse_mode: 'HTML' });
      return notifyUser(u.tg_id, `💳 Оплата получена: ${m[1]} ₽ (+${m[2]} ур.). Баланс: <b>${u.balance}</b> ур. Спасибо!`);
    }
    if (st.type === 'stu_note') {
      D.updateUser(st.uid, { notes: text }, ctx.from.id);
      return studentCard(ctx, st.uid);
    }
    if (st.type === 'stu_msg') {
      await notifyUser(st.uid, `✉️ <b>Сообщение от преподавателя</b>\n\n${esc(text)}`);
      D.log(ctx.from.id, 'message.sent', { user_id: st.uid, text });
      return ctx.reply('✉️ Отправлено.');
    }
    if (st.type === 'broadcast') {
      waiting.set(ctx.from.id, { type: 'broadcast_confirm', text });
      return ctx.reply(`Отправить всем ученикам?\n\n${text}`, { reply_markup: new InlineKeyboard().text('📢 Отправить', 'bc|send').text('Отмена', 'noop') });
    }
  });

  bot.catch((err) => console.error('Bot error:', err.error?.message || err));

  // ---------- напоминания ----------
  function startReminders() {
    const tick = async () => {
      for (const { b, kind } of D.dueReminders()) {
        const when = kind === 'rem1' ? 'через час' : 'завтра';
        await notifyUser(b.user_id, `⏰ Напоминание: урок английского ${when} — <b>${fmtDate(b.date)}, ${b.start}</b>`);
        D.markReminded(b.id, kind);
        D.log(null, `reminder.${kind}`, { booking_id: b.id, user_id: b.user_id });
      }
    };
    setInterval(() => tick().catch(console.error), 60_000);
    tick().catch(console.error);
  }

  const sendFile = (chatId, name, content) => bot.api.sendDocument(chatId, new InputFile(Buffer.from(content), name));
  return { bot, notifyUser, notifyAdmins, sendFile, startReminders, adminMenu, studentMenu };
}
