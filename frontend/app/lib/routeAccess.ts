import type { UserRole } from "~/lib/auth";

// the default landing page for each role after login
// admin goes to the dashboard ("/"), cashier goes straight to billing
export const DEFAULT_ROUTE_BY_ROLE: Record<UserRole, string> = {
  admin: "/",
  cashier: "/billing",
};

// defining which routes each role is allowed to access
// admin can see everything, cashier only sees billing-related pages
export const ALLOWED_ROUTES_BY_ROLE: Record<UserRole, string[]> = {
  admin: [
    "/",
    "/analytics",
    "/products",
    "/discounts",
    "/history",
    "/alerts",
    "/invoices",
    "/settings",
    "/profile",
    "/logout",
  ],
  cashier: [
    "/billing",
    "/invoices",
    "/history",
    "/alerts",
    "/customer-discounts",
    "/cashier-profile",
    "/logout",
  ],
};

// checking if a given pathname matches an allowed route
// for "/", we need an exact match; for other routes, we also allow sub-paths
function matchesAllowedRoute(pathname: string, allowedRoute: string) {
  if (allowedRoute === "/") return pathname === "/";
  return pathname === allowedRoute || pathname.startsWith(`${allowedRoute}/`);
}

// returning the default route for a given role
export function getDefaultRoute(role: UserRole) {
  return DEFAULT_ROUTE_BY_ROLE[role];
}

// normalizing paths so the right profile page is shown for each role
// cashiers trying to visit "/" get redirected to "/billing" since they can't see the admin dashboard
// cashiers going to "/profile" get redirected to "/cashier-profile" (their own profile page)
// admins going to "/cashier-profile" get redirected to "/profile" (the admin profile page)
export function normalizeProtectedPath(pathname: string, role: UserRole) {
  if (role === "cashier" && pathname === "/") {
    return "/billing";
  }

  if (role === "cashier" && pathname === "/profile") {
    return "/cashier-profile";
  }

  if (role === "admin" && pathname === "/cashier-profile") {
    return "/profile";
  }

  return pathname;
}

// checking if a user with the given role has access to a specific route
// we first normalize the path (in case of role-based redirects) and then check against the allowed list
export function hasRouteAccess(role: UserRole, pathname: string) {
  const normalized = normalizeProtectedPath(pathname, role);
  return ALLOWED_ROUTES_BY_ROLE[role].some((allowed) =>
    matchesAllowedRoute(normalized, allowed),
  );
}
