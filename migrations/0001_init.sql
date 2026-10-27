CREATE TABLE IF NOT EXISTS answer_key (
  filename TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL,
  answer   TEXT NOT NULL CHECK (answer IN ('左', '右'))
);

CREATE TABLE IF NOT EXISTS participants (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL UNIQUE,
  class_seat TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequences (
  code       TEXT PRIMARY KEY,
  filenames  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id           TEXT NOT NULL,
  participant_code TEXT NOT NULL,
  session          TEXT NOT NULL CHECK (session IN ('前測', '後測')),
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  PRIMARY KEY (run_id, participant_code)
);

CREATE TABLE IF NOT EXISTS trials (
  run_id             TEXT NOT NULL,
  participant_code   TEXT NOT NULL,
  session            TEXT NOT NULL,
  presentation_order INTEGER NOT NULL,
  trial_id           TEXT NOT NULL,
  image              TEXT NOT NULL,
  correct_answer     TEXT NOT NULL,
  response           TEXT NOT NULL,
  is_correct         INTEGER NOT NULL,
  rt_ms              REAL NOT NULL,
  isi_ms             INTEGER NOT NULL,
  PRIMARY KEY (run_id, participant_code, presentation_order)
);

CREATE TABLE IF NOT EXISTS admin_login_failures (
  ip           TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_runs_code_session ON runs (participant_code, session, finished_at);
