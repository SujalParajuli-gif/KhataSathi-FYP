// the two user roles our app supports — admin has full access, cashier is limited to billing
export type UserRole = "admin" | "manager" | "cashier" | "staff";

// the user object we store in localStorage after login
export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  profileImage?: string;
};

// localStorage keys for saving authentication state
const AUTH_KEY = "khatasathi_auth_user";
const TOKEN_KEY = "khatasathi_token";

// normalizing the role string — the backend returns "ADMIN"/"CASHIER" in uppercase
// but we use lowercase in the frontend for consistency
function normalizeRole(role?: string | null): UserRole {
  const normalized = String(role || "").toLowerCase();
  if (
    normalized === "cashier" ||
    normalized === "manager" ||
    normalized === "admin" ||
    normalized === "staff"
  ) {
    return normalized;
  }
  return "admin";
}

// getting the JWT token from localStorage — returns null if not logged in or during SSR
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

// saving the JWT token to localStorage after login
export function setToken(token: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

// removing the JWT token — called during logout
export function clearToken() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
}

// reading the saved user object from localStorage and validating it has the required fields
// if the data is corrupted or missing, we return null so the app treats the user as logged out
export function getAuthUser(): AuthUser | null {
  if (typeof window === "undefined") return null;

  const raw = window.localStorage.getItem(AUTH_KEY);

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AuthUser>;

    // making sure all required fields exist — if not, the stored data is invalid
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
    return null; // if JSON parsing fails, the stored data is corrupted
  }
}

// saving the user object to localStorage — called after login and profile updates
export function setAuthUser(user: AuthUser) {
  if (typeof window === "undefined") return;

  const stored: AuthUser = {
    ...user,
    role: normalizeRole(user.role),
  };

  window.localStorage.setItem(AUTH_KEY, JSON.stringify(stored));
}

// clearing all auth data — called during logout
// we remove both the user object and the token so the app fully resets
export function clearAuthUser() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUTH_KEY);
  clearToken();
}

// getting the current user's role — defaults to "admin" if no user is logged in
export function getUserRole(): UserRole {
  return getAuthUser()?.role ?? "admin";
}

// checking if the user is logged in — both a token and a valid user object must exist
export function isLoggedIn(): boolean {
  return !!getToken() && !!getAuthUser();
}
