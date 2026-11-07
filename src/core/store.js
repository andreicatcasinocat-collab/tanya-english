// Слой данных. Работает поверх любого SQLite-адаптера:
//   sql.all(query, args) → rows,  sql.first(query, args) → row|null,  sql.run(query, args) → { lastId, changes }
// На Mac — node:sqlite, на Cloudflare — D1.
import { makeTime, toMin, fromMin, addDays, isoWeekday, convert, zonedToUtc, isValidTz } from './time.js';

export const DEFAULT_SETTINGS = {
  teacher_name: 'Таня',
  work_days: '1,2,3,4,5',        // 1 = Пн … 7 = Вс
  work_start: '10:00',
  work_end: '20:00',
  lesson_duration: '60',
  slot_step: '60',
  price: '1500',                  // цена урока по умолчанию
  currency: '₽',
  cancel_hours: '24',
  min_hours_before: '3',
  days_ahead: '21',
  auto_confirm: '0',
  max_active: '4',
  payment_details: 'Перевод по номеру телефона: +7 XXX XXX-XX-XX (Сбербанк, Татьяна Т.)\nВ комментарии укажите ваше имя.',
  rules: 'Отмена или перенос — не позднее чем за 24 часа. Поздняя отмена = урок списывается.',
  admin_ids: '',
};
const ACTIVE = "('pending','confirmed')";
const CHARGED = ['done', 'late_cancel', 'no_show'];

