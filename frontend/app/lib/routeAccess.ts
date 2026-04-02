import type { UserRole } from "~/lib/auth";

export const DEFAULT_ROUTE_BY_ROLE: Record<UserRole, string> = {
  admin: "/",
  cashier: "/billing",
};

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

function matchesAllowedRoute(pathname: string, allowedRoute: string) {
  if (allowedRoute === "/") return pathname === "/";
  return pathname === allowedRoute || pathname.startsWith(`${allowedRoute}/`);
}

export function getDefaultRoute(role: UserRole) {
  return DEFAULT_ROUTE_BY_ROLE[role];
}

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

export function hasRouteAccess(role: UserRole, pathname: string) {
  const normalized = normalizeProtectedPath(pathname, role);
  return ALLOWED_ROUTES_BY_ROLE[role].some((allowed) =>
    matchesAllowedRoute(normalized, allowed),
  );
}
