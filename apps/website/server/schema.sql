-- 仅供河图 website 的独立数据库；不修改 Cloud 数据库。
CREATE TABLE IF NOT EXISTS auth_flows (
  id TEXT PRIMARY KEY, box TEXT NOT NULL, expires INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, box TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, token_hash TEXT NOT NULL,
  token_box TEXT NOT NULL, label TEXT NOT NULL, session_id TEXT, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_session ON devices(session_id);
CREATE TABLE IF NOT EXISTS model_operations (
  owner TEXT NOT NULL, operation_key TEXT NOT NULL, device_id TEXT NOT NULL,
  input_sha256 TEXT NOT NULL, task_sha256 TEXT NOT NULL, kind TEXT NOT NULL,
  model_id TEXT NOT NULL, policy_version TEXT NOT NULL, max_credits TEXT NOT NULL,
  remote_key TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(owner, operation_key)
);
CREATE INDEX IF NOT EXISTS model_operations_owner_created ON model_operations(owner,created_at,operation_key);
