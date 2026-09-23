import {describe, expect, it} from "vitest";

import {
  adminAccountKind,
  adminUsernameEmail,
  MAX_ADMIN_PASSWORD_LENGTH,
  MAX_ADMIN_USERNAME_LENGTH,
  MIN_ADMIN_PASSWORD_LENGTH,
  MIN_ADMIN_USERNAME_LENGTH,
  normalizeAdminEmail,
  normalizeAdminUsername,
  validateAdminEmail,
  validateAdminPassword,
  validateAdminSetupCredentials,
  validateAdminUsername,
} from "@/shared/AdminCredentials";

describe("admin credentials", () => {
  it("normalizes email and accepts spaces and Unicode in passwords", () => {
    expect(normalizeAdminEmail(" Admin@Example.com ")).toBe(
      "admin@example.com",
    );
    expect(validateAdminPassword("Correct 🦊 password")).toBeUndefined();
  });

  it("enforces password length and confirmation", () => {
    expect(validateAdminPassword("short")).toContain("at least");
    expect(validateAdminPassword("x".repeat(MAX_ADMIN_PASSWORD_LENGTH + 1)))
      .toContain("no more");
    expect(validateAdminSetupCredentials({
      email: "admin@example.com",
      password: "Correct horse battery",
      passwordConfirmation: "different password value",
    })).toBe("The passwords do not match.");
  });

  it("enforces the minimum length boundary", () => {
    // Both boundaries are derived from the constant, so changing the policy
    // cannot leave this assertion stale. Both samples satisfy the composition
    // rule, leaving length as the only variable.
    const tooShort = `Ab1${"x".repeat(MIN_ADMIN_PASSWORD_LENGTH - 4)}`;
    const atMinimum = `Ab1${"x".repeat(MIN_ADMIN_PASSWORD_LENGTH - 3)}`;
    expect(tooShort).toHaveLength(MIN_ADMIN_PASSWORD_LENGTH - 1);
    expect(atMinimum).toHaveLength(MIN_ADMIN_PASSWORD_LENGTH);
    expect(validateAdminPassword(tooShort)).toContain("at least");
    expect(validateAdminPassword(atMinimum)).toBeUndefined();
  });

  it("requires mixed case or a digit", () => {
    expect(validateAdminPassword("lowercaseonly")).toContain("upper");
    expect(validateAdminPassword("UPPERCASEONLY")).toContain("upper");
    expect(validateAdminPassword("all lowercase 1")).toBeUndefined();
    expect(validateAdminPassword("MixedCaseOnly")).toBeUndefined();
  });

  it("classifies an account field by its shape", () => {
    expect(adminAccountKind("Admin@Example.com")).toBe("email");
    expect(adminAccountKind("zhang.san_1")).toBe("username");
  });

  it("validates and normalizes usernames", () => {
    expect(normalizeAdminUsername("  Zhang.San ")).toBe("zhang.san");
    expect(validateAdminUsername("ab")).toContain("at least");
    expect(
      validateAdminUsername("a".repeat(MAX_ADMIN_USERNAME_LENGTH + 1)),
    ).toContain("no more");
    expect(validateAdminUsername("has space")).toContain("letters");
    // The charset mirrors better-auth's own username validator; anything the
    // form accepts, the plugin must accept too.
    expect(validateAdminUsername("zhang.san_1")).toBeUndefined();
    // Uppercase input is accepted and normalized, matching the plugin.
    expect(validateAdminUsername("Z".repeat(MIN_ADMIN_USERNAME_LENGTH)))
      .toBeUndefined();
  });

  it("synthesises a placeholder address that is itself valid", () => {
    const email = adminUsernameEmail(" Zhang.San ");
    expect(email).toBe("zhang.san@users.microfeed.local");
    // better-auth rejects a user whose address fails its own email check, so the
    // placeholder has to pass ours as well.
    expect(validateAdminEmail(email)).toBeUndefined();
  });
});
