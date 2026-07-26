// Site options — wp_options, minus the serialized-PHP part.
import type { Db } from './db.js';

export const DEFAULT_SETTINGS: Record<string, string> = {
  'site.title': 'Paged',
  'site.tagline': 'A weblog served entirely out of SQLite in your browser.',
};

export async function getSetting(db: Db, key: string): Promise<string> {
  const value = await db.scalar(`SELECT value FROM settings WHERE key = ?`, [key]);
  return typeof value === 'string' ? value : DEFAULT_SETTINGS[key] ?? '';
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export async function seedSettings(db: Db): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.query(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
  }
}
