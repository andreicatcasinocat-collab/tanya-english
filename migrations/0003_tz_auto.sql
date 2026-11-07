-- 1 = пояс определяется автоматически по устройству ученика, 0 = выбран вручную
ALTER TABLE users ADD COLUMN tz_auto INTEGER DEFAULT 1;
