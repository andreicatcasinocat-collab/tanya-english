import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id      INTEGER PRIMARY KEY,
  name       TEXT,
  username   TEXT,
  phone      TEXT,
  level      TEXT,
  goal       TEXT,
  notes      TEXT DEFAULT '',
  balance    INTEGER DEFAULT 0,
  blocked    INTEGER DEFAULT 0,
  registered INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bookings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(tg_id),
  date       TEXT NOT NULL,
  start      TEXT NOT NULL,
  end        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  topic      TEXT DEFAULT '',
  homework   TEXT DEFAULT '',
  rem24      INTEGER DEFAULT 0,
  rem1       INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(tg_id),
  amount     INTEGER NOT NULL,
  lessons    INTEGER NOT NULL DEFAULT 0,
  note       TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS day_overrides (
  date   TEXT PRIMARY KEY,
  is_off INTEGER DEFAULT 0,
  start  TEXT,
  end    TEXT,
  note   TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS blocks (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  date   TEXT NOT NULL,
  start  TEXT NOT NULL,
  end    TEXT NOT NULL,
  reason TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT DEFAULT (datetime('now')),
  actor_id INTEGER,
  action   TEXT NOT NULL,
  details  TEXT DEFAULT '{}'
);
`);

// ---------- settings ----------
export const DEFAULT_SETTINGS = {
  teacher_name: 'Таня',
  work_days: '1,2,3,4,5',        // 1 = Пн … 7 = Вс
  work_start: '10:00',
  work_end: '20:00',
  lesson_duration: '60',          // минуты
  slot_step: '60',                // шаг сетки слотов
  price: '1500',                  // ₽ за урок
  cancel_hours: '24',             // бесплатная отмена не позже чем за N часов
  min_hours_before: '3',          // нельзя бронировать ближе чем за N часов
  days_ahead: '21',               // на сколько дней вперёд открыта запись
  auto_confirm: '0',              // 1 — брони подтверждаются автоматически
  max_active: '4',                // максимум будущих броней у одного ученика (защита от спама)
  rules: 'Отмена или перенос — не позднее чем за 24 часа. Поздняя отмена = урок списывается.',
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

// Админы, добавленные через /admin <код> (хранятся в базе, дополняют ADMIN_IDS)
db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('admin_ids', '')").run();
for (const id of (db.prepare("SELECT value FROM settings WHERE key = 'admin_ids'").get().value || '').split(',').filter(Boolean)) {
  if (!config.adminIds.includes(Number(id))) config.adminIds.push(Number(id));
}
export function addAdmin(id) {
  if (!config.adminIds.includes(id)) config.adminIds.push(id);
  const extra = new Set((db.prepare("SELECT value FROM settings WHERE key = 'admin_ids'").get().value || '').split(',').filter(Boolean));
  extra.add(String(id));
  db.prepare("UPDATE settings SET value = ? WHERE key = 'admin_ids'").run([...extra].join(','));
  log(id, 'security.admin_added', { id });
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
export function setSetting(key, value, actorId) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting ${key}`);
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
  log(actorId, 'settings.update', { key, value });
}

// ---------- logging ----------
export function log(actorId, action, details = {}) {
  db.prepare('INSERT INTO logs(actor_id, action, details) VALUES (?, ?, ?)')
    .run(actorId ?? null, action, JSON.stringify(details));
}
export function getLogs({ limit = 200, userId } = {}) {
  const sql = `SELECT l.*, u.name FROM logs l LEFT JOIN users u ON u.tg_id = l.actor_id
    ${userId ? 'WHERE l.actor_id = ?' : ''} ORDER BY l.id DESC LIMIT ?`;
  const args = userId ? [userId, limit] : [limit];
  return db.prepare(sql).all(...args).map((r) => ({ ...r, details: JSON.parse(r.details || '{}') }));
}

// ---------- time helpers (всё хранится в часовом поясе преподавателя) ----------
const pad = (n) => String(n).padStart(2, '0');
export const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

