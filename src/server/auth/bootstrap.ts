import {hashPassword} from "better-auth/crypto";
import {notFoundResponse} from "@/server/http";

import {
  normalizeAdminEmail,
  validateAdminSetupCredentials,
} from "@/shared/AdminCredentials";
import {hasAdminOwner} from "@/server/auth/admin-owner";
import {seedRbac} from "@/server/rbac/seed";

export type AdminBootstrapStatus =
  | "already_initialized"
  | "created"
  | "invalid"
  | "unavailable";

type AdminBootstrapEnv = Pick<
  Env,
  | "FEED_DB"
  | "MICROFEED_SETUP_ADMIN_EMAIL"
  | "MICROFEED_SETUP_ADMIN_PASSWORD"
  | "MICROFEED_SETUP_ADMIN_PASSWORD_CONFIRMATION"
>;

function hasAnySetupBinding(runtimeEnv: AdminBootstrapEnv): boolean {
  return runtimeEnv.MICROFEED_SETUP_ADMIN_EMAIL !== undefined ||
    runtimeEnv.MICROFEED_SETUP_ADMIN_PASSWORD !== undefined ||
    runtimeEnv.MICROFEED_SETUP_ADMIN_PASSWORD_CONFIRMATION !== undefined;
}

export async function bootstrapAdmin(
  runtimeEnv: AdminBootstrapEnv,
): Promise<AdminBootstrapStatus> {
  if (!hasAnySetupBinding(runtimeEnv)) {
    return "unavailable";
  }

  if (await hasAdminOwner(runtimeEnv.FEED_DB)) {
    return "already_initialized";
  }

  const email = runtimeEnv.MICROFEED_SETUP_ADMIN_EMAIL;
  const password = runtimeEnv.MICROFEED_SETUP_ADMIN_PASSWORD;
  const passwordConfirmation =
    runtimeEnv.MICROFEED_SETUP_ADMIN_PASSWORD_CONFIRMATION;
  if (
    email === undefined ||
    password === undefined ||
    passwordConfirmation === undefined ||
    validateAdminSetupCredentials({
      email,
      password,
      passwordConfirmation,
    })
  ) {
    return "invalid";
  }

  const normalizedEmail = normalizeAdminEmail(email);
  const passwordHash = await hashPassword(password);
  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  try {
    // Guarantee the RBAC catalog (roles/permissions/grants) exists before we
    // reference `r_super_admin` below. This is idempotent, so it is a harmless
    // no-op when migration 0031 has already seeded the catalog.
    await seedRbac(runtimeEnv.FEED_DB);
    await runtimeEnv.FEED_DB.batch([
      runtimeEnv.FEED_DB.prepare(
        'INSERT INTO "auth_user" ' +
          '("id", "name", "email", "emailVerified", "createdAt", ' +
          '"updatedAt", "role") VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        userId,
        normalizedEmail,
        normalizedEmail,
        1,
        timestamp,
        timestamp,
        "admin",
      ),
      runtimeEnv.FEED_DB.prepare(
        'INSERT INTO "auth_account" ' +
          '("id", "accountId", "providerId", "userId", "password", ' +
          '"createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        accountId,
        userId,
        "credential",
        userId,
        passwordHash,
        timestamp,
        timestamp,
      ),
      // Assign the bootstrap admin to super_admin so a fresh install is fully
      // provisioned. This grant *is* the access: the guard's legacy
      // `role='admin'` bypass is gone, and `auth_user.role` is only a derived
      // mirror of this role (see BETTER_AUTH_ADMIN_ROLE).
      runtimeEnv.FEED_DB.prepare(
        "INSERT OR IGNORE INTO ext_user_roles (user_id, role_id) VALUES (?, 'r_super_admin')",
      ).bind(userId),
    ]);
    return "created";
  } catch (error) {
    if (await hasAdminOwner(runtimeEnv.FEED_DB)) {
      return "already_initialized";
    }
    throw error;
  }
}

function notFound(request: Request): Response {
  return notFoundResponse(request, {
    headers: {"content-type": "text/plain; charset=utf-8"},
  });
}

export async function handleAdminBootstrap(
  runtimeEnv: AdminBootstrapEnv,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return notFound(request);
  }

  try {
    const status = await bootstrapAdmin(runtimeEnv);
    if (status === "unavailable") {
      return notFound(request);
    }
    if (status === "invalid") {
      return Response.json(
        {error: "Dashboard login could not be initialized."},
        {status: 400},
      );
    }
    return Response.json({status});
  } catch {
    return Response.json(
      {error: "Dashboard login could not be initialized."},
      {status: 500},
    );
  }
}
