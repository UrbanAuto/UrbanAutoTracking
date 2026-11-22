CREATE TABLE IF NOT EXISTS cars (
  code TEXT PRIMARY KEY,          -- секретний код клієнта (у посиланні)
  vin TEXT UNIQUE,
  lot TEXT,
  booking TEXT,                   -- номер букінга
  container TEXT,                 -- номер контейнера
  route TEXT,                     -- маршрут («Лос-Анджелес (США) → Клайпеда (Литва)»)
  order_id TEXT,                  -- номер замовлення CargoPlus (…/cars/order_20171)
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  stage INTEGER NOT NULL,         -- 1..8
  photo_id TEXT,                  -- Telegram file_id (NULL = лише відмітка етапу)
  thumb_id TEXT,                  -- мініатюра для сітки фото
  uid TEXT,                       -- file_unique_id фото (для дедуплікації)
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

-- авто, видалені в адмінці з позначкою «не додавати знову»: ключ = VIN або order:<номер замовлення>
CREATE TABLE IF NOT EXISTS blocked (
  key TEXT PRIMARY KEY,
  note TEXT,
  created_at INTEGER NOT NULL
);

-- групи/канали, куди бот пушить сповіщення про авто (керуються в адмін-панелі)
CREATE TABLE IF NOT EXISTS push_groups (
  chat_id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending (очікує підтвердження) | active | disabled | error
  scope TEXT NOT NULL DEFAULT 'cars',       -- all (усі авто) | cars (лише вибрані в push_group_cars)
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_group_cars (
  chat_id TEXT NOT NULL,
  code TEXT NOT NULL,
  PRIMARY KEY (chat_id, code)
);
