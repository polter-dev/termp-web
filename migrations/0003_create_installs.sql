CREATE TABLE installs (
  day     TEXT    NOT NULL,   -- UTC YYYY-MM-DD
  version TEXT    NOT NULL,   -- 'latest' release tag at fetch time, or 'unreleased'
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, version)
);
