// Хранилище: встроенный SQLite из Node (node:sqlite), без внешних пакетов
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      token TEXT NOT NULL UNIQUE,
      uuid TEXT NOT NULL,
      hy2 TEXT NOT NULL,
      limit_bytes INTEGER NOT NULL DEFAULT 0,      -- 0 = без лимита
      expire_at INTEGER NOT NULL DEFAULT 0,        -- unix-секунды, 0 = бессрочно
      enabled INTEGER NOT NULL DEFAULT 1,          -- выключен вручную = 0
      up INTEGER NOT NULL DEFAULT 0,
      down INTEGER NOT NULL DEFAULT 0,
      last_active INTEGER NOT NULL DEFAULT 0,
      last_sub INTEGER NOT NULL DEFAULT 0,          -- когда клиент последний раз обновил подписку
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,          -- откуда: github / bundled
      body TEXT NOT NULL,            -- разобранный шаблон (JSON)
      status TEXT NOT NULL,          -- active / previous / rejected
      error TEXT NOT NULL DEFAULT '',
      fetched_at INTEGER NOT NULL
    );
  `);
  return db;
}

export const now = () => Math.floor(Date.now() / 1000);
export const token = (n = 18) => randomBytes(n).toString('base64url');
export const newUuid = () => randomUUID();

export function getSetting(db, k, def = '') {
  const r = db.prepare('SELECT v FROM settings WHERE k = ?').get(k);
  return r ? r.v : def;
}
export function setSetting(db, k, v) {
  db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
}
export function checkPassword(pw, stored) {
  const [, salt, hex] = String(stored).split(':');
  if (!salt || !hex) return false;
  const a = scryptSync(pw, salt, 32), b = Buffer.from(hex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Состояние пользователя: из чего его считать — в одном месте
export function userState(u, t = now()) {
  if (!u.enabled) return 'off';
  if (u.expire_at && u.expire_at <= t) return 'expired';
  if (u.limit_bytes && u.up + u.down >= u.limit_bytes) return 'limit';
  return 'active';
}
