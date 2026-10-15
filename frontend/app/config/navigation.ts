import type { UserRole } from "../lib/auth";
import type { BusinessCapabilities } from "../lib/api/endpoints";

export type NavGroupId =
  | "quick"
  | "sales"
  | "inventory"
  | "operations"
  | "system"
  | "account";

export interface NavItemConfig {
  id: string;
  label: string;
  to: string;
  icon: string;
  roles: UserRole[];
  group: NavGroupId;
  pageTitle: string;
  description: string;
  danger?: boolean;
  end?: boolean;
}

export interface NavGroupConfig {
  id: NavGroupId;
  name: string;
  icon: string;
  items: NavItemConfig[];
}

export const NAV_ITEMS: NavItemConfig[] = [
  // Quick Access
  {
    id: "dashboard",
    label: "Dashboard",
    to: "/",
    icon: "dashboard",
    roles: ["admin", "manager"],
    group: "quick",
    pageTitle: "Dashboard",
    description: "Compact operations workspace and daily business metrics.",
    end: true,
  },
  {
    id: "billing",
    label: "Billing",
    to: "/billing",
    icon: "point_of_sale",
    roles: ["manager", "cashier"],
    group: "quick",
    pageTitle: "Billing",
    description: "Fast, keyboard-first point of sale and checkout counter.",
  },
  {
    id: "product-lookup",
    label: "Product Lookup",
    to: "/product-lookup",
    icon: "search",
    roles: ["admin", "manager", "cashier", "staff"],
    group: "quick",
    pageTitle: "Product Lookup",
    description: "Find products, barcode lookup, stock counts and retail prices.",
  },
  {
    id: "invoices",
    label: "Invoices",
    to: "/invoices",
    icon: "receipt_long",
    roles: ["admin", "manager", "cashier"],
    group: "quick",
    pageTitle: "Invoices",
    description: "Search recorded sales, bill history and payment receipts.",
  },

  // Sales & Customers
  {
    id: "receivables",
    label: "Customer Receivables",
    to: "/receivables",
    icon: "account_balance_wallet",
    roles: ["admin", "manager"],
    group: "sales",
    pageTitle: "Customer Receivables",
    description: "Customer credit ledgers, balances due and cash settlements.",
  },
  {
    id: "manual-bills",
    label: "Manual Bills",
    to: "/manual-bills",
    icon: "receipt",
    roles: ["admin", "manager", "cashier"],
    group: "sales",
    pageTitle: "Manual Bills",
    description: "Track physical paper bills, serials and uploaded bill photos.",
  },
  {
    id: "discounts",
    label: "Discounts",
    to: "/discounts",
    icon: "percent",
    roles: ["admin", "manager"],
    group: "sales",
    pageTitle: "Discounts",
    description: "Manage global discount policies, promotions and cashier limits.",
  },
  {
    id: "customer-discounts",
    label: "Customer Discounts",
    to: "/customer-discounts",
    icon: "loyalty",
    roles: ["cashier"],
    group: "sales",
    pageTitle: "Customer Discounts",
    description: "Inspect customer-specific discount tiers and authorized rates.",
  },
  {
    id: "history",
    label: "History",
    to: "/history",
    icon: "history",
    roles: ["admin", "manager", "cashier"],
    group: "sales",
    pageTitle: "History",
    description: "Audit trail, pricing logs, sales activity and system events.",
  },

  // Inventory & Purchasing
  {
    id: "products",
    label: "Products",
    to: "/products",
    icon: "inventory_2",
    roles: ["admin", "manager"],
    group: "inventory",
    pageTitle: "Products",
    description: "Product catalog, barcode generation, categories and pricing.",
  },
  {
    id: "purchases",
    label: "Purchases",
    to: "/purchases",
    icon: "shopping_bag",
    roles: ["admin", "manager"],
    group: "inventory",
    pageTitle: "Purchases",
    description: "Supplier intake, purchase invoices, batches and stock receipts.",
  },
  {
    id: "alerts",
    label: "Alerts",
    to: "/alerts",
    icon: "notifications",
    roles: ["admin", "manager", "cashier"],
    group: "inventory",
    pageTitle: "Alerts",
    description: "Low-stock notifications, expiry warnings and reorder alerts.",
  },

  // Business Operations
  {
    id: "expenses",
    label: "Expenses",
    to: "/expenses",
    icon: "credit_card",
    roles: ["admin", "manager"],
    group: "operations",
    pageTitle: "Expenses",
    description: "Record operating expenses, shop utilities and petty cash vouchers.",
  },
  {
    id: "analytics",
    label: "Analytics",
    to: "/analytics",
    icon: "analytics",
    roles: ["admin", "manager"],
    group: "operations",
    pageTitle: "Analytics",
    description: "Financial performance, revenue charts, and profit breakdowns.",
  },
  {
    id: "requests",
    label: "Requests",
    to: "/requests",
    icon: "pending_actions",
    roles: ["admin", "manager"],
    group: "operations",
    pageTitle: "Request Hub",
    description: "Review staff bill requests, approve drafts and convert to sales.",
  },
  {
    id: "staff-requests",
    label: "Requests",
    to: "/staff-requests",
    icon: "pending_actions",
    roles: ["staff"],
    group: "operations",
    pageTitle: "My Bill Requests",
    description: "Draft customer bills and send to cashier for checkout.",
  },

  // System & Tools
  {
    id: "documents",
    label: "Documents",
    to: "/documents",
    icon: "folder_open",
    roles: ["admin", "manager"],
    group: "system",
    pageTitle: "Document Storage",
    description: "Uploaded bills, receipts, VAT certificates and attachments.",
  },
  {
    id: "bin",
    label: "Recycle Bin",
    to: "/bin",
    icon: "delete",
    roles: ["admin"],
    group: "system",
    pageTitle: "Recycle Bin",
    description: "Recover or permanently delete archived products and records.",
  },
  {
    id: "settings",
    label: "Settings",
    to: "/settings",
    icon: "settings",
    roles: ["admin"],
    group: "system",
    pageTitle: "Settings",
    description: "Store profile, VAT configurations, backup schedules and security.",
  },

  // Account compartment
  {
    id: "profile-admin",
    label: "Profile",
    to: "/profile",
    icon: "person",
    roles: ["admin"],
    group: "account",
    pageTitle: "Profile",
    description: "Administrator account details and personal credentials.",
  },
  {
    id: "profile-staff",
    label: "Profile",
    to: "/cashier-profile",
    icon: "person",
    roles: ["manager", "cashier", "staff"],
    group: "account",
    pageTitle: "Profile",
    description: "Operator profile details and login password management.",
  },
  {
    id: "logout",
    label: "Logout",
    to: "/logout",
    icon: "logout",
    roles: ["admin", "manager", "cashier", "staff"],
    group: "account",
    pageTitle: "Logout",
    description: "Sign out of your KhataSathi session.",
    danger: true,
  },
];

