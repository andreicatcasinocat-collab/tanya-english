// Перенос данных из старой базы (v1, data/teacher.db) в новую схему (data/app.db).
// Запуск: node scripts/migrate-v1.js [old.db] [new.db]
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oldPath = process.argv[2] || path.join(ROOT, 'data', 'teacher.db');
const newPath = process.argv[3] || path.join(ROOT, 'data', 'app.db');
if (existsSync(newPath)) { console.error(`Новая база уже существует: ${newPath}`); process.exit(1); }

const o = new DatabaseSync(oldPath, { readOnly: true });
const n = new DatabaseSync(newPath);
n.exec(readFileSync(path.join(ROOT, 'migrations', '0001_init.sql'), 'utf8'));
n.exec('BEGIN');

const settings = Object.fromEntries(o.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
for (const [k, v] of Object.entries(settings)) n.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run(k, v);
const defPrice = Number(settings.price || 1500);

const idMap = new Map(); // старый tg_id → новый users.id
for (const u of o.prepare('SELECT * FROM users').all()) {
  const r = n.prepare(`INSERT INTO users(tg_id, name, username, phone, level, goal, notes, balance, blocked, registered, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(u.tg_id, u.name, u.username, u.phone, u.level, u.goal, u.notes || '', u.balance, u.blocked, u.registered, u.created_at);
  idMap.set(u.tg_id, Number(r.lastInsertRowid));
}
// Кто отменял урок — восстанавливаем из журнала
const cancelBy = new Map();
for (const l of o.prepare("SELECT details FROM logs WHERE action IN ('booking.cancelled','booking.late_cancel','booking.rejected')").all()) {
  const d = JSON.parse(l.details || '{}');
  if (d.booking_id) cancelBy.set(d.booking_id, d.by === 'student' ? 'student' : 'teacher');
}
for (const b of o.prepare('SELECT * FROM bookings').all()) {
  const by = ['cancelled', 'late_cancel', 'rejected'].includes(b.status) ? (cancelBy.get(b.id) || (b.status === 'late_cancel' ? 'student' : 'teacher')) : null;
  n.prepare(`INSERT INTO bookings(id, user_id, date, start, end, status, cancelled_by, price, topic, homework, rem24, rem2, rem15, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(b.id, idMap.get(b.user_id), b.date, b.start, b.end, b.status, by, defPrice, b.topic || '', b.homework || '', b.rem24, b.rem1, b.rem1, b.created_at, b.updated_at);
}
for (const p of o.prepare('SELECT * FROM payments').all()) {
  n.prepare('INSERT INTO payments(id, user_id, amount, lessons, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.id, idMap.get(p.user_id), p.amount, p.lessons, p.note || '', p.created_at);
}
for (const d of o.prepare('SELECT * FROM day_overrides').all()) n.prepare('INSERT INTO day_overrides VALUES (?, ?, ?, ?, ?)').run(d.date, d.is_off, d.start, d.end, d.note);
for (const b of o.prepare('SELECT * FROM blocks').all()) n.prepare('INSERT INTO blocks VALUES (?, ?, ?, ?, ?)').run(b.id, b.date, b.start, b.end, b.reason);
for (const l of o.prepare('SELECT * FROM logs ORDER BY id').all()) {
  const d = JSON.parse(l.details || '{}');
  if (d.user_id && idMap.has(d.user_id)) d.user_id = idMap.get(d.user_id);
  n.prepare('INSERT INTO logs(id, ts, actor_id, action, details) VALUES (?, ?, ?, ?, ?)').run(l.id, l.ts, l.actor_id, l.action, JSON.stringify(d));
}
n.prepare("INSERT INTO logs(actor_id, action, details) VALUES (NULL, 'system.migrated', ?)").run(JSON.stringify({ from: 'v1', users: idMap.size }));
n.exec('COMMIT');
console.log(`✅ Перенесено: учеников ${idMap.size}, уроков ${o.prepare('SELECT COUNT(*) c FROM bookings').get().c}, оплат ${o.prepare('SELECT COUNT(*) c FROM payments').get().c}`);
