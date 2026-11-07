-- Часовой пояс ученика (по умолчанию Москва)
ALTER TABLE users ADD COLUMN tz TEXT DEFAULT 'Europe/Moscow';
