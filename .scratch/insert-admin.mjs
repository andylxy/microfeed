import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const DB =
  ".microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite";
const db = new DatabaseSync(DB);

const userId = randomUUID();
const accountId = randomUUID();
const now = new Date().toISOString();
const email = "probe-admin@local.test";

// idempotent: remove any prior probe admin
db.prepare("DELETE FROM ext_user_roles WHERE user_id IN (SELECT id FROM auth_user WHERE email = ?)").run(email);
db.prepare("DELETE FROM auth_account WHERE userId IN (SELECT id FROM auth_user WHERE email = ?)").run(email);
db.prepare("DELETE FROM auth_user WHERE email = ?").run(email);

db.prepare(
  `INSERT INTO auth_user (id, name, email, emailVerified, image, createdAt, updatedAt, role, banned, banReason, banExpires)
   VALUES (?, ?, ?, 1, NULL, ?, ?, NULL, 0, NULL, NULL)`,
).run(userId, "probe-admin", email, now, now);

const crypto = await import("better-auth/crypto");
const hash = await crypto.hashPassword("Admin@12345");

db.prepare(
  `INSERT INTO auth_account (id, accountId, providerId, userId, accessToken, refreshToken, idToken,
     accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt)
   VALUES (?, ?, 'credential', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
).run(accountId, userId, userId, hash, now, now);

db.prepare("INSERT INTO ext_user_roles (user_id, role_id) VALUES (?, 'r_super_admin')").run(userId);

const check = db
  .prepare(
    `SELECT u.id, u.email, a.providerId, r.role_id FROM auth_user u
     LEFT JOIN auth_account a ON a.userId = u.id
     LEFT JOIN ext_user_roles r ON r.user_id = u.id
     WHERE u.email = ?`,
  )
  .all(email);
console.log("CREATED:", JSON.stringify(check));
db.close();
