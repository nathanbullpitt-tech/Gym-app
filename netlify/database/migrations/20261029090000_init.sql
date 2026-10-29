-- One row per app document, private to each signed-in user.
CREATE TABLE docs (
  user_id    TEXT        NOT NULL,
  path       TEXT        NOT NULL,
  data       JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, path)
);

-- Shared workouts and plans. Anyone with the code can copy it; no stats are included.
CREATE TABLE shares (
  code       TEXT        PRIMARY KEY,
  owner_id   TEXT        NOT NULL,
  kind       TEXT        NOT NULL,
  title      TEXT        NOT NULL,
  payload    JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX shares_owner_idx ON shares (owner_id);
