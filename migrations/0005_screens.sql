-- Текущее сообщение-«экран» бота в каждом чате (чтобы обновлять его, а не слать новые)
CREATE TABLE IF NOT EXISTS screens (chat_id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL);
