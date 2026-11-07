// Все сообщения, которые бот отправляет ученикам и преподавателю.
import { InlineKeyboard } from 'grammy';
import { fmtDate, tzShort } from './time.js';

export const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const who = (u) => `${esc(u.name)}${u.username ? ` (@${esc(u.username)})` : ''}`;
const lessonsWord = (n) => {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return 'уроков';
  if (b === 1) return 'урок';
  if (b >= 2 && b <= 4) return 'урока';
  return 'уроков';
};
export const lessons = (n) => `${n} ${lessonsWord(n)}`;
export const money = (n, s) => `${Number(n).toLocaleString('ru-RU')} ${s.currency}`;

export const NOTIFY_TYPES = [
  ['n_24h', 'За сутки до урока', 'напоминание об уроке и о домашнем задании'],
  ['n_2h', 'За 2 часа до урока', 'короткое напоминание'],
  ['n_15m', 'За 15 минут до урока', '«скоро начинаем»'],
  ['n_done', 'После урока', 'урок проведён, остаток оплаченных уроков'],
];

export function createNotifier(api, store) {
  const N = {
    /** Дата и время урока так, как их видит человек: в его часовом поясе. */
    when(u, date, time, { tz = true, opts } = {}) {
      const vtz = store.tzOf(u);
      const v = store.toTz(date, time, vtz);
      return `${fmtDate(v.date, opts)}, ${v.time}${tz && vtz !== store.cfg.tz || tz === 'always' ? ` (${tzShort(vtz)})` : ''}`;
    },
    whenDate(u, date, time) { return fmtDate(store.toTz(date, time, store.tzOf(u)).date); },
    async toUser(u, text, extra = {}) {
      if (!u?.tg_id) return false; // ученик без Telegram — сообщения не отправляются
      try { await api.sendMessage(u.tg_id, text, { parse_mode: 'HTML', ...extra }); return true; } catch (e) { console.error('notify user', e.message); return false; }
    },
    async toAdmins(text, extra = {}) {
      for (const id of store.isAdminList()) {
        await api.sendMessage(id, text, { parse_mode: 'HTML', ...extra }).catch((e) => console.error('notify admin', e.message));
      }
    },

    receiptButton: () => new InlineKeyboard().text('📎 Отправить чек об оплате', 'rcpt'),

    async paymentReminder(u) {
      const s = await store.getSettings();
      const price = store.priceOf(u, s);
      const state = u.balance < 0
        ? `За вами задолженность: <b>${lessons(-u.balance)}</b> (${money(-u.balance * price, s)}).`
        : 'Оплаченные уроки закончились.';
      return N.toUser(u,
        `💳 <b>Пора пополнить баланс</b>\n\n${state}\nЧтобы провести следующее занятие, пожалуйста, пополните баланс.\n\n` +
        `Стоимость урока: <b>${money(price, s)}</b>\n\n<b>Реквизиты для оплаты:</b>\n${esc(s.payment_details)}\n\n` +
        'После перевода нажмите «📎 Отправить чек» и пришлите скриншот — преподаватель подтвердит оплату.',
        { reply_markup: N.receiptButton() });
    },

    async lessonDone(b) {
      const u = await store.getUser(b.user_id);
      if (!u?.tg_id) return;
      if (u.n_done) {
        await N.toUser(u,
          `✅ <b>Урок ${N.whenDate(u, b.date, b.start)} проведён!</b> Спасибо за занятие.\n` +
          '📚 Домашнее задание пришлю в ближайшее время.\n\n' +
          `💳 Оплаченных уроков осталось: <b>${u.balance}</b>`);
      }
      if (u.balance < 1) await N.paymentReminder(u);
    },

    async homework(b) {
      const u = await store.getUser(b.user_id);
      return N.toUser(u, `📚 <b>Домашнее задание</b> (урок ${N.whenDate(u, b.date, b.start)})\n${b.topic ? `Тема: ${esc(b.topic)}\n` : ''}\n${esc(b.homework)}`);
    },

    async reminder(b, kind) {
      const u = await store.getUser(b.user_id);
      if (!u?.tg_id) return;
      const when = `<b>${N.when(u, b.date, b.start)}</b>`;
      if (kind === 'rem24' && u.n_24h) {
        const hw = await store.lastHomework(u.id);
        const vtz = store.tzOf(u);
        const sameDay = store.toTz(b.date, b.start, vtz).date === store.nowIn(vtz).date;
        await N.toUser(u,
          `⏰ <b>${sameDay ? 'Сегодня' : 'Завтра'} урок английского</b> — ${when}\n\n` +
          (hw ? `📚 Не забудьте сделать домашнее задание:\n${esc(hw.homework)}\n\n` : '📚 Не забудьте сделать домашнее задание, если оно было.\n\n') +
          'Если планы изменились — перенести или отменить урок можно в «📋 Мои уроки».');
      }
      if (kind === 'rem2' && u.n_2h) await N.toUser(u, `⏰ Через 2 часа урок английского — ${when}. До встречи!`);
      if (kind === 'rem15' && u.n_15m) await N.toUser(u, `🔔 Урок начинается через 15 минут — ${when}. Подготовьтесь, скоро начинаем!`);
    },

    async receiptToAdmins(r) {
      const s = await store.getSettings();
      const caption = `🧾 <b>Чек об оплате</b> от ${who(r)}\nЦена урока: ${money(store.priceOf(r, s), s)} · Баланс сейчас: ${lessons(r.balance)}` +
        (r.caption ? `\nКомментарий: ${esc(r.caption)}` : '');
      const kb = new InlineKeyboard().text('✅ Зачислить', `rc|ok|${r.id}`).text('❌ Отклонить', `rc|no|${r.id}`);
      for (const id of store.isAdminList()) {
        const opts = { caption, parse_mode: 'HTML', reply_markup: kb };
        const p = r.file_type === 'photo' ? api.sendPhoto(id, r.file_id, opts) : api.sendDocument(id, r.file_id, opts);
        await p.catch((e) => console.error('receipt to admin', e.message));
      }
    },
  };
  return N;
}
