CREATE TABLE IF NOT EXISTS cars (
  code TEXT PRIMARY KEY,          -- секретний код клієнта (у посиланні)
  vin TEXT UNIQUE,
  lot TEXT,
  booking TEXT,                   -- номер/інформація про букінг контейнера
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  stage INTEGER NOT NULL,         -- 1..8
  photo_id TEXT,                  -- Telegram file_id (NULL = лише відмітка етапу)
  thumb_id TEXT,                  -- мініатюра для сітки фото
  ts INTEGER NOT NULL,            -- мс, час повідомлення в Telegram
  chat_id TEXT,
  msg_id INTEGER,
  group_id TEXT,                  -- media_group_id альбому
  recv INTEGER,                   -- коли отримано (лише для фото в буфері, code = '')
  UNIQUE (chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS events_code ON events (code);
CREATE INDEX IF NOT EXISTS events_group ON events (chat_id, group_id);

-- «поточне авто» для чату/теми: щоб фото без VIN потрапляло до правильної картки
CREATE TABLE IF NOT EXISTS ctx (
  key TEXT PRIMARY KEY,
  code TEXT NOT NULL
);
