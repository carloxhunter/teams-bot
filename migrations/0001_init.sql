CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE vacations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);
CREATE TABLE days (
  date TEXT PRIMARY KEY,
  week TEXT NULL,
  presenter TEXT NOT NULL,
  speaking_order TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent')),
  sharing_completed INTEGER NULL
);
CREATE TABLE weeks (
  week TEXT PRIMARY KEY,
  presenter TEXT NOT NULL
);
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