export function nowLocal() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
const asUtc = (date, time = '00:00') => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi);
};
export function minutesUntil(date, time) {
  const n = nowLocal();
  return (asUtc(date, time) - asUtc(n.date, n.time)) / 60000;
}
export function addDays(date, days) {
  const d = new Date(asUtc(date) + days * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export const isoWeekday = (date) => ((new Date(asUtc(date)).getUTCDay() + 6) % 7) + 1;

// ---------- users ----------
export function upsertUser({ id, first_name, last_name, username }) {
  db.prepare(`INSERT INTO users(tg_id, name, username) VALUES (?, ?, ?)
    ON CONFLICT(tg_id) DO UPDATE SET username = excluded.username`)
    .run(id, [first_name, last_name].filter(Boolean).join(' '), username || null);
  return getUser(id);
}
export const getUser = (id) => db.prepare('SELECT * FROM users WHERE tg_id = ?').get(id);
export function updateUser(id, fields, actorId) {
  const allowed = ['name', 'phone', 'level', 'goal', 'notes', 'blocked', 'registered'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return getUser(id);
  db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tg_id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  log(actorId, 'user.update', { user_id: id, ...Object.fromEntries(keys.map((k) => [k, fields[k]])) });
  return getUser(id);
}
export function listStudents() {
  return db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.tg_id AND b.status = 'done') AS lessons_done,
      (SELECT MIN(b.date || ' ' || b.start) FROM bookings b WHERE b.user_id = u.tg_id
         AND b.status IN ('pending','confirmed') AND b.date >= date('now','-1 day')) AS next_lesson,
      (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.user_id = u.tg_id) AS paid_total
    FROM users u WHERE u.registered = 1 ORDER BY u.name COLLATE NOCASE`).all();
}

// ---------- schedule ----------
const ACTIVE = "('pending','confirmed')";

export function dayWindow(date, s = getSettings()) {
  const o = db.prepare('SELECT * FROM day_overrides WHERE date = ?').get(date);
  if (o?.is_off) return null;
  if (o?.start && o?.end) return { start: o.start, end: o.end };
  const days = s.work_days.split(',').map(Number);
  if (!days.includes(isoWeekday(date))) return null;
  return { start: s.work_start, end: s.work_end };
}

export function bookingsOn(date, { withUsers = false } = {}) {
  return db.prepare(`SELECT b.*${withUsers ? ', u.name, u.username, u.level' : ''} FROM bookings b
    ${withUsers ? 'LEFT JOIN users u ON u.tg_id = b.user_id' : ''}
    WHERE b.date = ? AND b.status IN ${ACTIVE} ORDER BY b.start`).all(date);
}
export const blocksOn = (date) => db.prepare('SELECT * FROM blocks WHERE date = ? ORDER BY start').all(date);

/** Все слоты дня с флагом занятости. */
export function slotsFor(date, s = getSettings()) {
  const win = dayWindow(date, s);
  if (!win) return [];
  const dur = Number(s.lesson_duration);
  const step = Number(s.slot_step);
  const busy = [...bookingsOn(date), ...blocksOn(date)].map((b) => [toMin(b.start), toMin(b.end)]);
  const slots = [];
  for (let t = toMin(win.start); t + dur <= toMin(win.end); t += step) {
    const start = fromMin(t);
    const overlaps = busy.some(([a, b]) => t < b && t + dur > a);
    const tooSoon = minutesUntil(date, start) < Number(s.min_hours_before) * 60;
    slots.push({ start, end: fromMin(t + dur), free: !overlaps && !tooSoon, busy: overlaps, past: tooSoon });
  }
  return slots;
}
export const freeSlots = (date, s) => slotsFor(date, s).filter((x) => x.free);

/** Сводка по дням для календаря/тепловой карты. */
export function calendarRange(from, to) {
  const s = getSettings();
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const win = dayWindow(d, s);
    const slots = win ? slotsFor(d, s) : [];
    const lessons = db.prepare(`SELECT COUNT(*) c FROM bookings WHERE date = ? AND status IN ('pending','confirmed','done','no_show')`).get(d).c;
    const capacity = win ? Math.floor((toMin(win.end) - toMin(win.start)) / Number(s.lesson_duration)) : 0;
    out.push({
      date: d, off: !win, window: win, lessons, capacity,
      free: slots.filter((x) => x.free).length,
      load: capacity ? Math.min(1, lessons / capacity) : 0,
    });
  }
  return out;
}

// ---------- bookings ----------
export const getBooking = (id) => db.prepare(`SELECT b.*, u.name, u.username FROM bookings b
  LEFT JOIN users u ON u.tg_id = b.user_id WHERE b.id = ?`).get(id);

export function createBooking({ userId, date, start, actorId, force = false }) {
  const s = getSettings();
  const slot = slotsFor(date, s).find((x) => x.start === start);
  if (!force) {
    if (!slot) throw new Error('Такого слота нет в расписании');
    if (!slot.free) throw new Error('Этот слот уже занят');
    const maxDate = addDays(nowLocal().date, Number(s.days_ahead));
    if (date > maxDate) throw new Error('Запись на эту дату ещё не открыта');
    if (userBookings(userId).length >= Number(s.max_active)) {
      throw new Error(`Можно иметь не больше ${s.max_active} запланированных уроков одновременно`);
    }
  } else if (slot?.busy) {
    throw new Error('Этот слот уже занят');
  }
  const end = fromMin(toMin(start) + Number(s.lesson_duration));
  const status = force || s.auto_confirm === '1' ? 'confirmed' : 'pending';
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO bookings(user_id, date, start, end, status) VALUES (?, ?, ?, ?, ?)',
  ).run(userId, date, start, end, status);
  log(actorId ?? userId, 'booking.create', { booking_id: Number(lastInsertRowid), user_id: userId, date, start, status });
  return getBooking(Number(lastInsertRowid));
}

export function setBookingStatus(id, status, actorId, extra = {}) {
  const b = getBooking(id);
  if (!b) throw new Error('Бронь не найдена');
  db.prepare("UPDATE bookings SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  // Списание урока с баланса при проведении или поздней отмене
  const charge = (st) => st === 'done' || st === 'late_cancel' || st === 'no_show';
  if (charge(status) && !charge(b.status)) db.prepare('UPDATE users SET balance = balance - 1 WHERE tg_id = ?').run(b.user_id);
  if (!charge(status) && charge(b.status)) db.prepare('UPDATE users SET balance = balance + 1 WHERE tg_id = ?').run(b.user_id);
  log(actorId, `booking.${status}`, { booking_id: id, user_id: b.user_id, date: b.date, start: b.start, from: b.status, ...extra });
  return getBooking(id);
}

/** Отмена учеником: поздняя отмена списывает урок. */
export function cancelByStudent(id, userId) {
  const b = getBooking(id);
  if (!b || b.user_id !== userId) throw new Error('Бронь не найдена');
  if (!['pending', 'confirmed'].includes(b.status)) throw new Error('Эту бронь уже нельзя отменить');
  const s = getSettings();
  const late = b.status === 'confirmed' && minutesUntil(b.date, b.start) < Number(s.cancel_hours) * 60;
  return { booking: setBookingStatus(id, late ? 'late_cancel' : 'cancelled', userId, { by: 'student' }), late };
}

export function rescheduleBooking(id, date, start, actorId) {
  const b = getBooking(id);
  if (!b) throw new Error('Бронь не найдена');
  const s = getSettings();
  const slot = slotsFor(date, s).find((x) => x.start === start);
  if (!slot || !slot.free) throw new Error('Новый слот недоступен');
  const end = fromMin(toMin(start) + Number(s.lesson_duration));
  db.prepare("UPDATE bookings SET date = ?, start = ?, end = ?, rem24 = 0, rem1 = 0, updated_at = datetime('now') WHERE id = ?")
    .run(date, start, end, id);
  log(actorId, 'booking.reschedule', { booking_id: id, user_id: b.user_id, from: `${b.date} ${b.start}`, to: `${date} ${start}` });
  return getBooking(id);
}

export function updateBookingNotes(id, { topic, homework }, actorId) {
  db.prepare("UPDATE bookings SET topic = COALESCE(?, topic), homework = COALESCE(?, homework), updated_at = datetime('now') WHERE id = ?")
    .run(topic ?? null, homework ?? null, id);
  log(actorId, 'booking.notes', { booking_id: id, topic, homework });
  return getBooking(id);
}

export function userBookings(userId, { upcoming = true } = {}) {
  const n = nowLocal();
  return upcoming
    ? db.prepare(`SELECT * FROM bookings WHERE user_id = ? AND status IN ${ACTIVE}
        AND (date > ? OR (date = ? AND end > ?)) ORDER BY date, start`).all(userId, n.date, n.date, n.time)
    : db.prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY date DESC, start DESC LIMIT 50').all(userId);
}
export const pendingBookings = () => db.prepare(`SELECT b.*, u.name, u.username FROM bookings b
  JOIN users u ON u.tg_id = b.user_id WHERE b.status = 'pending' ORDER BY b.date, b.start`).all();

export function bookingsBetween(from, to) {
  return db.prepare(`SELECT b.*, u.name, u.username, u.level FROM bookings b JOIN users u ON u.tg_id = b.user_id
    WHERE b.date BETWEEN ? AND ? ORDER BY b.date, b.start`).all(from, to);
}

// ---------- days off / blocks ----------
export function setDayOverride(date, { is_off = 0, start = null, end = null, note = '' }, actorId) {
  db.prepare(`INSERT INTO day_overrides(date, is_off, start, end, note) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET is_off = excluded.is_off, start = excluded.start, end = excluded.end, note = excluded.note`)
    .run(date, is_off ? 1 : 0, start, end, note);
  log(actorId, 'day.override', { date, is_off, start, end, note });
}
export function clearDayOverride(date, actorId) {
  db.prepare('DELETE FROM day_overrides WHERE date = ?').run(date);
  log(actorId, 'day.override_clear', { date });
}
export const getDayOverride = (date) => db.prepare('SELECT * FROM day_overrides WHERE date = ?').get(date);
export function addBlock(date, start, end, reason, actorId) {
  const { lastInsertRowid } = db.prepare('INSERT INTO blocks(date, start, end, reason) VALUES (?, ?, ?, ?)').run(date, start, end, reason || '');
  log(actorId, 'block.add', { id: Number(lastInsertRowid), date, start, end, reason });
}
export function removeBlock(id, actorId) {
  db.prepare('DELETE FROM blocks WHERE id = ?').run(id);
  log(actorId, 'block.remove', { id });
}

// ---------- payments ----------
export function addPayment(userId, amount, lessons, note, actorId) {
  db.prepare('INSERT INTO payments(user_id, amount, lessons, note) VALUES (?, ?, ?, ?)').run(userId, amount, lessons, note || '');
  db.prepare('UPDATE users SET balance = balance + ? WHERE tg_id = ?').run(lessons, userId);
  log(actorId, 'payment.add', { user_id: userId, amount, lessons, note });
  return getUser(userId);
}
export const userPayments = (userId) =>
  db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC').all(userId);

// ---------- stats ----------
export function stats(from, to) {
  const count = (st) => db.prepare(`SELECT COUNT(*) c FROM bookings WHERE date BETWEEN ? AND ? AND status IN (${st})`).get(from, to).c;
  const income = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE date(created_at) BETWEEN ? AND ?').get(from, to).s;
  const cal = calendarRange(from, to);
  const capacity = cal.reduce((a, d) => a + d.capacity, 0);
  const booked = cal.reduce((a, d) => a + d.lessons, 0);
  const byWeekday = [1, 2, 3, 4, 5, 6, 7].map((wd) => db.prepare(`SELECT COUNT(*) c FROM bookings
    WHERE date BETWEEN ? AND ? AND status IN ('confirmed','done','pending')
    AND ((CAST(strftime('%w', date) AS INTEGER) + 6) % 7) + 1 = ?`).get(from, to, wd).c);
  const byHour = db.prepare(`SELECT substr(start,1,2) h, COUNT(*) c FROM bookings
    WHERE date BETWEEN ? AND ? AND status IN ('confirmed','done','pending') GROUP BY h ORDER BY h`).all(from, to);
  const top = db.prepare(`SELECT u.name, COUNT(*) c FROM bookings b JOIN users u ON u.tg_id = b.user_id
    WHERE b.date BETWEEN ? AND ? AND b.status = 'done' GROUP BY b.user_id ORDER BY c DESC LIMIT 5`).all(from, to);
  return {
    from, to, income,
    done: count("'done'"),
    upcoming: count("'confirmed','pending'"),
    cancelled: count("'cancelled','late_cancel'"),
    no_show: count("'no_show'"),
    students: db.prepare('SELECT COUNT(*) c FROM users WHERE registered = 1').get().c,
    load: capacity ? booked / capacity : 0,
    byWeekday, byHour, top,
  };
}

// ---------- reminders ----------
export function dueReminders() {
  const n = nowLocal();
  const rows = db.prepare(`SELECT b.*, u.name FROM bookings b JOIN users u ON u.tg_id = b.user_id
    WHERE b.status = 'confirmed' AND b.date BETWEEN ? AND ?`).all(n.date, addDays(n.date, 2));
  const out = [];
  for (const b of rows) {
    const m = minutesUntil(b.date, b.start);
    if (!b.rem24 && m <= 24 * 60 && m > 60) out.push({ b, kind: 'rem24' });
    else if (!b.rem1 && m <= 60 && m > 0) out.push({ b, kind: 'rem1' });
  }
  return out;
}
export const markReminded = (id, kind) =>
  db.prepare(`UPDATE bookings SET ${kind === 'rem1' ? 'rem1 = 1, rem24 = 1' : 'rem24 = 1'} WHERE id = ?`).run(id);

// ---------- export ----------
export function exportCsv(kind) {
  const q = {
    bookings: `SELECT b.id, b.date, b.start, b.end, b.status, u.name, u.username, b.topic, b.homework, b.created_at
      FROM bookings b LEFT JOIN users u ON u.tg_id = b.user_id ORDER BY b.date, b.start`,
    students: 'SELECT tg_id, name, username, phone, level, goal, balance, notes, created_at FROM users WHERE registered = 1',
    payments: `SELECT p.id, p.created_at, u.name, p.amount, p.lessons, p.note FROM payments p
      LEFT JOIN users u ON u.tg_id = p.user_id ORDER BY p.id`,
    logs: 'SELECT id, ts, actor_id, action, details FROM logs ORDER BY id',
  }[kind];
  if (!q) throw new Error('Unknown export');
  const rows = db.prepare(q).all();
  if (!rows.length) return '';
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = Object.keys(rows[0]);
  return '﻿' + [head.join(';'), ...rows.map((r) => head.map((h) => esc(r[h])).join(';'))].join('\n');
}
