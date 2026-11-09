-- Monthly AI usage per user, so the app can show an estimate of credits used.
CREATE TABLE ai_usage (
  user_id       TEXT    NOT NULL,
  month         TEXT    NOT NULL,
  model         TEXT    NOT NULL,
  calls         INTEGER NOT NULL DEFAULT 0,
  input_tokens  BIGINT  NOT NULL DEFAULT 0,
  output_tokens BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month, model)
);
