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
const short = (date) => fmtDate(date, { weekday: 'short', day: 'numeric', month: 'short' });
export const SITE_BUTTON = '🌐 Открыть сайт';
// Состояния «жду ввод», которые сбрасываются при уходе с экрана кнопками навигации
const TRANSIENT = ['receipt', 'hw', 'rc_custom', 'stu_pay', 'stu_note', 'stu_msg', 'broadcast', 'broadcast_confirm'];

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

  // ---------- навигация: «Назад» и «Меню» на каждом экране ----------
  /** Добавляет в конец клавиатуры строку «◀️ Назад» (если задано куда) и «🏠 Меню». */
  const nav = (kb = new InlineKeyboard(), back = 'home') => {
    kb.row();
    if (back) kb.text('◀️ Назад', back);
    return kb.text('🏠 Меню', 'home');
  };
  /** Показать экран: при нажатии кнопки — обновляем то же сообщение, иначе — новое. */
  async function show(ctx, text, kb, extra = {}) {
    const opts = { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true }, ...extra };
    const msg = ctx.callbackQuery?.message;
    // Обновляем на месте только экраны меню; уведомления (заявки, напоминания, чеки) не перезаписываем
    const isScreen = msg?.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data === 'home' || /^(reg|tzr|m)\|/.test(b.callback_data || ''));
    if (msg && isScreen && !msg.photo && !msg.document) {
      try { return await ctx.editMessageText(text, opts); } catch (e) {
        if (/not modified/i.test(e.message)) return;
      }
    }
    return ctx.reply(text, opts);
  }
  async function clearTransient(ctx) {
    const st = await store.getState(ctx.from.id);
    if (st && TRANSIENT.includes(st.type)) await store.setState(ctx.from.id, null);
  }

  /** Разделы меню: открываются и текстовой кнопкой снизу, и инлайн-кнопкой `m|ключ`. */
  const screens = {};
  const studentSections = [
    ['book', '📅 Записаться'], ['my', '📋 Мои уроки'], ['bal', '💳 Баланс и оплата'],
    ['hw', '📚 Домашка'], ['notif', '🔔 Уведомления'], ['rules', 'ℹ️ Правила'],
  ];
  const adminSections = [
    ['today', '📆 Сегодня'], ['week', '🗓 Неделя'], ['pending', '⏳ Заявки'], ['rcpts', '🧾 Чеки'],
    ['students', '👥 Ученики'], ['stats', '📊 Статистика'], ['bc', '📢 Рассылка'], ['exp', '📤 Экспорт'],
  ];
  async function homeScreen(ctx) {
    const admin = isAdmin(ctx.from.id);
    if (!admin && !ctx.u.registered) return ctx.reply('Сначала пройдём короткую регистрацию: /start');
    const kb = new InlineKeyboard();
    (admin ? adminSections : studentSections).forEach(([k, label], i) => { kb.text(label, `m|${k}`); if (i % 2) kb.row(); });
    if (cfg.webAppUrl) kb.row().webApp(SITE_BUTTON, cfg.webAppUrl);
    return show(ctx, admin ? '🏠 <b>Главное меню</b> — панель преподавателя' : `🏠 <b>Главное меню</b>\n💳 Оплаченных уроков: <b>${ctx.u.balance}</b>`, kb);
  }

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

  // главное меню: `home` — обновить текущий экран, `homen` — новым сообщением (из уведомлений, чтобы не стирать их)
  bot.callbackQuery('home', async (ctx) => { await ctx.answerCallbackQuery(); await clearTransient(ctx); await homeScreen(ctx); });
  bot.callbackQuery('homen', async (ctx) => { await ctx.answerCallbackQuery(); await clearTransient(ctx); await homeScreen(ctx); });
  bot.command('menu', (ctx) => homeScreen(ctx));
  bot.callbackQuery(/^m\|(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearTransient(ctx);
    const fn = screens[ctx.match[1]];
    if (fn) await fn(ctx);
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
        await ctx.reply(`Здравствуйте, ${esc(linked.name)}! 👋 Ваш Telegram подключён. Преподаватель — <b>${esc(s.teacher_name)}</b>.`,
          { parse_mode: 'HTML', reply_markup: studentMenu() });
        return homeScreen(ctx);
      }
    }
    if (isAdmin(ctx.from.id)) {
      await ctx.reply('👋 Режим преподавателя. Кнопки разделов — внизу, а также в меню ниже.', { reply_markup: adminMenu() });
      return homeScreen(ctx);
    }
    if (ctx.u.registered) {
      await ctx.reply(`С возвращением, ${esc(ctx.u.name)}! 👋`, { parse_mode: 'HTML', reply_markup: studentMenu() });
      return homeScreen(ctx);
    }
    await store.setState(ctx.from.id, { type: 'reg_name' });
    await store.log(ctx.from.id, 'user.start', { username: ctx.from.username });
    await askName(ctx, s);
  });

  async function askName(ctx, s) {
    s ||= await store.getSettings();
    await store.setState(ctx.from.id, { type: 'reg_name' });
    return show(ctx, `Hello! 👋 Это бот для записи на уроки английского.\nПреподаватель — <b>${esc(s.teacher_name)}</b>.\n\nКак вас зовут? Напишите имя или нажмите кнопку.`,
      new InlineKeyboard().text(`Оставить «${ctx.u.name}»`, 'reg|name'));
  }
  async function askLevel(ctx) {
    await store.setState(ctx.from.id, { type: 'reg_level' });
    const kb = new InlineKeyboard();
    LEVELS.forEach((l, i) => { kb.text(l, `reg|lvl|${l}`); if (i % 3 === 2) kb.row(); });
    kb.row().text('◀️ Назад', 'reg|back_name').text('🏠 В начало', 'reg|back_name');
    return show(ctx, 'Ваш уровень английского?', kb);
  }
  async function askGoal(ctx, level) {
    const kb = new InlineKeyboard();
    GOALS.forEach((g, i) => { kb.text(g, `reg|goal|${i}`); if (i % 2) kb.row(); });
    kb.row().text('◀️ Назад', 'reg|name').text('🏠 В начало', 'reg|back_name');
    return show(ctx, `Уровень: <b>${esc(level)}</b>\n\nКакая главная цель?`, kb);
  }
  bot.callbackQuery('reg|name', async (ctx) => { await ctx.answerCallbackQuery(); await askLevel(ctx); });
  bot.callbackQuery('reg|back_name', async (ctx) => { await ctx.answerCallbackQuery(); await askName(ctx); });
  bot.callbackQuery(/^reg\|lvl\|(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await store.updateUser(ctx.u.id, { level: ctx.match[1] }, ctx.from.id);
    await askGoal(ctx, ctx.match[1]);
  });
  const tzKeyboard = (prefix) => {
    const kb = new InlineKeyboard();
    TIMEZONES.forEach(([, name], i) => { kb.text(name, `${prefix}|${i}`); if (i % 3 === 2) kb.row(); });
    return kb;
  };
  /** Ссылка на сайт в режиме «определить часовой пояс по устройству». */
  const detectUrl = () => (cfg.webAppUrl ? `${cfg.webAppUrl}${cfg.webAppUrl.includes('?') ? '&' : '?'}detect=1` : null);
  async function askTz(ctx) {
    await store.setState(ctx.from.id, { type: 'reg_tz' });
    const kb = new InlineKeyboard();
    const url = detectUrl();
    if (url) kb.webApp('🌍 Определить автоматически', url).row();
    kb.text('Выбрать из списка', 'tzr|list').row().text('◀️ Назад', 'reg|back_goal').text('🏠 В начало', 'reg|back_name');
    const u = await store.getUser(ctx.u.id);
    return show(ctx, `Цель: <b>${esc(u.goal)}</b> ✅\n\n🌍 Последний шаг — часовой пояс, чтобы время уроков показывалось по вашему местному времени.\n\nНажмите «Определить автоматически» — я возьму его с вашего телефона. Или выберите из списка.`, kb);
  }
  bot.callbackQuery(/^reg\|goal\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await store.updateUser(ctx.u.id, { goal: GOALS[Number(ctx.match[1])] }, ctx.from.id);
    await askTz(ctx);
  });
  bot.callbackQuery('reg|back_goal', async (ctx) => { await ctx.answerCallbackQuery(); await askGoal(ctx, ctx.u.level || '—'); });
  bot.callbackQuery('reg|tz', async (ctx) => { await ctx.answerCallbackQuery(); await askTz(ctx); });
  bot.callbackQuery('tzr|list', async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, '🌍 Выберите ваш часовой пояс:', tzKeyboard('tzr').row().text('◀️ Назад', 'reg|tz').text('🏠 В начало', 'reg|back_name'));
  });
  /** Завершение регистрации (вызывается и из бота, и с сайта после автоопределения пояса). */
  async function finishRegistration(tgId, uid) {
    await store.setState(tgId, null);
    const u = await store.updateUser(uid, { registered: 1, deleted: 0 }, tgId);
    await store.log(tgId, 'user.registered', { user_id: u.id, name: u.name, level: u.level, goal: u.goal, tz: u.tz });
    await bot.api.sendMessage(tgId, `🌍 Часовой пояс: <b>${tzLabel(u.tz)}</b> ✅\n\nГотово! Теперь можно записаться на урок 👇\n\n🔔 Я буду напоминать об уроках за сутки, за 2 часа и за 15 минут. Настроить — кнопка «🔔 Уведомления».`,
      { parse_mode: 'HTML', reply_markup: studentMenu() }).catch((e) => console.error('finish reg', e.message));
    await bot.api.sendMessage(tgId, '🏠 <b>Главное меню</b>', {
      parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('📅 Записаться на урок', 'm|book').row().text('🏠 Все разделы', 'home'),
    }).catch(() => {});
    await N.toAdmins(`🆕 Новый ученик: ${who(u)}\nУровень: ${esc(u.level)} · Цель: ${esc(u.goal)}\n🌍 ${tzLabel(u.tz)}`,
      { reply_markup: new InlineKeyboard().text('Открыть карточку', `stu|${u.id}`) });
    return u;
  }
  bot.callbackQuery(/^tzr\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const tz = TIMEZONES[Number(ctx.match[1])]?.[0];
    if (!tz) return;
    await store.updateUser(ctx.u.id, { tz, tz_auto: 0 }, ctx.from.id);
    await ctx.deleteMessage().catch(() => {});
    await finishRegistration(ctx.from.id, ctx.u.id);
  });

  // ---------- выбор даты/времени ----------
  // mode: bk — ученик записывается; ab — админ записывает ученика (arg = user.id); rs — перенос (arg = booking.id)
  const backOfDays = (ctx, mode, arg) => (mode === 'ab' ? `stu|${arg}` : mode === 'rs' ? (isAdmin(ctx.from.id) ? `adl|${arg}` : `les|${arg}`) : 'home');
  /** Дни и слоты показываются в часовом поясе того, кто смотрит (ученик — свой, преподаватель — свой). */
  async function showDays(ctx, mode, arg, offset = 0) {
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
      kb.text(`${short(d)} · ${free}`, `d|${mode}|${arg}|${d}`);
      if (++shown % 2 === 0) kb.row();
    }
    if (shown % 2) kb.row();
    if (offset > 0) kb.text('⬅️ Раньше', `dl|${mode}|${arg}|${Math.max(0, offset - 8)}`);
    if (i <= span) kb.text('Дальше ➡️', `dl|${mode}|${arg}|${i}`);
    const title = mode === 'rs' ? '🔁 <b>Перенос урока</b>\n' : mode === 'ab' ? '➕ <b>Записать ученика</b>\n' : '📅 <b>Запись на урок</b>\n';
    const tzNote = tz !== store.cfg.tz ? `\n🌍 Время — по вашему поясу: ${tzLabel(tz)}` : '';
    const text = shown ? `${title}Выберите день (цифра — сколько свободных окон):${tzNote}` : `${title}Свободных окон пока нет 😔 Напишите преподавателю — постараемся найти время.`;
    return show(ctx, text, nav(kb, backOfDays(ctx, mode, arg)));
  }
  screens.book = (ctx) => showDays(ctx, 'bk', 0);
  bot.callbackQuery(/^dl\|(\w+)\|(\d+)\|(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showDays(ctx, ctx.match[1], ctx.match[2], Number(ctx.match[3])); });
  bot.callbackQuery(/^d\|(\w+)\|(\d+)\|([\d-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, mode, arg, date] = ctx.match; // date — дата в поясе зрителя
    const tz = store.tzOf(ctx.u);
    const byDay = await store.freeByViewerDate(tz, addDays(date, -1), addDays(date, 1));
    const slots = byDay[date] || [];
    const kb = new InlineKeyboard();
    // в кнопке — время зрителя, в данных — время преподавателя (так хранится в базе)
    slots.forEach((sl, i) => { kb.text(sl.vtime, `t|${mode}|${arg}|${sl.date}|${hm(sl.start)}`); if (i % 4 === 3) kb.row(); });
    await show(ctx, slots.length ? `<b>${fmtDate(date)}</b> — выберите время${tz !== store.cfg.tz ? ` (${tzShort(tz)})` : ''}:` : 'На этот день окон уже нет.',
      nav(kb, `dl|${mode}|${arg}|0`));
  });
  bot.callbackQuery(/^t\|(\w+)\|(\d+)\|([\d-]+)\|(\d{4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, mode, arg, date, t] = ctx.match;
    const start = unhm(t);
    const backToDay = `d|${mode}|${arg}|${store.toTz(date, start, store.tzOf(ctx.u)).date}`;
    try {
      if (mode === 'bk') {
        const s = await store.getSettings();
        return show(ctx, `Записаться на <b>${N.when(ctx.u, date, start)}</b>?\nДлительность: ${s.lesson_duration} мин · ${money(store.priceOf(ctx.u, s), s)}`,
          nav(new InlineKeyboard().text('✅ Записаться', `ok|${date}|${t}`), backToDay));
      }
      if (mode === 'ab') {
        if (!isAdmin(ctx.from.id)) return;
        const b = await store.createBooking({ userId: Number(arg), date, start, actorTgId: ctx.from.id, force: true });
        await show(ctx, `✅ Урок добавлен: ${esc(b.name)}, ${fmtDate(date)} ${start}`,
          nav(new InlineKeyboard().text('📖 Открыть урок', `adl|${b.id}`), `stu|${arg}`));
        return N.toUser(b, `📌 Преподаватель записал вас на урок: <b>${N.when(b, date, start)}</b>`);
      }
      if (mode === 'rs') {
        const old = await store.getBooking(Number(arg));
        if (!old || (old.tg_id !== ctx.from.id && !isAdmin(ctx.from.id))) return;
        const b = await store.rescheduleBooking(old.id, date, start, ctx.from.id);
        const lineFor = (u) => `${N.when(u, old.date, old.start)} → <b>${N.when(u, date, start)}</b>`;
        const student = await store.getUser(b.user_id);
        await show(ctx, `🔁 Урок перенесён: ${lineFor(ctx.u)}`, nav(new InlineKeyboard(), isAdmin(ctx.from.id) ? `adl|${b.id}` : 'm|my'));
        if (isAdmin(ctx.from.id)) await N.toUser(student, `🔁 Преподаватель перенёс урок: ${lineFor(student)}`);
        else await N.toAdmins(`🔁 ${who(b)} перенёс урок: ${fmtDate(old.date)} ${old.start} → <b>${fmtDate(date)} ${start}</b>`);
      }
    } catch (e) {
      await show(ctx, `⚠️ ${esc(e.message)}`, nav(new InlineKeyboard().text('Выбрать другое время', `dl|${mode}|${arg}|0`), backToDay));
    }
  });
  bot.callbackQuery(/^ok\|([\d-]+)\|(\d{4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.u.registered) return ctx.reply('Сначала пройдите регистрацию: /start');
    try {
      const b = await store.createBooking({ userId: ctx.u.id, date: ctx.match[1], start: unhm(ctx.match[2]) });
      await show(ctx,
        `${b.status === 'confirmed' ? '✅ Вы записаны' : '⏳ Заявка отправлена'}: <b>${N.when(ctx.u, b.date, b.start)}</b>` +
        (b.status === 'pending' ? '\nПреподаватель подтвердит её в ближайшее время.' : ''),
        nav(new InlineKeyboard().text('📋 Мои уроки', 'm|my').text('📅 Ещё урок', 'm|book'), `d|bk|0|${store.toTz(b.date, b.start, store.tzOf(ctx.u)).date}`));
      const kb = new InlineKeyboard();
      if (b.status === 'pending') kb.text('✅ Подтвердить', `adm|confirm|${b.id}`).text('❌ Отклонить', `adm|reject|${b.id}`);
      const vtz = store.tzOf(ctx.u);
      const local = vtz !== store.cfg.tz ? `\n🌍 У ученика: ${N.when(ctx.u, b.date, b.start, { tz: 'always' })}` : '';
      await N.toAdmins(`${b.status === 'pending' ? '📥 Новая заявка' : '📌 Новая запись'}: ${who(ctx.u)}\n<b>${fmtDate(b.date)}, ${b.start}–${b.end}</b>${local}\nБаланс ученика: ${lessons(ctx.u.balance)}`, { reply_markup: kb });
    } catch (e) {
      await show(ctx, `⚠️ ${esc(e.message)}`, nav(new InlineKeyboard().text('Выбрать другое время', 'dl|bk|0|0')));
    }
  });

  // ---------- разделы ученика ----------
  bot.command('book', (ctx) => screens.book(ctx));

  screens.my = async (ctx) => {
    const list = await store.userBookings(ctx.u.id);
    const kb = new InlineKeyboard();
    list.forEach((b) => kb.text(`${N.when(ctx.u, b.date, b.start, { tz: false })}${b.status === 'pending' ? ' ⏳' : ''}`, `les|${b.id}`).row());
    kb.text('📅 Записаться', 'm|book');
    return show(ctx, list.length ? '📋 <b>Мои уроки</b>\nНажмите на урок, чтобы перенести или отменить его. ⏳ — ждёт подтверждения.' : '📋 У вас нет запланированных уроков.', nav(kb));
  };
  bot.callbackQuery(/^les\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const b = await store.getBooking(Number(ctx.match[1]));
    if (!b || b.tg_id !== ctx.from.id) return screens.my(ctx);
    const kb = new InlineKeyboard();
    if (['pending', 'confirmed'].includes(b.status)) kb.text('🔁 Перенести', `rsq|${b.id}`).text('❌ Отменить', `cnq|${b.id}`);
    await show(ctx, `📖 <b>Урок ${N.when(ctx.u, b.date, b.start)}</b>\n${STATUS[b.status]}${b.topic ? `\nТема: ${esc(b.topic)}` : ''}`, nav(kb, 'm|my'));
  });
  bot.callbackQuery(/^rsq\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const b = await store.getBooking(Number(ctx.match[1]));
    if (!b || (b.tg_id !== ctx.from.id && !isAdmin(ctx.from.id))) return;
    const s = await store.getSettings();
    if (!isAdmin(ctx.from.id) && store.T.minutesUntil(b.date, b.start) < Number(s.cancel_hours) * 60) {
      return show(ctx, `Перенос возможен не позднее чем за ${s.cancel_hours} ч. Напишите преподавателю напрямую.`, nav(new InlineKeyboard(), `les|${b.id}`));
    }
    await showDays(ctx, 'rs', b.id);
  });
  bot.callbackQuery(/^cnq\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const b = await store.getBooking(Number(ctx.match[1]));
    if (!b || b.tg_id !== ctx.from.id) return;
    const s = await store.getSettings();
    const late = b.status === 'confirmed' && store.T.minutesUntil(b.date, b.start) < Number(s.cancel_hours) * 60;
    await show(ctx, `Отменить урок ${N.when(ctx.u, b.date, b.start)}?` + (late ? `\n\n⚠️ До урока меньше ${s.cancel_hours} ч — урок будет списан с баланса.` : ''),
      nav(new InlineKeyboard().text('Да, отменить', `cn|${b.id}`), `les|${b.id}`));
  });
  bot.callbackQuery(/^cn\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const { booking: b, late } = await store.cancelByStudent(Number(ctx.match[1]), ctx.from.id);
      await show(ctx, `❌ Урок ${N.when(ctx.u, b.date, b.start)} отменён${late ? ' (поздняя отмена, урок списан)' : ''}.`, nav(new InlineKeyboard(), 'm|my'));
      await N.toAdmins(`❌ ${who(b)} отменил урок ${fmtDate(b.date)}, ${b.start}${late ? ' — <b>поздняя отмена</b>' : ''}`);
    } catch (e) { await show(ctx, `⚠️ ${esc(e.message)}`, nav(new InlineKeyboard(), 'm|my')); }
  });
  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery('Ок').then(() => ctx.deleteMessage().catch(() => {})));

  // баланс, реквизиты, чек
  screens.bal = async (ctx) => {
    const u = await store.getUser(ctx.u.id);
    const s = await store.getSettings();
    const pays = (await store.userPayments(u.id)).slice(0, 5);
    return show(ctx,
      `💳 Оплаченных уроков: <b>${u.balance}</b>${u.balance < 0 ? ' (задолженность)' : ''}\nСтоимость урока: <b>${money(store.priceOf(u, s), s)}</b>\n\n` +
      `<b>Реквизиты для оплаты:</b>\n${esc(s.payment_details)}\n\n` +
      (pays.length ? `Последние оплаты:\n${pays.map((p) => `• ${p.created_at.slice(0, 10)} — ${money(p.amount, s)} (+${lessons(p.lessons)})`).join('\n')}` : 'Оплат пока не было.'),
      nav(new InlineKeyboard().text('📎 Отправить чек об оплате', 'rcpt')));
  };
  bot.callbackQuery('rcpt', async (ctx) => {
    await ctx.answerCallbackQuery();
    await store.setState(ctx.from.id, { type: 'receipt' });
    await show(ctx, '📎 Пришлите скриншот или файл чека об оплате одним сообщением.\nМожно добавить подпись — например, сумму.', nav(new InlineKeyboard(), 'm|bal'));
  });
  bot.command('receipt', async (ctx) => {
    await store.setState(ctx.from.id, { type: 'receipt' });
    await ctx.reply('📎 Пришлите скриншот или файл чека об оплате.', { reply_markup: nav(new InlineKeyboard(), 'm|bal') });
  });
  bot.on(['message:photo', 'message:document'], async (ctx) => {
    const st = await store.getState(ctx.from.id);
    if (st?.type !== 'receipt') {
      if (isAdmin(ctx.from.id)) return;
      return ctx.reply('Если это чек об оплате — нажмите кнопку ниже и пришлите его ещё раз 👇', { reply_markup: nav(new InlineKeyboard().text('📎 Отправить чек об оплате', 'rcpt')) });
    }
    const photo = ctx.message.photo?.at(-1);
    const doc = ctx.message.document;
    if (doc && doc.file_size > 10 * 1024 * 1024) return ctx.reply('Файл слишком большой (максимум 10 МБ).', { reply_markup: nav(new InlineKeyboard(), 'm|bal') });
    await store.setState(ctx.from.id, null);
    const r = await store.addReceipt(ctx.u.id, photo ? photo.file_id : doc.file_id, photo ? 'photo' : 'document', ctx.message.caption?.slice(0, 300), ctx.from.id);
    await ctx.reply('✅ Чек получен и отправлен преподавателю. Как только оплата будет подтверждена, баланс обновится — я пришлю уведомление.', { reply_markup: nav(new InlineKeyboard(), 'm|bal') });
    await N.receiptToAdmins(r);
  });

  // уведомления — индивидуальные переключатели + часовой пояс
  const notifyKb = (u) => {
    const kb = new InlineKeyboard();
    for (const [key, title] of NOTIFY_TYPES) kb.text(`${u[key] ? '✅' : '🔕'} ${title}`, `nt|${key}`).row();
    kb.text(`🌍 Часовой пояс: ${tzLabel(u.tz || 'Europe/Moscow')}${u.tz_auto ? ' · авто' : ''}`, 'tzm|list');
    return nav(kb);
  };
  const notifyText = () => '🔔 <b>Уведомления</b>\n\nНажмите, чтобы включить или выключить:\n' +
    NOTIFY_TYPES.map(([, t, d]) => `• <b>${t}</b> — ${d}`).join('\n') +
    '\n\nНапоминания об оплате и сообщения от преподавателя приходят всегда.';
  screens.notif = async (ctx) => show(ctx, notifyText(), notifyKb(await store.getUser(ctx.u.id)));
  bot.callbackQuery(/^nt\|(n_\w+)$/, async (ctx) => {
    const key = ctx.match[1];
    if (!NOTIFY_TYPES.some(([k]) => k === key)) return ctx.answerCallbackQuery();
    const u = await store.updateUser(ctx.u.id, { [key]: ctx.u[key] ? 0 : 1 }, ctx.from.id);
    await ctx.answerCallbackQuery(u[key] ? 'Включено' : 'Выключено');
    await ctx.editMessageReplyMarkup({ reply_markup: notifyKb(u) }).catch(() => {});
  });
  bot.callbackQuery('tzm|list', async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = tzKeyboard('tzm');
    const url = detectUrl();
    if (url) kb.row().webApp('🌍 Определить автоматически', url);
    await show(ctx, `🌍 Сейчас: <b>${tzLabel(ctx.u.tz)}</b>${ctx.u.tz_auto ? ' (определяется автоматически)' : ''}\n\nВыберите ваш часовой пояс — время уроков будет показываться по нему:`, nav(kb, 'm|notif'));
  });
  bot.callbackQuery(/^tzm\|(\d+)$/, async (ctx) => {
    const tz = TIMEZONES[Number(ctx.match[1])]?.[0];
    if (!tz) return ctx.answerCallbackQuery();
    await store.updateUser(ctx.u.id, { tz, tz_auto: 0 }, ctx.from.id);
    await ctx.answerCallbackQuery('Сохранено');
    await show(ctx, `🌍 Часовой пояс: <b>${tzLabel(tz)}</b> ✅\nТеперь время уроков показывается по нему.`, nav(new InlineKeyboard(), 'm|notif'));
  });

  screens.hw = async (ctx) => {
    const hw = (await store.userBookings(ctx.u.id, { upcoming: false })).filter((b) => b.homework).slice(0, 5);
    return show(ctx, hw.length
      ? hw.map((b) => `📚 <b>${N.whenDate(ctx.u, b.date, b.start)}</b>${b.topic ? ` · ${esc(b.topic)}` : ''}\n${esc(b.homework)}`).join('\n\n')
      : '📚 Домашних заданий пока нет 🎉', nav());
  };
  screens.rules = async (ctx) => {
    const s = await store.getSettings();
    return show(ctx, `ℹ️ <b>Правила</b>\n\n${esc(s.rules)}\n\nУрок: ${s.lesson_duration} мин · ${money(store.priceOf(ctx.u, s), s)}`, nav());
  };

  // ---------- админка ----------
  const admin = bot.filter((ctx) => isAdmin(ctx.from?.id));

  function lessonCard(b, back = 'm|today') {
    const kb = new InlineKeyboard();
    if (b.status === 'pending') kb.text('✅ Подтвердить', `adm|confirm|${b.id}`).text('❌ Отклонить', `adm|reject|${b.id}`).row();
    if (['pending', 'confirmed'].includes(b.status)) {
      kb.text('🎓 Проведён', `adm|done|${b.id}`).text('🙈 Неявка', `adm|noshow|${b.id}`).row()
        .text('🔁 Перенести', `rsq|${b.id}`).text('🗑 Отменить', `adm|cancel|${b.id}`).row();
    }
    kb.text('📚 Домашка', `adm|hw|${b.id}`).text('👤 Ученик', `stu|${b.user_id}`);
    return {
      text: `📖 <b>${short(b.date)}, ${b.start}–${b.end}</b> · ${who(b)}${b.manual && !b.tg_id ? ' 📒' : ''}\n${STATUS[b.status]}` +
        `${b.topic ? `\nТема: ${esc(b.topic)}` : ''}${b.homework ? `\nДЗ: ${esc(b.homework)}` : ''}`,
      kb: nav(kb, back),
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
  admin.callbackQuery(/^adl\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const b = await store.getBooking(Number(ctx.match[1]));
    if (!b) return screens.today(ctx);
    const c = lessonCard(b);
    await show(ctx, c.text, c.kb);
  });

  screens.today = async (ctx) => {
    if (!isAdmin(ctx.from.id)) return homeScreen(ctx);
    const today = store.T.now().date;
    const list = (await store.bookingsBetween(today, today)).filter((b) => !['cancelled', 'rejected'].includes(b.status));
    const kb = new InlineKeyboard();
    list.forEach((b) => kb.text(`${b.start} · ${b.name}${b.status === 'pending' ? ' ⏳' : b.status === 'done' ? ' 🎓' : ''}`, `adl|${b.id}`).row());
    return show(ctx, list.length ? `📆 <b>${fmtDate(today)}</b> — уроков: ${list.length}\nНажмите на урок, чтобы отметить его.` : `📆 ${fmtDate(today)} — уроков нет. Отдыхайте ☕️`, nav(kb));
  };
  screens.week = async (ctx) => {
    if (!isAdmin(ctx.from.id)) return homeScreen(ctx);
    const today = store.T.now().date;
    const to = addDays(today, 6);
    const cal = await store.calendarRange(today, to);
    const list = (await store.bookingsBetween(today, to)).filter((b) => ['pending', 'confirmed', 'done'].includes(b.status));
    const bar = (l) => '▓'.repeat(Math.round(l * 10)) + '░'.repeat(10 - Math.round(l * 10));
    const lines = cal.map((d) => {
      const head = `<b>${short(d.date)}</b> ${d.off ? '— выходной' : `${bar(d.load)} ${d.lessons}/${d.capacity}`}`;
      return [head, ...list.filter((b) => b.date === d.date).map((b) => `   ${b.start} ${esc(b.name)}${b.status === 'pending' ? ' ⏳' : ''}`)].join('\n');
    });
    return show(ctx, `🗓 <b>Неделя</b>\n\n${lines.join('\n')}`, nav(new InlineKeyboard().text('📆 Сегодня', 'm|today')));
  };
  screens.pending = async (ctx) => {
    if (!isAdmin(ctx.from.id)) return homeScreen(ctx);
    const list = await store.pendingBookings();
    const kb = new InlineKeyboard();
    list.forEach((b) => kb.text(`✅ ${b.name}, ${short(b.date)} ${b.start}`, `pq|confirm|${b.id}`).text('❌', `pq|reject|${b.id}`).row());
    return show(ctx, list.length ? `⏳ <b>Заявки: ${list.length}</b>\n✅ — подтвердить, ❌ — отклонить.` : '⏳ Новых заявок нет ✨', nav(kb));
  };
  admin.callbackQuery(/^pq\|(confirm|reject)\|(\d+)$/, async (ctx) => {
    try {
      const b = await applyStatus(Number(ctx.match[2]), ctx.match[1] === 'confirm' ? 'confirmed' : 'rejected', ctx.from.id, 'bot');
      await ctx.answerCallbackQuery(STATUS[b.status]);
    } catch (e) { await ctx.answerCallbackQuery(e.message); }
    await screens.pending(ctx);
  });

  /** Чек — отдельным сообщением с фото (его нельзя «обновить» как текст). */
  async function sendReceipt(chatId, r) {
    const s = await store.getSettings();
    const caption = `🧾 <b>Чек об оплате</b> от ${who(r)}\nЦена урока: ${money(store.priceOf(r, s), s)} · Баланс сейчас: ${lessons(r.balance)}` + (r.caption ? `\nКомментарий: ${esc(r.caption)}` : '');
    const kb = nav(new InlineKeyboard().text('✅ Зачислить', `rc|ok|${r.id}`).text('❌ Отклонить', `rc|no|${r.id}`), 'm|rcpts');
    const opts = { caption, parse_mode: 'HTML', reply_markup: kb };
    return r.file_type === 'photo' ? bot.api.sendPhoto(chatId, r.file_id, opts) : bot.api.sendDocument(chatId, r.file_id, opts);
  }
  screens.rcpts = async (ctx) => {
    if (!isAdmin(ctx.from.id)) return homeScreen(ctx);
    const list = await store.pendingReceipts();
    if (!list.length) return show(ctx, '🧾 Неподтверждённых чеков нет ✨', nav());
    await show(ctx, `🧾 <b>Чеки на проверке: ${list.length}</b>\nОни ниже отдельными сообщениями.`, nav());
    for (const r of list) await sendReceipt(ctx.chat.id, r).catch((e) => console.error('receipt', e.message));
  };

  admin.callbackQuery(/^adm\|(\w+)\|(\d+)$/, async (ctx) => {
    const [, action, idStr] = ctx.match;
    const id = Number(idStr);
    const map = { confirm: 'confirmed', reject: 'rejected', done: 'done', noshow: 'no_show', cancel: 'cancelled' };
    if (action === 'hw') {
      await ctx.answerCallbackQuery();
      await store.setState(ctx.from.id, { type: 'hw', bookingId: id });
      return show(ctx, '📚 Напишите тему урока и домашнее задание.\nФормат: первая строка — тема, дальше — ДЗ.', nav(new InlineKeyboard(), `adl|${id}`));
    }
    if (!map[action]) return ctx.answerCallbackQuery();
    try {
      const b = await applyStatus(id, map[action], ctx.from.id, 'bot');
      await ctx.answerCallbackQuery(STATUS[b.status]);
      const c = lessonCard(b);
      await show(ctx, c.text, c.kb);
      if (b.status === 'done') {
        await store.setState(ctx.from.id, { type: 'hw', bookingId: id });
        await ctx.reply('🎓 Отмечено. Ученику отправлено уведомление с балансом.\nНапишите тему и ДЗ (первая строка — тема) — или вернитесь назад.', { reply_markup: nav(new InlineKeyboard(), `adl|${id}`) });
      }
    } catch (e) { await ctx.answerCallbackQuery(e.message); }
  });

  // чеки: зачислить / отклонить
  admin.callbackQuery(/^rc\|ok\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const r = await store.getReceipt(Number(ctx.match[1]));
    if (!r || r.status !== 'pending') return ctx.reply('Этот чек уже обработан.', { reply_markup: nav(new InlineKeyboard(), 'm|rcpts') });
    const s = await store.getSettings();
    const price = store.priceOf(r, s);
    const kb = new InlineKeyboard();
    [1, 4, 8].forEach((n) => kb.text(`+${lessons(n)} (${money(n * price, s)})`, `rc|n|${r.id}|${n}`).row());
    kb.text('Другое количество', `rc|custom|${r.id}`);
    await ctx.reply(`Сколько уроков зачислить ученику ${who(r)}?`, { parse_mode: 'HTML', reply_markup: nav(kb, 'm|rcpts') });
  });
  admin.callbackQuery(/^rc\|n\|(\d+)\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const { user, amount } = await store.acceptReceipt(Number(ctx.match[1]), Number(ctx.match[2]), null, ctx.from.id);
      const s = await store.getSettings();
      await show(ctx, `✅ Зачислено: ${who(user)} +${lessons(Number(ctx.match[2]))} (${money(amount, s)}). Баланс: ${lessons(user.balance)}.`, nav(new InlineKeyboard(), 'm|rcpts'));
      await N.toUser(user, `✅ <b>Оплата подтверждена!</b> +${lessons(Number(ctx.match[2]))}.\n💳 Оплаченных уроков: <b>${user.balance}</b>. Спасибо!`);
    } catch (e) { await show(ctx, `⚠️ ${esc(e.message)}`, nav(new InlineKeyboard(), 'm|rcpts')); }
  });
  admin.callbackQuery(/^rc\|custom\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await store.setState(ctx.from.id, { type: 'rc_custom', receiptId: Number(ctx.match[1]) });
    await show(ctx, 'Введите: <code>количество_уроков [сумма]</code>\nНапример: <code>5</code> или <code>5 7000</code>', nav(new InlineKeyboard(), 'm|rcpts'));
  });
  admin.callbackQuery(/^rc\|no\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const r = await store.rejectReceipt(Number(ctx.match[1]), ctx.from.id);
      await ctx.reply(`❌ Чек от ${who(r)} отклонён.`, { parse_mode: 'HTML', reply_markup: nav(new InlineKeyboard(), 'm|rcpts') });
      await N.toUser(r, '⚠️ Преподаватель не смог подтвердить оплату по этому чеку. Пожалуйста, проверьте перевод или свяжитесь с преподавателем.');
    } catch (e) { await ctx.reply(`⚠️ ${esc(e.message)}`, { reply_markup: nav(new InlineKeyboard(), 'm|rcpts') }); }
  });

  // карточка ученика
  async function studentCard(ctx, uid) {
    const u = await store.getUser(uid);
    if (!u) return show(ctx, 'Ученик не найден', nav(new InlineKeyboard(), 'm|students'));
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
    kb.text(u.blocked ? '✅ Разблокировать' : '🚫 Заблокировать', `stu_blk|${uid}`).text('🗑 Удалить', `stu_del|${uid}`);
    return show(ctx, text, nav(kb, 'm|students'));
  }
  screens.students = async (ctx) => {
    if (!isAdmin(ctx.from.id)) return homeScreen(ctx);
    const list = await store.listStudents();
    const kb = new InlineKeyboard();
    list.forEach((u, i) => { kb.text(`${u.tg_id ? '' : '📒 '}${u.name} · ${u.balance}`, `stu|${u.id}`); if (i % 2) kb.row(); });
    return show(ctx, list.length ? `👥 <b>Учеников: ${list.length}</b> (цифра — баланс уроков, 📒 — без Telegram)`
      : `👥 Учеников пока нет. Поделитесь ссылкой: https://t.me/${ctx.me.username}\nИли добавьте ученика вручную на сайте (👥 Ученики → ＋).`, nav(kb));
  };
  admin.callbackQuery(/^stu\|(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await clearTransient(ctx); await studentCard(ctx, Number(ctx.match[1])); });
  admin.callbackQuery(/^stu_blk\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await store.getUser(Number(ctx.match[1]));
    await store.updateUser(u.id, { blocked: u.blocked ? 0 : 1 }, ctx.from.id);
    await studentCard(ctx, u.id);
  });
  admin.callbackQuery(/^stu_del\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await store.getUser(Number(ctx.match[1]));
    const future = await store.userBookings(u.id);
    await show(ctx, `🗑 Удалить ученика <b>${esc(u.name)}</b>?\n\nОн пропадёт из списков${future.length ? `, ${lessons(future.length)} в будущем будут отменены` : ''}. Проведённые уроки и оплаты останутся в статистике.`,
      nav(new InlineKeyboard().text('Да, удалить', `stu_delok|${u.id}`), `stu|${u.id}`));
  });
  admin.callbackQuery(/^stu_delok\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const { user, cancelled } = await store.deleteStudent(Number(ctx.match[1]), ctx.from.id);
      if (user.tg_id && cancelled.length) await N.toUser(user, `❌ Запланированные уроки отменены преподавателем:\n${cancelled.map((b) => '• ' + N.when(user, b.date, b.start)).join('\n')}`);
      await show(ctx, `🗑 Ученик <b>${esc(user.name)}</b> удалён.${cancelled.length ? ` Отменено уроков: ${cancelled.length}.` : ''}`, nav(new InlineKeyboard(), 'm|students'));
    } catch (e) { await show(ctx, `⚠️ ${esc(e.message)}`, nav(new InlineKeyboard(), 'm|students')); }
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
    await show(ctx, `🔗 Ссылка-приглашение (по желанию — можно не отправлять):\nhttps://t.me/${ctx.me.username}?start=link_${code}\n\nЕсли ученик откроет её, его Telegram привяжется к этой карточке вместе с историей и балансом.`,
      nav(new InlineKeyboard(), `stu|${ctx.match[1]}`));
  });
  for (const [key, prompt] of [
    ['pay', 'Введите оплату: <code>сумма количество_уроков [комментарий]</code>\nНапример: <code>6000 4 пакет ноябрь</code>'],
    ['note', 'Напишите заметку об ученике (заменит текущую):'],
    ['msg', 'Напишите сообщение — я перешлю его ученику:'],
  ]) {
    admin.callbackQuery(new RegExp(`^stu_${key}\\|(\\d+)$`), async (ctx) => {
      await ctx.answerCallbackQuery();
      await store.setState(ctx.from.id, { type: `stu_${key}`, uid: Number(ctx.match[1]) });
      await show(ctx, prompt, nav(new InlineKeyboard(), `stu|${ctx.match[1]}`));
    });
  }

  screens.stats = async (ctx) => {
    if (!isAdmin(ctx.from.id)) return homeScreen(ctx);
    const s = await store.getSettings();
    const today = store.T.now().date;
    const st = await store.stats(today.slice(0, 8) + '01', today);
    const wd = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    return show(ctx,
      `📊 <b>${fmtDate(today, { month: 'long', year: 'numeric' })}</b> (за любой период — на сайте)\n` +
      `🎓 Проведено: ${st.done} · на сумму ${money(st.earned, s)}\n⏳ Впереди: ${st.upcoming}\n` +
      `❌ Отмены: ученик ${st.cancelled_student} · преподаватель ${st.cancelled_teacher} · 🚫 отклонено ${st.rejected} · 🙈 неявки ${st.no_show}\n` +
      `💰 Оплачено: ${money(st.income, s)}\n👥 Учеников: ${st.students} · без оплаченных уроков: ${st.debtors}\n` +
      `📈 Загрузка: ${Math.round(st.load * 100)}%\n\nПо дням недели: ${st.byWeekday.map((c, i) => `${wd[i]} ${c}`).join(' · ')}`,
      nav());
  };
  screens.bc = async (ctx) => {
    if (!isAdmin(ctx.from.id)) return homeScreen(ctx);
    await store.setState(ctx.from.id, { type: 'broadcast' });
    return show(ctx, '📢 Напишите текст рассылки для всех учеников.', nav());
  };
  admin.callbackQuery('bc|send', async (ctx) => {
    await ctx.answerCallbackQuery();
    const st = await store.getState(ctx.from.id);
    if (st?.type !== 'broadcast_confirm') return;
    await store.setState(ctx.from.id, null);
    let ok = 0;
    for (const u of (await store.listStudents()).filter((x) => !x.blocked && x.tg_id)) {
      try { await bot.api.sendMessage(u.tg_id, `📢 ${st.text}`, { reply_markup: new InlineKeyboard().text('🏠 Меню', 'homen') }); ok++; } catch {}
    }
    await store.log(ctx.from.id, 'broadcast', { text: st.text, delivered: ok });
    await show(ctx, `📢 Рассылка отправлена: ${ok} получателей.`, nav());
  });
  screens.exp = async (ctx) => {
    if (!isAdmin(ctx.from.id)) return homeScreen(ctx);
    return show(ctx, '📤 Что выгрузить в CSV (открывается в Excel)?',
      nav(new InlineKeyboard().text('Уроки', 'exp|bookings').text('Ученики', 'exp|students').row().text('Оплаты', 'exp|payments').text('Журнал', 'exp|logs')));
  };
  admin.callbackQuery(/^exp\|(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const csv = await store.exportCsv(ctx.match[1]);
    if (!csv) return ctx.reply('Пока нет данных.', { reply_markup: nav(new InlineKeyboard(), 'm|exp') });
    await store.log(ctx.from.id, 'export', { kind: ctx.match[1] });
    await ctx.replyWithDocument(new InputFile(new TextEncoder().encode(csv), `${ctx.match[1]}_${store.T.now().date}.csv`), { reply_markup: nav(new InlineKeyboard(), 'm|exp') });
  });

  // текстовые кнопки нижней клавиатуры → те же экраны
  for (const [key, label] of [...studentSections, ...adminSections]) {
    bot.hears(label, async (ctx) => { await clearTransient(ctx); await screens[key](ctx); });
  }
  bot.hears('💳 Баланс', (ctx) => screens.bal(ctx));

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
    await homeScreen(ctx);
  });

  bot.command('cancel', async (ctx) => {
    await clearTransient(ctx);
    await ctx.reply('Ок, отменено.', { reply_markup: menuFor(ctx.from.id) });
    if (isAdmin(ctx.from.id) || ctx.u.registered) await homeScreen(ctx);
  });
  bot.command('id', (ctx) => ctx.reply(`Ваш Telegram ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' }));

  // ---------- текстовые ответы в состояниях ----------
  bot.on('message:text', async (ctx) => {
    const st = await store.getState(ctx.from.id);
    const text = ctx.message.text.trim();
    if (!st?.type) return ctx.reply('Не понял 🙂 Выберите раздел:', { reply_markup: nav(new InlineKeyboard(), null) });

    if (st.type === 'reg_name') {
      await store.updateUser(ctx.u.id, { name: text.slice(0, 60) }, ctx.from.id);
      return askLevel(ctx);
    }
    if (st.type === 'receipt') return ctx.reply('Пришлите, пожалуйста, именно скриншот или файл чека 📎', { reply_markup: nav(new InlineKeyboard(), 'm|bal') });
    if (!isAdmin(ctx.from.id)) return;
    await store.setState(ctx.from.id, null);

    if (st.type === 'hw') {
      const [topic, ...rest] = text.split('\n');
      const b = await store.updateBookingNotes(st.bookingId, { topic, homework: rest.join('\n').trim() || topic }, ctx.from.id);
      await ctx.reply(b.tg_id ? '📚 Сохранено и отправлено ученику.' : '📚 Сохранено.', { reply_markup: nav(new InlineKeyboard(), `adl|${b.id}`) });
      return N.homework(b);
    }
    if (st.type === 'rc_custom') {
      const m = text.match(/^(\d+)(?:\s+(\d+))?$/);
      if (!m) { await store.setState(ctx.from.id, st); return ctx.reply('Формат: <code>5</code> или <code>5 7000</code>', { parse_mode: 'HTML', reply_markup: nav(new InlineKeyboard(), 'm|rcpts') }); }
      try {
        const { user, amount } = await store.acceptReceipt(st.receiptId, Number(m[1]), m[2] ?? null, ctx.from.id);
        const s = await store.getSettings();
        await ctx.reply(`✅ Зачислено: ${who(user)} +${lessons(Number(m[1]))} (${money(amount, s)}). Баланс: ${lessons(user.balance)}.`, { parse_mode: 'HTML', reply_markup: nav(new InlineKeyboard(), 'm|rcpts') });
        return N.toUser(user, `✅ <b>Оплата подтверждена!</b> +${lessons(Number(m[1]))}.\n💳 Оплаченных уроков: <b>${user.balance}</b>. Спасибо!`);
      } catch (e) { return ctx.reply(`⚠️ ${esc(e.message)}`, { reply_markup: nav(new InlineKeyboard(), 'm|rcpts') }); }
    }
    if (st.type === 'stu_pay') {
      const m = text.match(/^(\d+)\s+(-?\d+)\s*(.*)$/);
      if (!m) { await store.setState(ctx.from.id, st); return ctx.reply('Формат: <code>6000 4 комментарий</code>', { parse_mode: 'HTML', reply_markup: nav(new InlineKeyboard(), `stu|${st.uid}`) }); }
      const u = await store.addPayment(st.uid, Number(m[1]), Number(m[2]), m[3], ctx.from.id);
      const s = await store.getSettings();
      await ctx.reply(`💳 Оплата записана. Баланс ${esc(u.name)}: ${lessons(u.balance)}.`, { parse_mode: 'HTML', reply_markup: nav(new InlineKeyboard(), `stu|${st.uid}`) });
      return N.toUser(u, `💳 Оплата получена: ${money(Number(m[1]), s)} (+${lessons(Number(m[2]))}). Оплаченных уроков: <b>${u.balance}</b>. Спасибо!`);
    }
    if (st.type === 'stu_note') { await store.updateUser(st.uid, { notes: text }, ctx.from.id); return studentCard(ctx, st.uid); }
    if (st.type === 'stu_msg') {
      const u = await store.getUser(st.uid);
      await N.toUser(u, `✉️ <b>Сообщение от преподавателя</b>\n\n${esc(text)}`);
      await store.log(ctx.from.id, 'message.sent', { user_id: st.uid, text });
      return ctx.reply('✉️ Отправлено.', { reply_markup: nav(new InlineKeyboard(), `stu|${st.uid}`) });
    }
    if (st.type === 'broadcast') {
      await store.setState(ctx.from.id, { type: 'broadcast_confirm', text });
      return ctx.reply(`Отправить всем ученикам?\n\n${text}`, { reply_markup: nav(new InlineKeyboard().text('📢 Отправить', 'bc|send'), 'm|bc') });
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
      { command: 'menu', description: 'Главное меню' },
      { command: 'book', description: 'Записаться на урок' },
      { command: 'receipt', description: 'Отправить чек об оплате' },
      { command: 'start', description: 'Перезапустить бота' },
    ]);
    if (cfg.webAppUrl) await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Сайт', web_app: { url: cfg.webAppUrl } } });
  }

  return { bot, N, applyStatus, runReminders, setupCommands, finishRegistration };
}
