import type { UserRole } from "~/lib/auth";
import type { BusinessCapabilities } from "~/lib/api/endpoints";

export type HistoryCategoryKey =
  | "sales"
  | "product"
  | "stock"
  | "import"
  | "document"
  | "return"
  | "payment"
  | "system";

const ALL_HISTORY_CATEGORY_KEYS: HistoryCategoryKey[] = [
  "sales",
  "product",
  "stock",
  "import",
  "document",
  "return",
  "payment",
  "system",
];

export function getVisibleHistoryCategoryKeys(
  capabilities: Pick<BusinessCapabilities, "inventoryEnabled" | "posEnabled">,
) {
  return ALL_HISTORY_CATEGORY_KEYS.filter((category) => {
    if (!capabilities.posEnabled && ["sales", "return", "payment"].includes(category)) {
      return false;
    }
    if (!capabilities.inventoryEnabled && category === "stock") return false;
    return true;
  });
}

// the default landing page for each role after login
// admin goes to the dashboard ("/"), manager starts on products, cashier goes straight to billing
export const DEFAULT_ROUTE_BY_ROLE: Record<UserRole, string> = {
  admin: "/",
  manager: "/products",
  cashier: "/billing",
  staff: "/product-lookup",
};

// defining which routes each role is allowed to access
// admin can see everything, manager sees operational pages, cashier only sees billing-related pages
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

// checking if a given pathname matches an allowed route
// for "/", we need an exact match; for other routes, we also allow sub-paths
function matchesAllowedRoute(pathname: string, allowedRoute: string) {
  if (allowedRoute === "/") return pathname === "/";
  return pathname === allowedRoute || pathname.startsWith(`${allowedRoute}/`);
}

// returning the default route for a given role
export function getDefaultRoute(
  role: UserRole,
  capabilities?: BusinessCapabilities,
) {
  if (!capabilities || capabilities.posEnabled) return DEFAULT_ROUTE_BY_ROLE[role];
  if (role === "admin" || role === "manager") return "/products";
  return "/product-lookup";
}

// normalizing paths so the right profile page is shown for each role
// cashiers trying to visit "/" get redirected to "/billing" since they can't see the dashboard
// cashiers going to "/profile" get redirected to "/cashier-profile" (their own profile page)
// admins going to "/cashier-profile" get redirected to "/profile" (the admin profile page)
export function normalizeProtectedPath(
  pathname: string,
  role: UserRole,
  capabilities?: BusinessCapabilities,
) {
  if ((role === "cashier" || role === "staff") && pathname === "/") {
    return getDefaultRoute(role, capabilities);
  }

  if ((role === "cashier" || role === "manager" || role === "staff") && pathname === "/profile") {
    return "/cashier-profile";
  }

  if (role === "admin" && pathname === "/cashier-profile") {
    return "/profile";
  }

  return pathname;
}

const POS_ROUTES = [
  "/",
  "/analytics",
  "/billing",
  "/discounts",
  "/invoices",
  "/requests",
  "/customer-discounts",
] as const;

function matchesRouteGroup(pathname: string, routes: readonly string[]) {
  return routes.some((route) => matchesAllowedRoute(pathname, route));
}

export function hasCapabilityRouteAccess(
  pathname: string,
  capabilities: BusinessCapabilities,
) {
  if (matchesRouteGroup(pathname, POS_ROUTES)) return capabilities.posEnabled;
  if (matchesAllowedRoute(pathname, "/staff-requests")) {
    return capabilities.staffDraftRequestsEnabled;
  }
  if (matchesAllowedRoute(pathname, "/alerts")) {
    return capabilities.inventoryEnabled;
  }
  return true;
}

// checking if a user with the given role has access to a specific route
// we first normalize the path (in case of role-based redirects) and then check against the allowed list
export function hasRouteAccess(
  role: UserRole,
  pathname: string,
  capabilities?: BusinessCapabilities,
) {
  const normalized = normalizeProtectedPath(pathname, role, capabilities);
  const roleAllows = ALLOWED_ROUTES_BY_ROLE[role].some((allowed) =>
    matchesAllowedRoute(normalized, allowed),
  );
  return roleAllows && (!capabilities || hasCapabilityRouteAccess(normalized, capabilities));
}
