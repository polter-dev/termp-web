CREATE TABLE IF NOT EXISTS github_download_snapshots (
  day        TEXT    PRIMARY KEY,  -- UTC YYYY-MM-DD the snapshot was taken
  total      INTEGER NOT NULL,     -- cumulative GitHub download_count across matching stable-release assets
  latest_tag TEXT                  -- newest stable release tag at snapshot time, NULL before the first release
);
