export type UserRole = "admin" | "cashier";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  profileImage?: string;
};

const AUTH_KEY = "khatasathi_auth_user";
const TOKEN_KEY = "khatasathi_token";

function normalizeRole(role?: string | null): UserRole {
  return String(role || "").toLowerCase() === "cashier" ? "cashier" : "admin";
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
}

export function getAuthUser(): AuthUser | null {
  if (typeof window === "undefined") return null;

  const raw = window.localStorage.getItem(AUTH_KEY);

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AuthUser>;

    if (!parsed.id || !parsed.name || !parsed.email) {
      return null;
    }

    return {
      id: String(parsed.id),
      name: String(parsed.name),
      email: String(parsed.email),
      role: normalizeRole(parsed.role),
      profileImage: parsed.profileImage,
    };
  } catch {
    return null;
  }
}

export function setAuthUser(user: AuthUser) {
  if (typeof window === "undefined") return;

  const stored: AuthUser = {
    ...user,
    role: normalizeRole(user.role),
  };

  window.localStorage.setItem(AUTH_KEY, JSON.stringify(stored));
}

export function clearAuthUser() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUTH_KEY);
  clearToken();
}

export function getUserRole(): UserRole {
  return getAuthUser()?.role ?? "admin";
}

export function isLoggedIn(): boolean {
  return !!getToken() && !!getAuthUser();
}