export function createStore(sql, cfg) {
  const T = makeTime(cfg.tz);
  let settingsCache = null;
  let settingsAt = 0;

  const S = {
    T,
    cfg,
    /** Перевод времени преподавателя в пояс зрителя. */
    toTz: (date, time, tz) => convert(date, time, cfg.tz, tz || cfg.tz),
    atUtc: (date, time) => zonedToUtc(date, time, cfg.tz),
    /** Пояс, в котором человек видит время: преподаватель — свой, ученик — свой (по умолчанию Москва). */
    tzOf: (u) => (u && !cfg.adminIds.has(Number(u.tg_id)) ? u.tz || 'Europe/Moscow' : cfg.tz),
    // ---------- settings ----------
    async init() {
      const have = new Set((await sql.all('SELECT key FROM settings')).map((r) => r.key));
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (!have.has(k)) await sql.run('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)', [k, v]);
      }
      await S.loadAdmins(true);
    },
    async getSettings(force = false) {
      if (!force && settingsCache && Date.now() - settingsAt < 5000) return settingsCache;
      const rows = await sql.all('SELECT key, value FROM settings');
      settingsCache = { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
      settingsAt = Date.now();
      return settingsCache;
    },
    async setSetting(key, value, actorId) {
      if (!(key in DEFAULT_SETTINGS) || key === 'admin_ids') throw new Error(`Нельзя изменить ${key}`);
      await sql.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
      settingsCache = null;
      await S.log(actorId, 'settings.update', { key, value });
    },
    async loadAdmins(force = false) {
      const s = await S.getSettings(force);
      for (const id of (s.admin_ids || '').split(',').filter(Boolean)) cfg.adminIds.add(Number(id));
    },
    isAdmin: (tgId) => cfg.adminIds.has(Number(tgId)),
    isAdminList: () => [...cfg.adminIds],
    async addAdmin(tgId) {
      cfg.adminIds.add(Number(tgId));
      const s = await S.getSettings(true);
      const set = new Set((s.admin_ids || '').split(',').filter(Boolean));
      set.add(String(tgId));
      await sql.run("UPDATE settings SET value = ? WHERE key = 'admin_ids'", [[...set].join(',')]);
      settingsCache = null;
      await S.log(tgId, 'security.admin_added', { tg_id: tgId });
    },

    // ---------- logs ----------
    async log(actorTgId, action, details = {}) {
      await sql.run('INSERT INTO logs(actor_id, action, details) VALUES (?, ?, ?)', [actorTgId ?? null, action, JSON.stringify(details)]);
    },
    async getLogs({ limit = 300, userId } = {}) {
      const rows = userId
        ? await sql.all(`SELECT l.*, u.name FROM logs l LEFT JOIN users u ON u.tg_id = l.actor_id
            WHERE json_extract(l.details, '$.user_id') = ? OR l.actor_id = (SELECT tg_id FROM users WHERE id = ?)
            ORDER BY l.id DESC LIMIT ?`, [userId, userId, limit])
        : await sql.all(`SELECT l.*, u.name FROM logs l LEFT JOIN users u ON u.tg_id = l.actor_id ORDER BY l.id DESC LIMIT ?`, [limit]);
      return rows.map((r) => ({ ...r, details: JSON.parse(r.details || '{}') }));
    },

    // ---------- dialog state ----------
    async getState(tgId) {
      const r = await sql.first('SELECT data, updated_at FROM state WHERE tg_id = ?', [tgId]);
      return r ? JSON.parse(r.data) : null;
    },
    async setState(tgId, data) {
      if (!data) return sql.run('DELETE FROM state WHERE tg_id = ?', [tgId]);
      await sql.run(`INSERT INTO state(tg_id, data, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(tg_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, [tgId, JSON.stringify(data)]);
    },

    // ---------- users ----------
    async upsertTgUser({ id, first_name, last_name, username }) {
      const u = await S.userByTg(id);
      if (u) {
        if ((u.username || null) !== (username || null)) {
          await sql.run('UPDATE users SET username = ? WHERE id = ?', [username || null, u.id]);
          u.username = username || null;
        }
        return u;
      }
      await sql.run('INSERT OR IGNORE INTO users(tg_id, name, username) VALUES (?, ?, ?)',
        [id, [first_name, last_name].filter(Boolean).join(' ') || 'Без имени', username || null]);
      return S.userByTg(id);
    },
    userByTg: (tgId) => sql.first('SELECT * FROM users WHERE tg_id = ?', [tgId]),
    getUser: (id) => sql.first('SELECT * FROM users WHERE id = ?', [id]),
    async updateUser(id, fields, actorTgId) {
      const allowed = ['name', 'phone', 'level', 'goal', 'notes', 'blocked', 'registered', 'price', 'n_24h', 'n_2h', 'n_15m', 'n_done', 'tz', 'tz_auto', 'deleted'];
      if ('tz' in fields && !isValidTz(fields.tz)) throw new Error('Неизвестный часовой пояс');
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (!keys.length) return S.getUser(id);
      const vals = keys.map((k) => {
        if (k === 'price') return fields[k] === '' || fields[k] == null ? null : Number(fields[k]);
        if (k.startsWith('n_') || k === 'blocked' || k === 'registered' || k === 'tz_auto' || k === 'deleted') return fields[k] ? 1 : 0;
        return String(fields[k] ?? '').slice(0, 2000);
      });
      await sql.run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...vals, id]);
      await S.log(actorTgId, 'user.update', { user_id: id, ...Object.fromEntries(keys.map((k, i) => [k, vals[i]])) });
      return S.getUser(id);
    },
    /** Ученик без Telegram, добавленный преподавателем. */
    async addManualStudent({ name, phone, level, goal, notes, price }, actorTgId) {
      if (!name?.trim()) throw new Error('Укажите имя');
      const code = randomCode();
      const r = await sql.run(`INSERT INTO users(name, phone, level, goal, notes, price, registered, manual, link_code)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`,
      [name.trim().slice(0, 80), phone || null, level || null, goal || null, notes || '', price ? Number(price) : null, code]);
      await S.log(actorTgId, 'user.manual_add', { user_id: r.lastId, name });
      return S.getUser(r.lastId);
    },
    async ensureLinkCode(id) {
      const u = await S.getUser(id);
      if (u.link_code) return u.link_code;
      const code = randomCode();
      await sql.run('UPDATE users SET link_code = ? WHERE id = ?', [code, id]);
      return code;
    },
    /** Привязка Telegram к карточке, созданной вручную (по ссылке-приглашению). */
    async linkTelegram(code, tgUser) {
      const card = await sql.first('SELECT * FROM users WHERE link_code = ? AND tg_id IS NULL', [code]);
      if (!card) return null;
      const existing = await S.userByTg(tgUser.id);
      if (existing) {
        // Переносим историю «пустой» записи Telegram в карточку и удаляем дубликат
        await sql.run('UPDATE bookings SET user_id = ? WHERE user_id = ?', [card.id, existing.id]);
        await sql.run('UPDATE payments SET user_id = ? WHERE user_id = ?', [card.id, existing.id]);
        await sql.run('UPDATE receipts SET user_id = ? WHERE user_id = ?', [card.id, existing.id]);
        await sql.run('UPDATE users SET balance = balance + ? WHERE id = ?', [existing.balance || 0, card.id]);
        await sql.run('DELETE FROM users WHERE id = ?', [existing.id]);
      }
      await sql.run('UPDATE users SET tg_id = ?, username = ?, link_code = NULL, registered = 1 WHERE id = ?', [tgUser.id, tgUser.username || null, card.id]);
      await S.log(tgUser.id, 'user.linked', { user_id: card.id });
      return S.getUser(card.id);
    },
    async listStudents() {
      const today = T.now().date;
      return sql.all(`
        SELECT u.*,
          (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status = 'done') AS lessons_done,
          (SELECT MIN(b.date || ' ' || b.start) FROM bookings b WHERE b.user_id = u.id
             AND b.status IN ${ACTIVE} AND b.date >= ?) AS next_lesson,
          (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.user_id = u.id) AS paid_total
        FROM users u WHERE u.registered = 1 AND COALESCE(u.deleted, 0) = 0 ORDER BY u.name COLLATE NOCASE`, [today]);
    },
    priceOf: (u, s) => Number(u?.price ?? s.price),
    /** «Удалить» ученика: скрыть из списков и отменить будущие уроки. История уроков и оплат остаётся в статистике. */
    async deleteStudent(id, actorTgId) {
      const u = await S.getUser(id);
      if (!u) throw new Error('Ученик не найден');
      const future = await S.userBookings(id);
      for (const b of future) {
        await sql.run("UPDATE bookings SET status = 'cancelled', cancelled_by = 'teacher', updated_at = datetime('now') WHERE id = ?", [b.id]);
      }
      await sql.run('UPDATE users SET deleted = 1, registered = 0, link_code = NULL WHERE id = ?', [id]);
      await S.log(actorTgId, 'user.deleted', { user_id: id, name: u.name, cancelled_lessons: future.length });
      return { user: u, cancelled: future };
    },

    // ---------- schedule ----------
    async dayWindow(date, s) {
      s ||= await S.getSettings();
      const o = await sql.first('SELECT * FROM day_overrides WHERE date = ?', [date]);
      if (o?.is_off) return null;
      if (o?.start && o?.end) return { start: o.start, end: o.end };
      if (!s.work_days.split(',').map(Number).includes(isoWeekday(date))) return null;
      return { start: s.work_start, end: s.work_end };
    },
    getDayOverride: (date) => sql.first('SELECT * FROM day_overrides WHERE date = ?', [date]),
    blocksOn: (date) => sql.all('SELECT * FROM blocks WHERE date = ? ORDER BY start', [date]),

    /** Слоты по дням за период одним набором запросов (быстро для календаря). */
    async slotsRange(from, to) {
      const s = await S.getSettings();
      const [overrides, bookings, blocks] = await Promise.all([
        sql.all('SELECT * FROM day_overrides WHERE date BETWEEN ? AND ?', [from, to]),
        sql.all(`SELECT date, start, end, status FROM bookings WHERE date BETWEEN ? AND ? AND status IN ('pending','confirmed','done','no_show')`, [from, to]),
        sql.all('SELECT * FROM blocks WHERE date BETWEEN ? AND ?', [from, to]),
      ]);
      const ov = Object.fromEntries(overrides.map((o) => [o.date, o]));
      const days = s.work_days.split(',').map(Number);
      const dur = Number(s.lesson_duration);
      const step = Number(s.slot_step);
      const minAhead = Number(s.min_hours_before) * 60;
      const out = {};
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const o = ov[d];
        let win = null;
        if (!o?.is_off) {
          if (o?.start && o?.end) win = { start: o.start, end: o.end };
          else if (days.includes(isoWeekday(d))) win = { start: s.work_start, end: s.work_end };
        }
        const dayBookings = bookings.filter((b) => b.date === d);
        const busy = [...dayBookings.filter((b) => b.status === 'pending' || b.status === 'confirmed'), ...blocks.filter((b) => b.date === d)]
          .map((b) => [toMin(b.start), toMin(b.end)]);
        const slots = [];
        if (win) {
          for (let t = toMin(win.start); t + dur <= toMin(win.end); t += step) {
            const overlaps = busy.some(([a, b]) => t < b && t + dur > a);
            const past = T.minutesUntil(d, fromMin(t)) < minAhead;
            slots.push({ date: d, start: fromMin(t), end: fromMin(t + dur), at: zonedToUtc(d, fromMin(t), cfg.tz), free: !overlaps && !past, busy: overlaps, past });
          }
        }
        const capacity = win ? Math.floor((toMin(win.end) - toMin(win.start)) / dur) : 0;
        out[d] = {
          date: d, off: !win, window: win, slots, capacity,
          lessons: dayBookings.length,
          free: slots.filter((x) => x.free).length,
          load: capacity ? Math.min(1, dayBookings.length / capacity) : 0,
        };
      }
      return out;
    },
    async slotsFor(date) { return (await S.slotsRange(date, date))[date].slots; },
    /** Свободные слоты, сгруппированные по дате в поясе зрителя: { 'YYYY-MM-DD': [{date,start,vtime}] }. */
    async freeByViewerDate(tz, fromT, toT) {
      const r = await S.slotsRange(fromT, toT);
      const out = {};
      for (const day of Object.values(r)) {
        for (const sl of day.slots) {
          if (!sl.free) continue;
          const v = convert(sl.date, sl.start, cfg.tz, tz);
          (out[v.date] ||= []).push({ date: sl.date, start: sl.start, vtime: v.time });
        }
      }
      for (const k of Object.keys(out)) out[k].sort((a, b) => a.vtime.localeCompare(b.vtime));
      return out;
    },
    nowIn: (tz) => convert(T.now().date, T.now().time, cfg.tz, tz),
    async calendarRange(from, to, { withSlots = false } = {}) {
      const r = await S.slotsRange(from, to);
      return Object.values(r).map(({ slots, ...d }) => (withSlots ? { ...d, slots } : d));
    },

    // ---------- bookings ----------
    getBooking: (id) => sql.first(`SELECT b.*, u.name, u.username, u.tg_id, u.manual FROM bookings b
      LEFT JOIN users u ON u.id = b.user_id WHERE b.id = ?`, [id]),

    async userBookings(userId, { upcoming = true } = {}) {
      const n = T.now();
      return upcoming
        ? sql.all(`SELECT * FROM bookings WHERE user_id = ? AND status IN ${ACTIVE}
            AND (date > ? OR (date = ? AND end > ?)) ORDER BY date, start`, [userId, n.date, n.date, n.time])
        : sql.all('SELECT * FROM bookings WHERE user_id = ? ORDER BY date DESC, start DESC LIMIT 100', [userId]);
    },

    async createBooking({ userId, date, start, actorTgId, force = false }) {
      const s = await S.getSettings();
      const u = await S.getUser(userId);
      if (!u) throw new Error('Ученик не найден');
      const slot = (await S.slotsFor(date)).find((x) => x.start === start);
      if (!force) {
        if (!slot) throw new Error('Такого слота нет в расписании');
        if (!slot.free) throw new Error('Этот слот уже занят');
        if (date > addDays(T.now().date, Number(s.days_ahead))) throw new Error('Запись на эту дату ещё не открыта');
        if ((await S.userBookings(userId)).length >= Number(s.max_active)) {
          throw new Error(`Можно иметь не больше ${s.max_active} запланированных уроков одновременно`);
        }
      } else if (slot?.busy) {
        throw new Error('Этот слот уже занят');
      }
      const end = fromMin(toMin(start) + Number(s.lesson_duration));
      const status = force || s.auto_confirm === '1' ? 'confirmed' : 'pending';
      const r = await sql.run('INSERT INTO bookings(user_id, date, start, end, status, price) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, date, start, end, status, S.priceOf(u, s)]);
      await S.log(actorTgId ?? u.tg_id, 'booking.create', { booking_id: r.lastId, user_id: userId, date, start, status });
      return S.getBooking(r.lastId);
    },

    async setBookingStatus(id, status, actorTgId, extra = {}) {
      const b = await S.getBooking(id);
      if (!b) throw new Error('Бронь не найдена');
      const by = ['cancelled', 'late_cancel', 'rejected'].includes(status) ? (extra.by || 'teacher') : null;
      await sql.run("UPDATE bookings SET status = ?, cancelled_by = ?, updated_at = datetime('now') WHERE id = ?", [status, by, id]);
      // Списание урока с баланса при проведении, неявке или поздней отмене (и возврат при откате)
      if (CHARGED.includes(status) && !CHARGED.includes(b.status)) await sql.run('UPDATE users SET balance = balance - 1 WHERE id = ?', [b.user_id]);
      if (!CHARGED.includes(status) && CHARGED.includes(b.status)) await sql.run('UPDATE users SET balance = balance + 1 WHERE id = ?', [b.user_id]);
      await S.log(actorTgId, `booking.${status}`, { booking_id: id, user_id: b.user_id, date: b.date, start: b.start, from: b.status, ...extra });
      return S.getBooking(id);
    },

    async cancelByStudent(id, tgId) {
      const b = await S.getBooking(id);
      if (!b || b.tg_id !== tgId) throw new Error('Бронь не найдена');
      if (!['pending', 'confirmed'].includes(b.status)) throw new Error('Эту бронь уже нельзя отменить');
      const s = await S.getSettings();
      const late = b.status === 'confirmed' && T.minutesUntil(b.date, b.start) < Number(s.cancel_hours) * 60;
      return { booking: await S.setBookingStatus(id, late ? 'late_cancel' : 'cancelled', tgId, { by: 'student' }), late };
    },

    async rescheduleBooking(id, date, start, actorTgId) {
      const b = await S.getBooking(id);
      if (!b) throw new Error('Бронь не найдена');
      const s = await S.getSettings();
      const slot = (await S.slotsFor(date)).find((x) => x.start === start);
      if (!slot || !slot.free) throw new Error('Новый слот недоступен');
      const end = fromMin(toMin(start) + Number(s.lesson_duration));
      await sql.run("UPDATE bookings SET date = ?, start = ?, end = ?, rem24 = 0, rem2 = 0, rem15 = 0, updated_at = datetime('now') WHERE id = ?", [date, start, end, id]);
      await S.log(actorTgId, 'booking.reschedule', { booking_id: id, user_id: b.user_id, from: `${b.date} ${b.start}`, to: `${date} ${start}` });
      return S.getBooking(id);
    },

    async updateBookingNotes(id, { topic, homework }, actorTgId) {
      await sql.run("UPDATE bookings SET topic = COALESCE(?, topic), homework = COALESCE(?, homework), updated_at = datetime('now') WHERE id = ?",
        [topic ?? null, homework ?? null, id]);
      await S.log(actorTgId, 'booking.notes', { booking_id: id, topic, homework });
      return S.getBooking(id);
    },
    /** Последнее выданное ДЗ ученика (для напоминания перед уроком). */
    lastHomework: (userId) => sql.first(`SELECT date, topic, homework FROM bookings
      WHERE user_id = ? AND homework != '' AND status = 'done' ORDER BY date DESC, start DESC LIMIT 1`, [userId]),

    async monthDetail(from, to) {
      const [bookings, blocks, overrides] = await Promise.all([
        S.bookingsBetween(from, to),
        sql.all('SELECT * FROM blocks WHERE date BETWEEN ? AND ? ORDER BY start', [from, to]),
        sql.all('SELECT * FROM day_overrides WHERE date BETWEEN ? AND ?', [from, to]),
      ]);
      return { bookings, blocks, overrides };
    },
    pendingBookings: () => sql.all(`SELECT b.*, u.name, u.username FROM bookings b
      JOIN users u ON u.id = b.user_id WHERE b.status = 'pending' ORDER BY b.date, b.start`),
    bookingsBetween: (from, to) => sql.all(`SELECT b.*, u.name, u.username, u.level, u.manual, u.tg_id FROM bookings b
      JOIN users u ON u.id = b.user_id WHERE b.date BETWEEN ? AND ? ORDER BY b.date, b.start`, [from, to]),

    // ---------- days off / blocks ----------
    async setDayOverride(date, { is_off = 0, start = null, end = null, note = '' }, actorTgId) {
      await sql.run(`INSERT INTO day_overrides(date, is_off, start, end, note) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET is_off = excluded.is_off, start = excluded.start, end = excluded.end, note = excluded.note`,
      [date, is_off ? 1 : 0, start, end, note]);
      await S.log(actorTgId, 'day.override', { date, is_off, start, end });
    },
    async clearDayOverride(date, actorTgId) {
      await sql.run('DELETE FROM day_overrides WHERE date = ?', [date]);
      await S.log(actorTgId, 'day.override_clear', { date });
    },
    async addBlock(date, start, end, reason, actorTgId) {
      const r = await sql.run('INSERT INTO blocks(date, start, end, reason) VALUES (?, ?, ?, ?)', [date, start, end, reason || '']);
      await S.log(actorTgId, 'block.add', { id: r.lastId, date, start, end, reason });
    },
    async removeBlock(id, actorTgId) {
      await sql.run('DELETE FROM blocks WHERE id = ?', [id]);
      await S.log(actorTgId, 'block.remove', { id });
    },

    // ---------- payments & receipts ----------
    async addPayment(userId, amount, lessons, note, actorTgId, receiptId = null) {
      await sql.run('INSERT INTO payments(user_id, amount, lessons, note, receipt_id) VALUES (?, ?, ?, ?, ?)',
        [userId, Number(amount) || 0, Number(lessons) || 0, note || '', receiptId]);
      await sql.run('UPDATE users SET balance = balance + ? WHERE id = ?', [Number(lessons) || 0, userId]);
      await S.log(actorTgId, 'payment.add', { user_id: userId, amount: Number(amount), lessons: Number(lessons), note, receipt_id: receiptId });
      return S.getUser(userId);
    },
    userPayments: (userId) => sql.all('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC', [userId]),
    async addReceipt(userId, fileId, fileType, caption, actorTgId) {
      const r = await sql.run('INSERT INTO receipts(user_id, file_id, file_type, caption) VALUES (?, ?, ?, ?)', [userId, fileId, fileType, caption || '']);
      await S.log(actorTgId, 'receipt.add', { receipt_id: r.lastId, user_id: userId });
      return S.getReceipt(r.lastId);
    },
    getReceipt: (id) => sql.first(`SELECT r.*, u.name, u.username, u.tg_id, u.price, u.balance FROM receipts r
      JOIN users u ON u.id = r.user_id WHERE r.id = ?`, [id]),
    pendingReceipts: () => sql.all(`SELECT r.*, u.name, u.username, u.price, u.balance FROM receipts r
      JOIN users u ON u.id = r.user_id WHERE r.status = 'pending' ORDER BY r.id`),
    userReceipts: (userId) => sql.all('SELECT * FROM receipts WHERE user_id = ? ORDER BY id DESC LIMIT 20', [userId]),
    /** Принять чек: зачислить уроки. */
    async acceptReceipt(id, lessons, amount, actorTgId) {
      const r = await S.getReceipt(id);
      if (!r) throw new Error('Чек не найден');
      if (r.status !== 'pending') throw new Error('Чек уже обработан');
      const s = await S.getSettings();
      const sum = amount != null && amount !== '' ? Number(amount) : Number(lessons) * S.priceOf(r, s);
      await sql.run("UPDATE receipts SET status = 'accepted', handled_at = datetime('now') WHERE id = ?", [id]);
      const u = await S.addPayment(r.user_id, sum, lessons, 'по чеку', actorTgId, id);
      return { receipt: await S.getReceipt(id), user: u, amount: sum };
    },
    async rejectReceipt(id, actorTgId) {
      const r = await S.getReceipt(id);
      if (!r || r.status !== 'pending') throw new Error('Чек уже обработан');
      await sql.run("UPDATE receipts SET status = 'rejected', handled_at = datetime('now') WHERE id = ?", [id]);
      await S.log(actorTgId, 'receipt.rejected', { receipt_id: id, user_id: r.user_id });
      return S.getReceipt(id);
    },

    // ---------- stats ----------
    async stats(from, to) {
      const cnt = async (where, args = []) => (await sql.first(`SELECT COUNT(*) c FROM bookings WHERE date BETWEEN ? AND ? AND ${where}`, [from, to, ...args])).c;
      const [done, upcoming, cancelledStudent, cancelledTeacher, rejected, noShow] = await Promise.all([
        cnt("status = 'done'"),
        cnt("status IN ('confirmed','pending')"),
        cnt("status IN ('cancelled','late_cancel') AND cancelled_by = 'student'"),
        cnt("status = 'cancelled' AND COALESCE(cancelled_by,'teacher') = 'teacher'"),
        cnt("status = 'rejected'"),
        cnt("status = 'no_show'"),
      ]);
      const [incomeR, earnedR, cal, wd, top, studentsR, debtorsR] = await Promise.all([
        sql.first("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE date(created_at) BETWEEN ? AND ?", [from, to]),
        sql.first(`SELECT COALESCE(SUM(b.price),0) s FROM bookings b WHERE b.date BETWEEN ? AND ? AND b.status IN ('done','late_cancel','no_show')`, [from, to]),
        S.calendarRange(from, to),
        sql.all(`SELECT ((CAST(strftime('%w', date) AS INTEGER) + 6) % 7) + 1 AS wd, COUNT(*) c FROM bookings
          WHERE date BETWEEN ? AND ? AND status IN ('confirmed','done','pending') GROUP BY wd`, [from, to]),
        sql.all(`SELECT u.name, COUNT(*) c FROM bookings b JOIN users u ON u.id = b.user_id
          WHERE b.date BETWEEN ? AND ? AND b.status = 'done' GROUP BY b.user_id ORDER BY c DESC LIMIT 5`, [from, to]),
        sql.first('SELECT COUNT(*) c FROM users WHERE registered = 1 AND COALESCE(deleted, 0) = 0'),
        sql.first('SELECT COUNT(*) c FROM users WHERE registered = 1 AND COALESCE(deleted, 0) = 0 AND balance < 1'),
      ]);
      const income = incomeR.s;
      const earned = earnedR.s;
      const capacity = cal.reduce((a, d) => a + d.capacity, 0);
      const booked = cal.reduce((a, d) => a + d.lessons, 0);
      const byWeekday = [1, 2, 3, 4, 5, 6, 7].map((i) => wd.find((r) => r.wd === i)?.c || 0);
      const students = studentsR.c;
      const debtors = debtorsR.c;
      return {
        from, to, income, earned, done, upcoming, no_show: noShow, rejected,
        cancelled: cancelledStudent + cancelledTeacher, cancelled_student: cancelledStudent, cancelled_teacher: cancelledTeacher,
        students, debtors, load: capacity ? booked / capacity : 0, byWeekday, top,
        daily: cal.map((d) => ({ date: d.date, lessons: d.lessons, capacity: d.capacity, off: d.off })),
      };
    },

    // ---------- reminders ----------
    async dueReminders() {
      const n = T.now();
      const rows = await sql.all(`SELECT b.*, u.tg_id, u.name, u.n_24h, u.n_2h, u.n_15m FROM bookings b JOIN users u ON u.id = b.user_id
        WHERE b.status = 'confirmed' AND b.date BETWEEN ? AND ?`, [n.date, addDays(n.date, 2)]);
      const out = [];
      for (const b of rows) {
        const m = T.minutesUntil(b.date, b.start);
        if (m <= 0) continue;
        if (!b.rem15 && m <= 15) out.push({ b, kind: 'rem15' });
        else if (!b.rem2 && m <= 120 && m > 15) out.push({ b, kind: 'rem2' });
        else if (!b.rem24 && m <= 1440 && m > 120) out.push({ b, kind: 'rem24' });
      }
      return out;
    },
    async markReminded(id, kind) {
      const set = { rem24: 'rem24 = 1', rem2: 'rem24 = 1, rem2 = 1', rem15: 'rem24 = 1, rem2 = 1, rem15 = 1' }[kind];
      await sql.run(`UPDATE bookings SET ${set} WHERE id = ?`, [id]);
    },

    // ---------- export ----------
    async exportCsv(kind) {
      const q = {
        bookings: `SELECT b.id, b.date, b.start, b.end, b.status, b.cancelled_by, u.name, u.username, b.price, b.topic, b.homework, b.created_at
          FROM bookings b LEFT JOIN users u ON u.id = b.user_id ORDER BY b.date, b.start`,
        students: 'SELECT id, tg_id, name, username, phone, level, goal, price, balance, manual, notes, created_at FROM users WHERE registered = 1',
        payments: `SELECT p.id, p.created_at, u.name, p.amount, p.lessons, p.note, p.receipt_id FROM payments p
          LEFT JOIN users u ON u.id = p.user_id ORDER BY p.id`,
        logs: 'SELECT id, ts, actor_id, action, details FROM logs ORDER BY id',
      }[kind];
      if (!q) throw new Error('Unknown export');
      const rows = await sql.all(q);
      if (!rows.length) return '';
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const head = Object.keys(rows[0]);
      return '﻿' + [head.join(';'), ...rows.map((r) => head.map((h) => esc(r[h])).join(';'))].join('\n');
    },
  };
  return S;
}

function randomCode() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 10);
}
