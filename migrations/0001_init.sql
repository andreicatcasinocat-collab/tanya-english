-- Схема базы (SQLite / Cloudflare D1)
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id      INTEGER UNIQUE,            -- NULL у учеников, добавленных вручную без Telegram
  name       TEXT,
  username   TEXT,
  phone      TEXT,
  level      TEXT,
  goal       TEXT,
  notes      TEXT DEFAULT '',
  price      INTEGER,                   -- индивидуальная цена урока; NULL = цена по умолчанию
  balance    INTEGER DEFAULT 0,         -- оплаченные, но не проведённые уроки
  blocked    INTEGER DEFAULT 0,
  registered INTEGER DEFAULT 0,
  manual     INTEGER DEFAULT 0,         -- добавлен преподавателем вручную
  link_code  TEXT UNIQUE,               -- код приглашения для привязки Telegram к карточке
  n_24h      INTEGER DEFAULT 1,         -- уведомления, которые ученик может отключить
  n_2h       INTEGER DEFAULT 1,
  n_15m      INTEGER DEFAULT 1,
  n_done     INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bookings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  date         TEXT NOT NULL,
  start        TEXT NOT NULL,
  end          TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  cancelled_by TEXT,                    -- student | teacher
  price        INTEGER,                 -- цена этого урока (для статистики)
  topic        TEXT DEFAULT '',
  homework     TEXT DEFAULT '',
  rem24        INTEGER DEFAULT 0,
  rem2         INTEGER DEFAULT 0,
  rem15        INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
CREATE TABLE IF NOT EXISTS receipts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  file_id    TEXT NOT NULL,
  file_type  TEXT NOT NULL,             -- photo | document
  caption    TEXT DEFAULT '',
  status     TEXT DEFAULT 'pending',    -- pending | accepted | rejected
  created_at TEXT DEFAULT (datetime('now')),
  handled_at TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  amount     INTEGER NOT NULL,
  lessons    INTEGER NOT NULL DEFAULT 0,
  note       TEXT DEFAULT '',
  receipt_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS day_overrides (
  date TEXT PRIMARY KEY, is_off INTEGER DEFAULT 0, start TEXT, end TEXT, note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, reason TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')), actor_id INTEGER, action TEXT NOT NULL, details TEXT DEFAULT '{}'
);
-- Состояние диалогов бота (жду текст/чек) — хранится в базе, чтобы работать на serverless
CREATE TABLE IF NOT EXISTS state (
  tg_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now'))
);
