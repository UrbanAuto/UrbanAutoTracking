// Налаштування кабінету клієнта.
// API_URL — адреса Cloudflare Worker (без / в кінці), напр. https://urban-auto-tracking.<акаунт>.workers.dev
// Поки API_URL порожній, сайт показує демо-дані (відкрийте ?demo).
window.TRACKING_CONFIG = {
  API_URL: 'https://urban-auto-tracking.urbanauto66.workers.dev',
  POLL_MS: 60000,   // як часто оновлювати сторінку
};
