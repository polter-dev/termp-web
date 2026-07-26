CREATE TABLE IF NOT EXISTS downloads (
  day     TEXT    NOT NULL,   -- UTC YYYY-MM-DD
  version TEXT    NOT NULL,   -- release tag or 'unreleased'
  channel TEXT    NOT NULL,   -- curl | brew | update | direct
  os      TEXT    NOT NULL,   -- darwin | linux
  arch    TEXT    NOT NULL,   -- amd64 | arm64
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, version, channel, os, arch)
);
