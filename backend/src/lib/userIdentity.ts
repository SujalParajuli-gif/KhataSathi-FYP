import {
  normalizeNepalMobilePhone,
  tryNormalizeNepalMobilePhone,
} from "./nepalPhone";

export class UserIdentityValidationError extends Error {
  field: "email" | "phone" | "identifier" | "password";

  constructor(
    field: "email" | "phone" | "identifier" | "password",
    message: string,
  ) {
    super(message);
    this.name = "UserIdentityValidationError";
    this.field = field;
  }
}

export function validateUserPassword(value: unknown) {
  const password = typeof value === "string" ? value : "";
  if (password.length < 8) {
    throw new UserIdentityValidationError(
      "password",
      "Password must contain at least 8 characters.",
    );
  }
  if (password.length > 128) {
    throw new UserIdentityValidationError(
      "password",
      "Password must contain no more than 128 characters.",
    );
  }
  return password;
}

export function normalizeOptionalUserEmail(value: unknown) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new UserIdentityValidationError(
      "email",
      "Enter a valid email address or leave email blank.",
    );
  }
  return email;
}

export function normalizeRequiredUserPhone(value: unknown) {
  try {
    return normalizeNepalMobilePhone(value);
  } catch (error) {
    throw new UserIdentityValidationError(
      "phone",
      error instanceof Error ? error.message : "Enter a valid Nepali mobile number.",
    );
  }
}

/**
 * Storage policy used by migration audits. Active accounts require an already
 * canonical number; archived historical identities may have no phone, but a
 * retained value must still be canonical rather than a misleading contact.
 */
export function satisfiesStoredUserPhonePolicy(
  value: unknown,
  isActive: boolean,
) {
  const raw = value === null || value === undefined ? "" : String(value).trim();
  if (!raw) return !isActive;
  return tryNormalizeNepalMobilePhone(raw) === raw;
}

export type LoginIdentity =
  | { kind: "email"; value: string }
  | { kind: "phone"; value: string };

export function normalizeLoginIdentity(value: unknown): LoginIdentity | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (raw.includes("@")) {
    try {
      const email = normalizeOptionalUserEmail(raw);
      return email ? { kind: "email", value: email } : null;
    } catch {
      return null;
    }
  }

  const phone = tryNormalizeNepalMobilePhone(raw);
  return phone ? { kind: "phone", value: phone } : null;
}

export function loginAttemptIdentity(value: unknown, identity: LoginIdentity | null) {
  if (identity) return identity.value;
  return String(value ?? "").trim().toLowerCase().slice(0, 191) || "<blank>";
}
