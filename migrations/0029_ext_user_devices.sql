-- Device registry for single-device revoke / online-device management.
--
-- Additive `ext_` namespace (upgrade-safe). Captured from the `X-Device-Id`
-- header in the middleware login flow (D-09) — Better Auth is never touched.

CREATE TABLE IF NOT EXISTS ext_user_devices (
  user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  last_seen_at TIMESTAMP NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS ext_user_devices_status ON ext_user_devices (status);
CREATE INDEX IF NOT EXISTS ext_user_devices_user_id ON ext_user_devices (user_id);
