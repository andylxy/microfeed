-- 0082_ext_app_device_version_permissions.sql
--
-- 设备管理（/admin/devices/）与版本管理（/admin/app-versions/）的权限码。
-- 两页都属治理类，挂在「账户」组（group_account），仅超管可授。
--
-- ⚠️ id 必须与 `permissionId()` 逐字节一致：公式为 `p_<code 中 ':' → '_'>`，
-- **其余字符（含连字符）原样保留**。故：
--     system:device:read        → p_system_device_read
--     system:device:manage      → p_system_device_manage
--     system:app-version:read   → p_system_app-version_read      ← 连字符保留！
--     system:app-version:manage → p_system_app-version_manage    ← 连字符保留！
-- 若把连字符也写成下划线（`p_system_app_version_read`），`code` 列 UNIQUE 会让
-- `seedRbac` 的同码 `INSERT OR IGNORE` 变 no-op，授权外键找不到行，
-- **全新安装的 bootstrapAdmin 直接 500**（0068 教训）。
-- `permissionId()` 是 TS 函数，SQL 里不能调用，必须写字面量（ADR-0004）。
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts），由
-- `tests/unit/admin-endpoint-guards.test.ts` 与 `tests/worker/rbac.test.ts` 守住。
--
-- 幂等：INSERT OR IGNORE。

INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_system_device_read',         'system:device:read',         '设备查看'),
  ('p_system_device_manage',       'system:device:manage',       '设备管理'),
  ('p_system_app-version_read',    'system:app-version:read',    '版本查看'),
  ('p_system_app-version_manage',  'system:app-version:manage',  '版本管理');