export const WORKSPACE_GROUPS: Array<{
  id: NavGroupId;
  name: string;
  icon: string;
}> = [
  { id: "sales", name: "Sales & Customers", icon: "account_balance_wallet" },
  { id: "inventory", name: "Inventory & Purchasing", icon: "inventory_2" },
  { id: "operations", name: "Business Operations", icon: "analytics" },
  { id: "system", name: "System & Tools", icon: "settings" },
];

const POS_ROUTES = [
  "/receivables",
  "/",
  "/analytics",
  "/billing",
  "/discounts",
  "/invoices",
  "/manual-bills",
  "/requests",
  "/customer-discounts",
] as const;

function matchesAllowedRoute(pathname: string, allowedRoute: string) {
  if (allowedRoute === "/") return pathname === "/";
  return pathname === allowedRoute || pathname.startsWith(`${allowedRoute}/`);
}

function matchesRouteGroup(pathname: string, routes: readonly string[]) {
  return routes.some((route) => matchesAllowedRoute(pathname, route));
}

export function hasCapabilityRouteAccess(
  pathname: string,
  capabilities: BusinessCapabilities,
): boolean {
  if (matchesAllowedRoute(pathname, "/purchases")) return Boolean(capabilities.inventoryEnabled);
  if (matchesRouteGroup(pathname, POS_ROUTES)) return Boolean(capabilities.posEnabled);
  if (matchesAllowedRoute(pathname, "/staff-requests")) {
    return Boolean(capabilities.staffDraftRequestsEnabled);
  }
  if (matchesAllowedRoute(pathname, "/alerts")) {
    return Boolean(capabilities.catalogEnabled);
  }
  return true;
}

