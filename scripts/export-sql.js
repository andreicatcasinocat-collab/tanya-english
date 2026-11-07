// Выгрузка данных из локальной базы в SQL для импорта в Cloudflare D1:
//   node scripts/export-sql.js > data/import.sql && npx wrangler d1 execute DB --remote --file data/import.sql
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(process.argv[2] || path.join(ROOT, 'data', 'app.db'), { readOnly: true });
const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const out = [];
for (const t of ['settings', 'users', 'bookings', 'payments', 'receipts', 'day_overrides', 'blocks', 'logs']) {
  out.push(`DELETE FROM ${t};`);
  for (const r of db.prepare(`SELECT * FROM ${t}`).all()) {
    const cols = Object.keys(r);
    out.push(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map((c) => lit(r[c])).join(', ')});`);
  }
}
process.stdout.write(out.join('\n') + '\n');
