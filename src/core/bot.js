import { Bot, InlineKeyboard, Keyboard, InputFile } from 'grammy';
import { fmtDate, addDays, TIMEZONES, tzLabel, tzShort } from './time.js';
import { createNotifier, esc, who, lessons, money, NOTIFY_TYPES } from './notify.js';

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
const hm = (t) => t.replace(':', '');
const unhm = (t) => `${t.slice(0, 2)}:${t.slice(2)}`;
export const SITE_BUTTON = '🌐 Открыть сайт';

/**
 * Создаёт бота. Работает и в long polling (Mac), и через webhook (Cloudflare).
 * botInfo можно передать, чтобы не вызывать getMe на каждом запросе serverless.
 */
export function createBot({ token, store, cfg, botInfo }) {
  const bot = new Bot(token, botInfo ? { botInfo } : undefined);
  const N = createNotifier(bot.api, store);
  const isAdmin = (id) => store.isAdmin(id);

  // ---------- клавиатуры ----------
  const studentMenu = () => {
    const kb = new Keyboard().text('📅 Записаться').text('📋 Мои уроки').row()
      .text('💳 Баланс и оплата').text('📚 Домашка').row()
      .text('🔔 Уведомления').text('ℹ️ Правила');
    if (cfg.webAppUrl) kb.row().webApp(SITE_BUTTON, cfg.webAppUrl);
    return kb.resized();
  };
  const adminMenu = () => {
    const kb = new Keyboard().text('📆 Сегодня').text('🗓 Неделя').row()
      .text('⏳ Заявки').text('🧾 Чеки').row()
      .text('👥 Ученики').text('📊 Статистика').row()
      .text('📢 Рассылка').text('📤 Экспорт');
    if (cfg.webAppUrl) kb.row().webApp(SITE_BUTTON, cfg.webAppUrl);
    return kb.resized();
  };
  const menuFor = (id) => (isAdmin(id) ? adminMenu() : studentMenu());

  // ---------- антифлуд ----------
  const flood = new Map();
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || isAdmin(id)) return next();
    const now = Date.now();
    let f = flood.get(id);
    if (!f || f.reset < now) { f = { n: 0, reset: now + 20_000, warned: false }; flood.set(id, f); }
    if (++f.n > 25) {
      if (!f.warned) { f.warned = true; await store.log(id, 'security.flood', { count: f.n }); await ctx.reply('⏳ Слишком много сообщений. Подождите немного.').catch(() => {}); }
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    if (flood.size > 5000) for (const [k, v] of flood) if (v.reset < now) flood.delete(k);
    await next();
  });

  // ---------- пользователь в контексте ----------
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      ctx.u = await store.upsertTgUser(ctx.from);
      if (ctx.u.blocked && !isAdmin(ctx.from.id)) return;
    }
    await next();
  });

  // ---------- /start, регистрация, привязка ----------
  bot.command('start', async (ctx) => {
    const s = await store.getSettings();
    const payload = ctx.match?.trim();
    if (payload?.startsWith('link_')) {
      const linked = await store.linkTelegram(payload.slice(5), ctx.from);
      if (linked) {
        ctx.u = linked;
        await N.toAdmins(`🔗 ${who(linked)} подключил Telegram к своей карточке.`);
        return ctx.reply(`Здравствуйте, ${esc(linked.name)}! 👋 Ваш Telegram подключён. Преподаватель — <b>${esc(s.teacher_name)}</b>.\n\n💳 Оплаченных уроков: <b>${linked.balance}</b>`,
          { parse_mode: 'HTML', reply_markup: studentMenu() });
      }
    }
    if (isAdmin(ctx.from.id)) {
      return ctx.reply(`👋 Режим преподавателя. Ваш ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML', reply_markup: adminMenu() });
    }
    if (ctx.u.registered) return ctx.reply(`С возвращением, ${esc(ctx.u.name)}! 👋`, { parse_mode: 'HTML', reply_markup: studentMenu() });
    await store.setState(ctx.from.id, { type: 'reg_name' });
    await store.log(ctx.from.id, 'user.start', { username: ctx.from.username });
    await ctx.reply(`Hello! 👋 Это бот для записи на уроки английского.\nПреподаватель — <b>${esc(s.teacher_name)}</b>.\n\nКак вас зовут?`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text(`Оставить «${ctx.u.name}»`, 'reg|name') });
  });

  async function askLevel(ctx) {
    await store.setState(ctx.from.id, { type: 'reg_level' });
    const kb = new InlineKeyboard();
    LEVELS.forEach((l, i) => { kb.text(l, `reg|lvl|${l}`); if (i % 3 === 2) kb.row(); });
    await ctx.reply('Ваш уровень английского?', { reply_markup: kb });
  }
  bot.callbackQuery('reg|name', async (ctx) => { await ctx.answerCallbackQuery(); await askLevel(ctx); });
  bot.callbackQuery(/^reg\|lvl\|(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await store.updateUser(ctx.u.id, { level: ctx.match[1] }, ctx.from.id);
    const kb = new InlineKeyboard();
    GOALS.forEach((g, i) => { kb.text(g, `reg|goal|${i}`); if (i % 2) kb.row(); });
    await ctx.editMessageText(`Уровень: <b>${ctx.match[1]}</b>\n\nКакая главная цель?`, { parse_mode: 'HTML', reply_markup: kb });
  });
  const tzKeyboard = (prefix) => {
    const kb = new InlineKeyboard();
    TIMEZONES.forEach(([, name], i) => { kb.text(name, `${prefix}|${i}`); if (i % 3 === 2) kb.row(); });
    return kb;
  };
  bot.callbackQuery(/^reg\|goal\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await store.updateUser(ctx.u.id, { goal: GOALS[Number(ctx.match[1])] }, ctx.from.id);
    const kb = new InlineKeyboard().text('🇷🇺 Москва (UTC+3)', `tzr|${TIMEZONES.findIndex(([z]) => z === 'Europe/Moscow')}`).row().text('Другой часовой пояс…', 'tzr|list');
    await ctx.editMessageText(`Цель: <b>${esc(GOALS[Number(ctx.match[1])])}</b> ✅\n\n🌍 В каком часовом поясе вы живёте? Время уроков буду показывать по нему.`, { parse_mode: 'HTML', reply_markup: kb });
  });
  bot.callbackQuery('tzr|list', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: tzKeyboard('tzr') });
  });
  bot.callbackQuery(/^tzr\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const tz = TIMEZONES[Number(ctx.match[1])]?.[0] || 'Europe/Moscow';
    await store.setState(ctx.from.id, null);
    const u = await store.updateUser(ctx.u.id, { tz, registered: 1 }, ctx.from.id);
    await store.log(ctx.from.id, 'user.registered', { user_id: u.id, name: u.name, level: u.level, goal: u.goal });
    await ctx.editMessageText(`🌍 Часовой пояс: <b>${tzLabel(tz)}</b> ✅`, { parse_mode: 'HTML' });
    await ctx.reply('Готово! Теперь можно записаться на урок 👇\n\n🔔 Я буду напоминать об уроках за сутки, за 2 часа и за 15 минут. Настроить — кнопка «🔔 Уведомления».', { reply_markup: studentMenu() });
    await N.toAdmins(`🆕 Новый ученик: ${who(u)}\nУровень: ${esc(u.level)} · Цель: ${esc(u.goal)}\n🌍 ${tzLabel(u.tz)}`,
      { reply_markup: new InlineKeyboard().text('Открыть карточку', `stu|${u.id}`) });
  });

  // ---------- выбор даты/времени ----------
  // mode: bk — ученик записывается; ab — админ записывает ученика (arg = user.id); rs — перенос (arg = booking.id)
  /** Дни и слоты показываются в часовом поясе того, кто смотрит (ученик — свой, преподаватель — свой). */
  async function showDays(ctx, mode, arg, offset = 0, edit = false) {
    const s = await store.getSettings();
    const tz = store.tzOf(ctx.u);
    const today = store.nowIn(tz).date;
    const span = Number(s.days_ahead);
    const tToday = store.T.now().date;
    const byDay = await store.freeByViewerDate(tz, addDays(tToday, -1), addDays(tToday, span + 1));
    const kb = new InlineKeyboard();
    let shown = 0;
    let i = offset;
    for (; i <= span && shown < 8; i++) {
      const d = addDays(today, i);
      const free = byDay[d]?.length || 0;
      if (!free) continue;
      kb.text(`${fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' })} · ${free}`, `d|${mode}|${arg}|${d}`);
      if (++shown % 2 === 0) kb.row();
    }
    if (shown % 2) kb.row();
    if (offset > 0) kb.text('◀️ Раньше', `dl|${mode}|${arg}|${Math.max(0, offset - 8)}`);
    if (i <= span) kb.text('Дальше ▶️', `dl|${mode}|${arg}|${i}`);
    const tzNote = tz !== store.cfg.tz ? `\n🌍 Время указано по вашему поясу: ${tzLabel(tz)}` : '';
    const text = shown ? `Выберите день (цифра — сколько свободных окон):${tzNote}` : 'Свободных окон пока нет 😔 Напишите преподавателю — постараемся найти время.';
    return edit ? ctx.editMessageText(text, { reply_markup: kb }) : ctx.reply(text, { reply_markup: kb });
  }
  bot.callbackQuery(/^dl\|(\w+)\|(\d+)\|(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showDays(ctx, ctx.match[1], ctx.match[2], Number(ctx.match[3]), true); });
  bot.callbackQuery(/^d\|(\w+)\|(\d+)\|([\d-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, mode, arg, date] = ctx.match; // date — дата в поясе зрителя
    const tz = store.tzOf(ctx.u);
    const byDay = await store.freeByViewerDate(tz, addDays(date, -1), addDays(date, 1));
    const slots = byDay[date] || [];
    const kb = new InlineKeyboard();
    // в кнопке — время зрителя, в данных — время преподавателя (так хранится в базе)
    slots.forEach((sl, i) => { kb.text(sl.vtime, `t|${mode}|${arg}|${sl.date}|${hm(sl.start)}`); if (i % 4 === 3) kb.row(); });
    kb.row().text('◀️ К датам', `dl|${mode}|${arg}|0`);
    await ctx.editMessageText(slots.length ? `${fmtDate(date)} — выберите время${tz !== store.cfg.tz ? ` (${tzShort(tz)})` : ''}:` : 'На этот день окон уже нет.', { reply_markup: kb });
  });
  bot.callbackQuery(/^t\|(\w+)\|(\d+)\|([\d-]+)\|(\d{4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, mode, arg, date, t] = ctx.match;
    const start = unhm(t);
    try {
      if (mode === 'bk') {
        const s = await store.getSettings();
        return ctx.editMessageText(
          `Записаться на <b>${N.when(ctx.u, date, start)}</b>?\nДлительность: ${s.lesson_duration} мин · ${money(store.priceOf(ctx.u, s), s)}`,
          { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('✅ Записаться', `ok|${date}|${t}`).text('◀️ Назад', `d|bk|0|${store.toTz(date, start, store.tzOf(ctx.u)).date}`) },
        );
      }
      if (mode === 'ab') {
        if (!isAdmin(ctx.from.id)) return;
        const b = await store.createBooking({ userId: Number(arg), date, start, actorTgId: ctx.from.id, force: true });
        await ctx.editMessageText(`✅ Урок добавлен: ${esc(b.name)}, ${fmtDate(date)} ${start}`, { parse_mode: 'HTML' });
        return N.toUser(b, `📌 Преподаватель записал вас на урок: <b>${N.when(b, date, start)}</b>`);
      }
      if (mode === 'rs') {
        const old = await store.getBooking(Number(arg));
        if (!old || (old.tg_id !== ctx.from.id && !isAdmin(ctx.from.id))) return;
        const b = await store.rescheduleBooking(old.id, date, start, ctx.from.id);
        const lineFor = (u) => `${N.when(u, old.date, old.start)} → <b>${N.when(u, date, start)}</b>`;
        const student = await store.getUser(b.user_id);
        await ctx.editMessageText(`🔁 Урок перенесён: ${lineFor(ctx.u)}`, { parse_mode: 'HTML' });
        if (isAdmin(ctx.from.id)) await N.toUser(student, `🔁 Преподаватель перенёс урок: ${lineFor(student)}`);
        else await N.toAdmins(`🔁 ${who(b)} перенёс урок: ${fmtDate(old.date)} ${old.start} → <b>${fmtDate(date)} ${start}</b>`);
      }
    } catch (e) {
      await ctx.editMessageText(`⚠️ ${e.message}`, { reply_markup: new InlineKeyboard().text('Выбрать другое время', `dl|${mode}|${arg}|0`) });
    }
  });
  bot.callbackQuery(/^ok\|([\d-]+)\|(\d{4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.u.registered) return ctx.reply('Сначала пройдите регистрацию: /start');
    try {
      const b = await store.createBooking({ userId: ctx.u.id, date: ctx.match[1], start: unhm(ctx.match[2]) });
      await ctx.editMessageText(
        `${b.status === 'confirmed' ? '✅ Вы записаны' : '⏳ Заявка отправлена'}: <b>${N.when(ctx.u, b.date, b.start)}</b>` +
        (b.status === 'pending' ? '\nПреподаватель подтвердит её в ближайшее время.' : ''), { parse_mode: 'HTML' });
      const kb = new InlineKeyboard();
      if (b.status === 'pending') kb.text('✅ Подтвердить', `adm|confirm|${b.id}`).text('❌ Отклонить', `adm|reject|${b.id}`);
      const vtz = store.tzOf(ctx.u);
      const local = vtz !== store.cfg.tz ? `\n🌍 У ученика: ${N.when(ctx.u, b.date, b.start, { tz: 'always' })}` : '';
      await N.toAdmins(`${b.status === 'pending' ? '📥 Новая заявка' : '📌 Новая запись'}: ${who(ctx.u)}\n<b>${fmtDate(b.date)}, ${b.start}–${b.end}</b>${local}\nБаланс ученика: ${lessons(ctx.u.balance)}`, { reply_markup: kb });
    } catch (e) {
      await ctx.editMessageText(`⚠️ ${e.message}`, { reply_markup: new InlineKeyboard().text('Выбрать другое время', 'dl|bk|0|0') });
    }
  });

  // ---------- меню ученика ----------
  bot.hears('📅 Записаться', (ctx) => showDays(ctx, 'bk', 0));
  bot.command('book', (ctx) => showDays(ctx, 'bk', 0));

  bot.hears('📋 Мои уроки', async (ctx) => {
    const list = await store.userBookings(ctx.u.id);
    if (!list.length) return ctx.reply('У вас нет запланированных уроков.', { reply_markup: new InlineKeyboard().text('📅 Записаться', 'dl|bk|0|0') });
    for (const b of list) {
      await ctx.reply(`<b>${N.when(ctx.u, b.date, b.start)}</b>\n${STATUS[b.status]}`, {
        parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔁 Перенести', `rsq|${b.id}`).text('❌ Отменить', `cnq|${b.id}`),
      });
    }
  });
  bot.callbackQuery(/^rsq\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const b = await store.getBooking(Number(ctx.match[1]));
    if (!b || (b.tg_id !== ctx.from.id && !isAdmin(ctx.from.id))) return;
    const s = await store.getSettings();
    if (!isAdmin(ctx.from.id) && store.T.minutesUntil(b.date, b.start) < Number(s.cancel_hours) * 60) {
      return ctx.reply(`Перенос возможен не позднее чем за ${s.cancel_hours} ч. Напишите преподавателю напрямую.`);
    }
    await showDays(ctx, 'rs', b.id);
  });
  bot.callbackQuery(/^cnq\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const b = await store.getBooking(Number(ctx.match[1]));
    if (!b || b.tg_id !== ctx.from.id) return;
    const s = await store.getSettings();
    const late = b.status === 'confirmed' && store.T.minutesUntil(b.date, b.start) < Number(s.cancel_hours) * 60;
    await ctx.editMessageText(`Отменить урок ${N.when(ctx.u, b.date, b.start)}?` + (late ? `\n\n⚠️ До урока меньше ${s.cancel_hours} ч — урок будет списан с баланса.` : ''),
      { reply_markup: new InlineKeyboard().text('Да, отменить', `cn|${b.id}`).text('Нет', 'noop') });
  });
  bot.callbackQuery(/^cn\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const { booking: b, late } = await store.cancelByStudent(Number(ctx.match[1]), ctx.from.id);
      await ctx.editMessageText(`❌ Урок ${N.when(ctx.u, b.date, b.start)} отменён${late ? ' (поздняя отмена, урок списан)' : ''}.`);
      await N.toAdmins(`❌ ${who(b)} отменил урок ${fmtDate(b.date)}, ${b.start}${late ? ' — <b>поздняя отмена</b>' : ''}`);
    } catch (e) { await ctx.editMessageText(`⚠️ ${e.message}`); }
  });
  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery('Ок').then(() => ctx.deleteMessage().catch(() => {})));

  // баланс, реквизиты, чек
  bot.hears(['💳 Баланс и оплата', '💳 Баланс'], async (ctx) => {
    const u = ctx.u;
    const s = await store.getSettings();
    const pays = (await store.userPayments(u.id)).slice(0, 5);
    await ctx.reply(
      `💳 Оплаченных уроков: <b>${u.balance}</b>${u.balance < 0 ? ' (задолженность)' : ''}\nСтоимость урока: <b>${money(store.priceOf(u, s), s)}</b>\n\n` +
      `<b>Реквизиты для оплаты:</b>\n${esc(s.payment_details)}\n\n` +
      (pays.length ? `Последние оплаты:\n${pays.map((p) => `• ${p.created_at.slice(0, 10)} — ${money(p.amount, s)} (+${lessons(p.lessons)})`).join('\n')}` : 'Оплат пока не было.'),
      { parse_mode: 'HTML', reply_markup: N.receiptButton() });
  });
  bot.callbackQuery('rcpt', async (ctx) => {
    await ctx.answerCallbackQuery();
    await store.setState(ctx.from.id, { type: 'receipt' });
    await ctx.reply('📎 Пришлите скриншот или файл чека об оплате одним сообщением.\nМожно добавить подпись — например, сумму. /cancel — отмена.');
  });
  bot.command('receipt', async (ctx) => {
    await store.setState(ctx.from.id, { type: 'receipt' });
    await ctx.reply('📎 Пришлите скриншот или файл чека об оплате.');
  });
  bot.on(['message:photo', 'message:document'], async (ctx) => {
    const st = await store.getState(ctx.from.id);
    if (st?.type !== 'receipt') {
      if (isAdmin(ctx.from.id)) return;
      return ctx.reply('Если это чек об оплате — нажмите кнопку ниже и пришлите его ещё раз 👇', { reply_markup: N.receiptButton() });
    }
    const photo = ctx.message.photo?.at(-1);
    const doc = ctx.message.document;
    if (doc && doc.file_size > 10 * 1024 * 1024) return ctx.reply('Файл слишком большой (максимум 10 МБ).');
    await store.setState(ctx.from.id, null);
    const r = await store.addReceipt(ctx.u.id, photo ? photo.file_id : doc.file_id, photo ? 'photo' : 'document', ctx.message.caption?.slice(0, 300), ctx.from.id);
    await ctx.reply('✅ Чек получен и отправлен преподавателю. Как только оплата будет подтверждена, баланс обновится — я пришлю уведомление.');
    await N.receiptToAdmins(r);
  });

  // уведомления — индивидуальные переключатели
  const notifyKb = (u) => {
    const kb = new InlineKeyboard();
    for (const [key, title] of NOTIFY_TYPES) kb.text(`${u[key] ? '✅' : '🔕'} ${title}`, `nt|${key}`).row();
    kb.text(`🌍 Часовой пояс: ${tzLabel(u.tz || 'Europe/Moscow')}`, 'tzm|list');
    return kb;
  };
  const notifyText = () => '🔔 <b>Уведомления</b>\n\nНажмите, чтобы включить или выключить:\n' +
    NOTIFY_TYPES.map(([, t, d]) => `• <b>${t}</b> — ${d}`).join('\n') +
    '\n\nНапоминания об оплате и сообщения от преподавателя приходят всегда.';
  bot.hears('🔔 Уведомления', (ctx) => ctx.reply(notifyText(), { parse_mode: 'HTML', reply_markup: notifyKb(ctx.u) }));
  bot.callbackQuery(/^nt\|(n_\w+)$/, async (ctx) => {
    const key = ctx.match[1];
    if (!NOTIFY_TYPES.some(([k]) => k === key)) return ctx.answerCallbackQuery();
    const u = await store.updateUser(ctx.u.id, { [key]: ctx.u[key] ? 0 : 1 }, ctx.from.id);
    await ctx.answerCallbackQuery(u[key] ? 'Включено' : 'Выключено');
    await ctx.editMessageReplyMarkup({ reply_markup: notifyKb(u) }).catch(() => {});
  });

  bot.callbackQuery('tzm|list', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('🌍 Выберите ваш часовой пояс — время уроков будет показываться по нему:', { reply_markup: tzKeyboard('tzm') });
  });
  bot.callbackQuery(/^tzm\|(\d+)$/, async (ctx) => {
    const tz = TIMEZONES[Number(ctx.match[1])]?.[0];
    if (!tz) return ctx.answerCallbackQuery();
    await store.updateUser(ctx.u.id, { tz }, ctx.from.id);
    await ctx.answerCallbackQuery('Сохранено');
    await ctx.editMessageText(`🌍 Часовой пояс: <b>${tzLabel(tz)}</b> ✅\nТеперь время уроков показывается по нему.`, { parse_mode: 'HTML' });
  });

  bot.hears('📚 Домашка', async (ctx) => {
    const hw = (await store.userBookings(ctx.u.id, { upcoming: false })).filter((b) => b.homework).slice(0, 5);
    if (!hw.length) return ctx.reply('Домашних заданий пока нет 🎉');
    await ctx.reply(hw.map((b) => `📚 <b>${N.whenDate(ctx.u, b.date, b.start)}</b>${b.topic ? ` · ${esc(b.topic)}` : ''}\n${esc(b.homework)}`).join('\n\n'), { parse_mode: 'HTML' });
  });
  bot.hears('ℹ️ Правила', async (ctx) => {
    const s = await store.getSettings();
    return ctx.reply(`ℹ️ <b>Правила</b>\n\n${esc(s.rules)}\n\nУрок: ${s.lesson_duration} мин · ${money(store.priceOf(ctx.u, s), s)}`, { parse_mode: 'HTML' });
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
      text: `<b>${fmtDate(b.date, { weekday: 'short', day: 'numeric', month: 'short' })}, ${b.start}–${b.end}</b> · ${who(b)}${b.manual && !b.tg_id ? ' 📒' : ''}\n${STATUS[b.status]}` +
        `${b.topic ? `\nТема: ${esc(b.topic)}` : ''}${b.homework ? `\nДЗ: ${esc(b.homework)}` : ''}`,
      kb,
    };
  }
  /** Общие действия над уроком (используются и в боте, и в мини-приложении). */
  async function applyStatus(id, status, actorTgId, via) {
    const b = await store.setBookingStatus(id, status, actorTgId, { by: 'teacher', via });
    const su = await store.getUser(b.user_id);
    const w = N.when(su, b.date, b.start);
    const msg = {
      confirmed: `✅ Урок подтверждён: <b>${w}</b>. До встречи!`,
      rejected: `😔 К сожалению, время ${w} не подошло. Выберите другое: /book`,
      cancelled: `❌ Преподаватель отменил урок ${w}. Выберите другое время: /book`,
    }[b.status];
    if (msg) await N.toUser(b, msg);
    if (b.status === 'done') await N.lessonDone(b);
    return b;
  }

  admin.hears('📆 Сегодня', async (ctx) => {
    const today = store.T.now().date;
    const list = (await store.bookingsBetween(today, today)).filter((b) => !['cancelled', 'rejected'].includes(b.status));
    if (!list.length) return ctx.reply(`📆 ${fmtDate(today)} — уроков нет. Отдыхайте ☕️`);
    await ctx.reply(`📆 <b>${fmtDate(today)}</b> — уроков: ${list.length}`, { parse_mode: 'HTML' });
    for (const b of list) { const c = lessonCard(b); await ctx.reply(c.text, { parse_mode: 'HTML', reply_markup: c.kb }); }
  });
  admin.hears('🗓 Неделя', async (ctx) => {
    const today = store.T.now().date;
    const to = addDays(today, 6);
    const cal = await store.calendarRange(today, to);
    const list = (await store.bookingsBetween(today, to)).filter((b) => ['pending', 'confirmed', 'done'].includes(b.status));
    const bar = (l) => '▓'.repeat(Math.round(l * 10)) + '░'.repeat(10 - Math.round(l * 10));
    const lines = cal.map((d) => {
      const head = `<b>${fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b> ${d.off ? '— выходной' : `${bar(d.load)} ${d.lessons}/${d.capacity}`}`;
      return [head, ...list.filter((b) => b.date === d.date).map((b) => `   ${b.start} ${esc(b.name)}${b.status === 'pending' ? ' ⏳' : ''}`)].join('\n');
    });
    await ctx.reply(`🗓 <b>Неделя</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });
  admin.hears('⏳ Заявки', async (ctx) => {
    const list = await store.pendingBookings();
    if (!list.length) return ctx.reply('Новых заявок нет ✨');
    for (const b of list) {
      await ctx.reply(`📥 ${who(b)}\n<b>${fmtDate(b.date)}, ${b.start}–${b.end}</b>`, {
        parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('✅ Подтвердить', `adm|confirm|${b.id}`).text('❌ Отклонить', `adm|reject|${b.id}`),
      });
    }
  });
  admin.hears('🧾 Чеки', async (ctx) => {
    const list = await store.pendingReceipts();
    if (!list.length) return ctx.reply('Неподтверждённых чеков нет ✨');
    for (const r of list) await N.receiptToAdmins({ ...r, tg_id: undefined });
  });

  admin.callbackQuery(/^adm\|(\w+)\|(\d+)$/, async (ctx) => {
    const [, action, idStr] = ctx.match;
    const id = Number(idStr);
    const map = { confirm: 'confirmed', reject: 'rejected', done: 'done', noshow: 'no_show', cancel: 'cancelled' };
    if (action === 'hw') {
      await ctx.answerCallbackQuery();
      await store.setState(ctx.from.id, { type: 'hw', bookingId: id });
      return ctx.reply('Напишите тему урока и домашнее задание.\nФормат: первая строка — тема, дальше — ДЗ.');
    }
    if (!map[action]) return ctx.answerCallbackQuery();
    try {
      const b = await applyStatus(id, map[action], ctx.from.id, 'bot');
      await ctx.answerCallbackQuery(STATUS[b.status]);
      const c = lessonCard(b);
      await ctx.editMessageText(c.text, { parse_mode: 'HTML', reply_markup: c.kb }).catch(() => {});
      if (b.status === 'done') {
        await store.setState(ctx.from.id, { type: 'hw', bookingId: id });
        await ctx.reply('🎓 Отмечено. Ученику отправлено уведомление с балансом.\nНапишите тему и ДЗ (первая строка — тема) или /cancel.');
      }
    } catch (e) { await ctx.answerCallbackQuery(e.message); }
  });

  // чеки: зачислить / отклонить
  admin.callbackQuery(/^rc\|ok\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const r = await store.getReceipt(Number(ctx.match[1]));
    if (!r || r.status !== 'pending') return ctx.reply('Этот чек уже обработан.');
    const s = await store.getSettings();
    const price = store.priceOf(r, s);
    const kb = new InlineKeyboard();
    [1, 4, 8].forEach((n) => kb.text(`+${lessons(n)} (${money(n * price, s)})`, `rc|n|${r.id}|${n}`).row());
    kb.text('Другое количество', `rc|custom|${r.id}`);
    await ctx.reply(`Сколько уроков зачислить ученику ${who(r)}?`, { parse_mode: 'HTML', reply_markup: kb });
  });
  admin.callbackQuery(/^rc\|n\|(\d+)\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const { user, amount } = await store.acceptReceipt(Number(ctx.match[1]), Number(ctx.match[2]), null, ctx.from.id);
      const s = await store.getSettings();
      await ctx.editMessageText(`✅ Зачислено: ${who(user)} +${lessons(Number(ctx.match[2]))} (${money(amount, s)}). Баланс: ${lessons(user.balance)}.`, { parse_mode: 'HTML' });
      await N.toUser(user, `✅ <b>Оплата подтверждена!</b> +${lessons(Number(ctx.match[2]))}.\n💳 Оплаченных уроков: <b>${user.balance}</b>. Спасибо!`);
    } catch (e) { await ctx.editMessageText(`⚠️ ${e.message}`); }
  });
  admin.callbackQuery(/^rc\|custom\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await store.setState(ctx.from.id, { type: 'rc_custom', receiptId: Number(ctx.match[1]) });
    await ctx.reply('Введите: <code>количество_уроков [сумма]</code>\nНапример: <code>5</code> или <code>5 7000</code>', { parse_mode: 'HTML' });
  });
  admin.callbackQuery(/^rc\|no\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const r = await store.rejectReceipt(Number(ctx.match[1]), ctx.from.id);
      await ctx.reply(`❌ Чек от ${who(r)} отклонён.`, { parse_mode: 'HTML' });
      await N.toUser(r, '⚠️ Преподаватель не смог подтвердить оплату по этому чеку. Пожалуйста, проверьте перевод или свяжитесь с преподавателем.');
    } catch (e) { await ctx.reply(`⚠️ ${e.message}`); }
  });

  // карточка ученика
  async function studentCard(ctx, uid, edit = false) {
    const u = await store.getUser(uid);
    if (!u) return ctx.reply('Ученик не найден');
    const s = await store.getSettings();
    const hist = await store.userBookings(uid, { upcoming: false });
    const next = (await store.userBookings(uid))[0];
    const text = `👤 <b>${esc(u.name)}</b>${u.username ? ` · @${esc(u.username)}` : ''}${u.tg_id ? '' : ' · 📒 без Telegram'}\n` +
      `Уровень: ${esc(u.level || '—')} · Цель: ${esc(u.goal || '—')}\n` +
      (u.tg_id ? `🌍 ${tzLabel(u.tz || 'Europe/Moscow')}\n` : '') +
      `Цена урока: ${money(store.priceOf(u, s), s)}${u.price ? ' (индивидуальная)' : ''}\n` +
      `Баланс: <b>${lessons(u.balance)}</b> · Проведено: ${hist.filter((b) => b.status === 'done').length}\n` +
      `Ближайший: ${next ? `${fmtDate(next.date)}, ${next.start}` : '—'}\n` +
      (u.notes ? `📝 ${esc(u.notes)}\n` : '') + (u.blocked ? '🚫 Заблокирован\n' : '');
    const kb = new InlineKeyboard().text('💳 Оплата', `stu_pay|${uid}`).text('➕ Урок', `dl|ab|${uid}|0`).row()
      .text('📝 Заметка', `stu_note|${uid}`);
    if (u.tg_id) kb.text('✉️ Написать', `stu_msg|${uid}`).row().text('💳 Напомнить об оплате', `stu_remind|${uid}`).row();
    else kb.text('🔗 Ссылка-приглашение', `stu_link|${uid}`).row();
    kb.text(u.blocked ? '✅ Разблокировать' : '🚫 Заблокировать', `stu_blk|${uid}`);
    return edit ? ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }) : ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
  admin.hears('👥 Ученики', async (ctx) => {
    const list = await store.listStudents();
    if (!list.length) return ctx.reply(`Учеников пока нет. Поделитесь ссылкой: https://t.me/${ctx.me.username}\nИли добавьте ученика вручную на сайте (👥 Ученики → ＋).`);
    const kb = new InlineKeyboard();
    list.forEach((u, i) => { kb.text(`${u.tg_id ? '' : '📒 '}${u.name} · ${u.balance}`, `stu|${u.id}`); if (i % 2) kb.row(); });
    await ctx.reply(`👥 Учеников: ${list.length} (цифра — баланс уроков, 📒 — без Telegram)`, { reply_markup: kb });
  });
  admin.callbackQuery(/^stu\|(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await studentCard(ctx, Number(ctx.match[1])); });
  admin.callbackQuery(/^stu_blk\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await store.getUser(Number(ctx.match[1]));
    await store.updateUser(u.id, { blocked: u.blocked ? 0 : 1 }, ctx.from.id);
    await studentCard(ctx, u.id, true);
  });
  admin.callbackQuery(/^stu_remind\|(\d+)$/, async (ctx) => {
    const u = await store.getUser(Number(ctx.match[1]));
    const ok = await N.paymentReminder(u);
    await store.log(ctx.from.id, 'payment.reminder', { user_id: u.id, manual: true });
    await ctx.answerCallbackQuery(ok ? 'Напоминание отправлено' : 'Не удалось отправить');
  });
  admin.callbackQuery(/^stu_link\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const code = await store.ensureLinkCode(Number(ctx.match[1]));
    await ctx.reply(`🔗 Ссылка-приглашение (по желанию — можно не отправлять):\nhttps://t.me/${ctx.me.username}?start=link_${code}\n\nЕсли ученик откроет её, его Telegram привяжется к этой карточке вместе с историей и балансом.`);
  });
  for (const [key, prompt] of [
    ['pay', 'Введите оплату: <code>сумма количество_уроков [комментарий]</code>\nНапример: <code>6000 4 пакет ноябрь</code>'],
    ['note', 'Напишите заметку об ученике (заменит текущую):'],
    ['msg', 'Напишите сообщение — я перешлю его ученику:'],
  ]) {
    admin.callbackQuery(new RegExp(`^stu_${key}\\|(\\d+)$`), async (ctx) => {
      await ctx.answerCallbackQuery();
      await store.setState(ctx.from.id, { type: `stu_${key}`, uid: Number(ctx.match[1]) });
      await ctx.reply(prompt, { parse_mode: 'HTML' });
    });
  }

  admin.hears('📊 Статистика', async (ctx) => {
    const s = await store.getSettings();
    const today = store.T.now().date;
    const st = await store.stats(today.slice(0, 8) + '01', today);
    const wd = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    await ctx.reply(
      `📊 <b>${fmtDate(today, { month: 'long', year: 'numeric' })}</b> (за любой период — на сайте)\n` +
      `🎓 Проведено: ${st.done} · на сумму ${money(st.earned, s)}\n⏳ Впереди: ${st.upcoming}\n` +
      `❌ Отмены: ученик ${st.cancelled_student} · преподаватель ${st.cancelled_teacher} · 🚫 отклонено ${st.rejected} · 🙈 неявки ${st.no_show}\n` +
      `💰 Оплачено: ${money(st.income, s)}\n👥 Учеников: ${st.students} · без оплаченных уроков: ${st.debtors}\n` +
      `📈 Загрузка: ${Math.round(st.load * 100)}%\n\nПо дням недели: ${st.byWeekday.map((c, i) => `${wd[i]} ${c}`).join(' · ')}`,
      { parse_mode: 'HTML' });
  });
  admin.hears('📢 Рассылка', async (ctx) => {
    await store.setState(ctx.from.id, { type: 'broadcast' });
    await ctx.reply('Напишите текст рассылки для всех учеников. /cancel — отмена.');
  });
  admin.callbackQuery('bc|send', async (ctx) => {
    await ctx.answerCallbackQuery();
    const st = await store.getState(ctx.from.id);
    if (st?.type !== 'broadcast_confirm') return;
    await store.setState(ctx.from.id, null);
    let ok = 0;
    for (const u of (await store.listStudents()).filter((x) => !x.blocked && x.tg_id)) {
      try { await bot.api.sendMessage(u.tg_id, `📢 ${st.text}`); ok++; } catch {}
    }
    await store.log(ctx.from.id, 'broadcast', { text: st.text, delivered: ok });
    await ctx.editMessageText(`📢 Рассылка отправлена: ${ok} получателей.`);
  });
  admin.hears('📤 Экспорт', (ctx) => ctx.reply('Что выгрузить в CSV (открывается в Excel)?', {
    reply_markup: new InlineKeyboard().text('Уроки', 'exp|bookings').text('Ученики', 'exp|students').row().text('Оплаты', 'exp|payments').text('Журнал', 'exp|logs'),
  }));
  admin.callbackQuery(/^exp\|(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const csv = await store.exportCsv(ctx.match[1]);
    if (!csv) return ctx.reply('Пока нет данных.');
    await store.log(ctx.from.id, 'export', { kind: ctx.match[1] });
    await ctx.replyWithDocument(new InputFile(new TextEncoder().encode(csv), `${ctx.match[1]}_${store.T.now().date}.csv`));
  });

  // стать преподавателем по коду
  bot.command('admin', async (ctx) => {
    if (isAdmin(ctx.from.id)) return ctx.reply('Вы уже преподаватель 👍', { reply_markup: adminMenu() });
    const st = (await store.getState(ctx.from.id)) || {};
    const tries = (st.adminTries || 0) + 1;
    if (tries > 5) return;
    if (!cfg.adminCode || ctx.match.trim() !== cfg.adminCode) {
      await store.setState(ctx.from.id, { ...st, adminTries: tries });
      await store.log(ctx.from.id, 'security.admin_code_fail', { tries });
      return ctx.reply('Неверный код.');
    }
    await store.addAdmin(ctx.from.id);
    await store.updateUser(ctx.u.id, { registered: 0 }, ctx.from.id);
    await store.setState(ctx.from.id, null);
    await ctx.reply('✅ Вы — преподаватель. Добро пожаловать в панель управления!', { reply_markup: adminMenu() });
  });

  bot.command('cancel', async (ctx) => { await store.setState(ctx.from.id, null); await ctx.reply('Ок, отменено.', { reply_markup: menuFor(ctx.from.id) }); });
  bot.command('id', (ctx) => ctx.reply(`Ваш Telegram ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' }));

  // ---------- текстовые ответы в состояниях ----------
  bot.on('message:text', async (ctx) => {
    const st = await store.getState(ctx.from.id);
    const text = ctx.message.text.trim();
    if (!st?.type) return ctx.reply('Не понял 🙂 Воспользуйтесь меню ниже.', { reply_markup: menuFor(ctx.from.id) });

    if (st.type === 'reg_name') {
      await store.updateUser(ctx.u.id, { name: text.slice(0, 60) }, ctx.from.id);
      return askLevel(ctx);
    }
    if (st.type === 'receipt') return ctx.reply('Пришлите, пожалуйста, именно скриншот или файл чека 📎 (или /cancel).');
    if (!isAdmin(ctx.from.id)) return;
    await store.setState(ctx.from.id, null);

    if (st.type === 'hw') {
      const [topic, ...rest] = text.split('\n');
      const b = await store.updateBookingNotes(st.bookingId, { topic, homework: rest.join('\n').trim() || topic }, ctx.from.id);
      await ctx.reply(b.tg_id ? '📚 Сохранено и отправлено ученику.' : '📚 Сохранено.');
      return N.homework(b);
    }
    if (st.type === 'rc_custom') {
      const m = text.match(/^(\d+)(?:\s+(\d+))?$/);
      if (!m) { await store.setState(ctx.from.id, st); return ctx.reply('Формат: <code>5</code> или <code>5 7000</code>', { parse_mode: 'HTML' }); }
      try {
        const { user, amount } = await store.acceptReceipt(st.receiptId, Number(m[1]), m[2] ?? null, ctx.from.id);
        const s = await store.getSettings();
        await ctx.reply(`✅ Зачислено: ${who(user)} +${lessons(Number(m[1]))} (${money(amount, s)}). Баланс: ${lessons(user.balance)}.`, { parse_mode: 'HTML' });
        return N.toUser(user, `✅ <b>Оплата подтверждена!</b> +${lessons(Number(m[1]))}.\n💳 Оплаченных уроков: <b>${user.balance}</b>. Спасибо!`);
      } catch (e) { return ctx.reply(`⚠️ ${e.message}`); }
    }
    if (st.type === 'stu_pay') {
      const m = text.match(/^(\d+)\s+(-?\d+)\s*(.*)$/);
      if (!m) { await store.setState(ctx.from.id, st); return ctx.reply('Формат: <code>6000 4 комментарий</code>', { parse_mode: 'HTML' }); }
      const u = await store.addPayment(st.uid, Number(m[1]), Number(m[2]), m[3], ctx.from.id);
      const s = await store.getSettings();
      await ctx.reply(`💳 Оплата записана. Баланс ${esc(u.name)}: ${lessons(u.balance)}.`, { parse_mode: 'HTML' });
      return N.toUser(u, `💳 Оплата получена: ${money(Number(m[1]), s)} (+${lessons(Number(m[2]))}). Оплаченных уроков: <b>${u.balance}</b>. Спасибо!`);
    }
    if (st.type === 'stu_note') { await store.updateUser(st.uid, { notes: text }, ctx.from.id); return studentCard(ctx, st.uid); }
    if (st.type === 'stu_msg') {
      const u = await store.getUser(st.uid);
      await N.toUser(u, `✉️ <b>Сообщение от преподавателя</b>\n\n${esc(text)}`);
      await store.log(ctx.from.id, 'message.sent', { user_id: st.uid, text });
      return ctx.reply('✉️ Отправлено.');
    }
    if (st.type === 'broadcast') {
      await store.setState(ctx.from.id, { type: 'broadcast_confirm', text });
      return ctx.reply(`Отправить всем ученикам?\n\n${text}`, { reply_markup: new InlineKeyboard().text('📢 Отправить', 'bc|send').text('Отмена', 'noop') });
    }
  });

  bot.catch((err) => console.error('Bot error:', err.error?.message || err));

  async function runReminders() {
    for (const { b, kind } of await store.dueReminders()) {
      await N.reminder(b, kind);
      await store.markReminded(b.id, kind);
      await store.log(null, `reminder.${kind}`, { booking_id: b.id, user_id: b.user_id });
    }
  }

  async function setupCommands() {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Главное меню' },
      { command: 'book', description: 'Записаться на урок' },
      { command: 'receipt', description: 'Отправить чек об оплате' },
      { command: 'id', description: 'Мой Telegram ID' },
    ]);
    if (cfg.webAppUrl) await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Сайт', web_app: { url: cfg.webAppUrl } } });
  }

  return { bot, N, applyStatus, runReminders, setupCommands };
}
