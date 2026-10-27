CREATE TABLE IF NOT EXISTS revoked_sessions (
  sig        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
