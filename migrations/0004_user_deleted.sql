-- Удалённые ученики скрываются из списков; история уроков и оплат остаётся для статистики
ALTER TABLE users ADD COLUMN deleted INTEGER DEFAULT 0;
