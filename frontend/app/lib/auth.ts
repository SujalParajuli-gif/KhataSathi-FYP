// the two user roles our app supports — admin has full access, cashier is limited to billing
export type UserRole = "admin" | "manager" | "cashier" | "staff";

// the user object we store in localStorage after login
export type AuthUser = {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  mustChangePassword?: boolean;
  role: UserRole;
  profileImage?: string;
};

// localStorage keys for saving authentication state
const AUTH_KEY = "khatasathi_auth_user";

// normalizing the role string — the backend returns "ADMIN"/"CASHIER" in uppercase
// but we use lowercase in the frontend for consistency
function normalizeRole(role?: string | null): UserRole | null {
  const normalized = String(role || "").toLowerCase();
  if (
    normalized === "cashier" ||
    normalized === "manager" ||
    normalized === "admin" ||
    normalized === "staff"
  ) {
    return normalized;
  }
  return null;
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
    if (!parsed.id || !parsed.name) {
      return null;
    }

    const role = normalizeRole(parsed.role);
    if (!role) return null;

    return {
      id: String(parsed.id),
      name: String(parsed.name),
      email: parsed.email ? String(parsed.email) : null,
      phone: parsed.phone ? String(parsed.phone) : null,
      mustChangePassword: parsed.mustChangePassword === true,
      role,
      profileImage: parsed.profileImage,
    };
  } catch {
    return null; // if JSON parsing fails, the stored data is corrupted
  }
}

// saving the user object to localStorage — called after login and profile updates
export function setAuthUser(user: AuthUser) {
  if (typeof window === "undefined") return;

  const role = normalizeRole(user.role);
  if (!role) {
    clearAuthUser();
    return;
  }
  const stored: AuthUser = {
    ...user,
    role,
  };

  window.localStorage.setItem(AUTH_KEY, JSON.stringify(stored));
}

// clearing all auth data — called during logout
// we remove both the user object and the token so the app fully resets
export function clearAuthUser() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUTH_KEY);
  window.localStorage.removeItem("khatasathi_token");
}

// getting the current user's role — defaults to "admin" if no user is logged in
export function getUserRole(): UserRole {
  return getAuthUser()?.role ?? "staff";
}

// Fast client hint only; protected API requests verify the HttpOnly session.
export function isLoggedIn(): boolean {
  return !!getAuthUser();
}
