-- Replay-defense nonce store for sensitive APP-originated writes (L2).
--
-- Additive `ext_` namespace (upgrade-safe). Nonces are de-duplicated with
-- `INSERT OR IGNORE`; expired rows are pruned by `checkReplay` since D1 has no
-- TTL. Web admin requests never send the nonce pair, so this table stays empty
-- for browser traffic.

CREATE TABLE IF NOT EXISTS ext_replay_nonces (
  nonce TEXT PRIMARY KEY,
  exp_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_replay_nonces_exp_at ON ext_replay_nonces (exp_at);
