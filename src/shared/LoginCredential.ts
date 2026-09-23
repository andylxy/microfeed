/**
 * Login credentials: opaque `mflc_…` tokens that authenticate a user without a
 * password or passkey. They are the shared vocabulary between the dashboard
 * (issue / list / revoke), the credential sign-in endpoint, and the public-API
 * bearer path.
 *
 * Kept in the additive `ext_` namespace; the better-auth core tables are
 * untouched. The plaintext token is re-displayable by design (product decision),
 * so revocation — not expiry — is the primary control.
 */

export const LOGIN_CREDENTIAL_PREFIX = "mflc_";

/** Max login credentials a single user may hold at once. */
export const MAX_LOGIN_CREDENTIALS_PER_USER = 5;

export interface LoginCredentialRecord {
  createdAtMs: number;
  expiresAtMs: number | null;
  id: string;
  lastUsedAtMs: number | null;
  name: string;
  /** Plaintext token. Re-displayable at any time (see module doc). */
  secret: string;
  revoked: boolean;
  userId: string;
}

/** What the dashboard needs to render one user's credential panel. */
export interface LoginCredentialBoard {
  credentials: LoginCredentialRecord[];
  userId: string;
}