/**
 * Filter items accessible to the given role and business capabilities.
 */
export function getAuthorizedNavItems(
  role: UserRole,
  capabilities: BusinessCapabilities,
): NavItemConfig[] {
  return NAV_ITEMS.filter(
    (item) =>
      item.roles.includes(role) &&
      hasCapabilityRouteAccess(item.to, capabilities),
  );
}

/**
 * Proposed mobile bottom navigation destinations per role (max 3-4 primary destinations + More).
 */
export const MOBILE_BOTTOM_PRIMARY_BY_ROLE: Record<UserRole, string[]> = {
  admin: ["/", "/product-lookup", "/invoices"],
  manager: ["/", "/billing", "/product-lookup", "/invoices"],
  cashier: ["/billing", "/product-lookup", "/invoices", "/manual-bills"],
  staff: ["/product-lookup", "/staff-requests", "/cashier-profile"],
};

/**
 * Determine the exact primary mobile bottom navigation tabs for a role given current capabilities.
 */
export function getMobileBottomNavItems(
  role: UserRole,
  capabilities: BusinessCapabilities,
): NavItemConfig[] {
  const authorized = getAuthorizedNavItems(role, capabilities);
  const preferredRoutes = MOBILE_BOTTOM_PRIMARY_BY_ROLE[role] ?? [];

  const matched = preferredRoutes
    .map((route) => authorized.find((item) => item.to === route))
    .filter((item): item is NavItemConfig => Boolean(item));

  // If in Catalog mode, fallback to products if dashboard is unavailable
  if (matched.length === 0) {
    const fallback = authorized.find((item) => item.to === "/products" || item.to === "/product-lookup");
    if (fallback) matched.push(fallback);
  }

  return matched;
}

/**
 * Filter drawer items dynamically to ensure ZERO duplication with mobile bottom bar.
 */
export function getMobileDrawerItems(
  role: UserRole,
  capabilities: BusinessCapabilities,
  bottomNavItems: NavItemConfig[],
): NavItemConfig[] {
  const bottomRoutes = new Set(bottomNavItems.map((item) => item.to));
  const authorized = getAuthorizedNavItems(role, capabilities);

  return authorized.filter((item) => !bottomRoutes.has(item.to));
}

/**
 * Group navigation items into Quick Access and expandable Workspace Groups.
 */
export function partitionNavItems(items: NavItemConfig[]): {
  quick: NavItemConfig[];
  groups: NavGroupConfig[];
  account: NavItemConfig[];
} {
  const quick = items.filter((item) => item.group === "quick");
  const account = items.filter((item) => item.group === "account");

  const groups = WORKSPACE_GROUPS.map((meta) => {
    const groupItems = items.filter((item) => item.group === meta.id);
    return {
      ...meta,
      items: groupItems,
    };
  }).filter((group) => group.items.length > 0);

  return { quick, groups, account };
}

/**
 * Checks if a pathname matches an item's target route (supports exact and nested routes).
 */
export function isRouteActive(currentPath: string, targetPath: string, end?: boolean): boolean {
  if (targetPath === "/") return currentPath === "/";
  if (end) return currentPath === targetPath;
  return currentPath === targetPath || currentPath.startsWith(`${targetPath}/`);
}
