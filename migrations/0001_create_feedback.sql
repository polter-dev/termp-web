CREATE TABLE feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  category   TEXT,
  message    TEXT NOT NULL,
  email      TEXT
);
