/**
 * Password policy, used by every place that sets a password: the CLI
 * (`manage auth`), the bootstrap/reset path, the admin-created-user endpoint,
 * the account page's change-password endpoint, and the setup forms.
 *
 * The rule is: at least 6 characters, and either mixed upper/lower case or at
 * least one digit. Keep it here rather than in the callers — `better-auth.ts`
 * takes its `minPasswordLength` from this constant too, so the framework gate
 * and our own checks cannot drift apart.
 */
export const MIN_ADMIN_PASSWORD_LENGTH = 6;
export const MAX_ADMIN_PASSWORD_LENGTH = 128;

/**
 * Username bounds and charset. These must stay in step with the better-auth
 * `username` plugin, which we configure with the same two numbers and whose
 * default validator is the same character class — the plugin re-checks every
 * value it stores, so a mismatch would surface as a server-side rejection of
 * something the form called valid.
 */
export const MIN_ADMIN_USERNAME_LENGTH = 3;
export const MAX_ADMIN_USERNAME_LENGTH = 32;
const ADMIN_USERNAME_PATTERN = /^[a-zA-Z0-9_.]+$/u;

/**
 * Domain used to synthesise an address for an account that signs in by
 * username. better-auth requires an address on every user; this one is never
 * reachable, so such an account cannot receive password-reset mail.
 */
export const ADMIN_USERNAME_EMAIL_DOMAIN = "users.microfeed.local";

export const ADMIN_SETUP_SECRET_NAMES = [
  "MICROFEED_SETUP_ADMIN_EMAIL",
  "MICROFEED_SETUP_ADMIN_PASSWORD",
  "MICROFEED_SETUP_ADMIN_PASSWORD_CONFIRMATION",
] as const;

export interface AdminSetupCredentials {
  email: string;
  password: string;
  passwordConfirmation: string;
}

export function normalizeAdminEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validateAdminEmail(value: string): string | undefined {
  const email = normalizeAdminEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
    ? undefined
    : "Enter a valid email address.";
}

export function validateAdminPassword(value: string): string | undefined {
  const length = Array.from(value).length;
  if (length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`;
  }
  if (length > MAX_ADMIN_PASSWORD_LENGTH) {
    return `Use no more than ${MAX_ADMIN_PASSWORD_LENGTH} characters.`;
  }
  if (!hasMixedCase(value) && !/\d/u.test(value)) {
    return "Mix upper and lower case, or include a digit.";
  }
  return undefined;
}

function hasMixedCase(value: string): boolean {
  return /[a-z]/u.test(value) && /[A-Z]/u.test(value);
}

export function validateAdminSetupCredentials(
  credentials: AdminSetupCredentials,
): string | undefined {
  return validateAdminEmail(credentials.email) ??
    validateAdminPassword(credentials.password) ??
    (
      credentials.password === credentials.passwordConfirmation
        ? undefined
        : "The passwords do not match."
    );
}

/** Which identifier an admin typed into an account field. */
export type AdminAccountKind = "email" | "username";

/**
 * Classify an account field: anything with an `@` is treated as an address and
 * validated as one, so a malformed address is reported as a bad address rather
 * than as a bad username.
 */
export function adminAccountKind(value: string): AdminAccountKind {
  return value.includes("@") ? "email" : "username";
}

/** The plugin lowercases usernames before storing and looking them up. */
export function normalizeAdminUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validateAdminUsername(value: string): string | undefined {
  const username = normalizeAdminUsername(value);
  if (username.length < MIN_ADMIN_USERNAME_LENGTH) {
    return `Use at least ${MIN_ADMIN_USERNAME_LENGTH} characters.`;
  }
  if (username.length > MAX_ADMIN_USERNAME_LENGTH) {
    return `Use no more than ${MAX_ADMIN_USERNAME_LENGTH} characters.`;
  }
  if (!ADMIN_USERNAME_PATTERN.test(username)) {
    return "Use letters, digits, dots, or underscores.";
  }
  return undefined;
}

/** The address stored for a username-only account (see the domain constant). */
export function adminUsernameEmail(username: string): string {
  return `${normalizeAdminUsername(username)}@${ADMIN_USERNAME_EMAIL_DOMAIN}`;
}
