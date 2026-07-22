import type { UserRole } from "~/lib/auth";

// defines the homepage each role lands on immediately after a successful login
export const DEFAULT_ROUTE_BY_ROLE: Record<UserRole, string> = {
  admin: "/",
  manager: "/products",
  cashier: "/billing",
  staff: "/product-lookup",
};

// this list is the source of truth for which protected routes each role can visit
// we use it in route guards so non-admin roles cannot manually type admin-only URLs in the browser
export const ALLOWED_ROUTES_BY_ROLE: Record<UserRole, string[]> = {
  admin: [
    "/",
    "/analytics",
    "/products",
    "/product-lookup",
    "/discounts",
    "/history",
    "/alerts",
    "/requests",
    "/invoices",
    "/documents",
    "/bin",
    "/settings",
    "/profile",
    "/logout",
  ],
  cashier: [
    "/billing",
    "/product-lookup",
    "/invoices",
    "/history",
    "/alerts",
    "/customer-discounts",
    "/cashier-profile",
    "/logout",
  ],
  staff: [
    "/product-lookup",
    "/staff-requests",
    "/cashier-profile",
    "/logout",
  ],
  manager: [
    "/",
    "/analytics",
    "/products",
    "/billing",
    "/product-lookup",
    "/discounts",
    "/invoices",
    "/history",
    "/alerts",
    "/requests",
    "/documents",
    "/cashier-profile",
    "/logout",
  ],
};

// safely matching route paths, making sure sub-routes are also permitted if the root route is
function matchesAllowedRoute(pathname: string, allowedRoute: string) {
  // the root route needs an exact match, otherwise every path would start with "/"
  if (allowedRoute === "/") return pathname === "/";
  return pathname === allowedRoute || pathname.startsWith(`${allowedRoute}/`);
}

// we use this small helper whenever we need the safest landing page for a role
export function getDefaultRoute(role: UserRole) {
  return DEFAULT_ROUTE_BY_ROLE[role];
}

// standardizes paths where both admin and cashier have slightly different URLs that achieve similar things
// like the profile page or the root dashboard
export function normalizeProtectedPath(pathname: string, role: UserRole) {
  // If the user is a cashier, redirect the root dashboard to the billing page
  if ((role === "cashier" || role === "staff") && pathname === "/") {
    return getDefaultRoute(role);
  }

  // this handles when a cashier reaches the shared admin profile path
  // we map it to the cashier-specific profile page so the rest of the route guard stays simple
  if ((role === "cashier" || role === "manager" || role === "staff") && pathname === "/profile") {
    return "/cashier-profile";
  }

  // doing the reverse mapping for admins keeps both profile URLs interchangeable inside shared navigation logic
  if (role === "admin" && pathname === "/cashier-profile") {
    return "/profile";
  }

  return pathname;
}

// this checks the final normalized path against the allowed list for the active role
// returning true here means the layout can safely render the protected page
export function hasRouteAccess(role: UserRole, pathname: string) {
  const normalized = normalizeProtectedPath(pathname, role); // checking access against the role-corrected version of the path
  return ALLOWED_ROUTES_BY_ROLE[role].some((allowed) =>
    matchesAllowedRoute(normalized, allowed),
  );
}
