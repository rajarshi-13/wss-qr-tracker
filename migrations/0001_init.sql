-- Links: one row per short slug
CREATE TABLE IF NOT EXISTS links (
  slug        TEXT PRIMARY KEY,
  label       TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scans: one row per hit on /r/<slug>. ts is UTC 'YYYY-MM-DD HH:MM:SS'.
CREATE TABLE IF NOT EXISTS scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  slug         TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  user_agent   TEXT,
  referer      TEXT,
  is_bot       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_scans_slug_ts ON scans (slug, ts);
