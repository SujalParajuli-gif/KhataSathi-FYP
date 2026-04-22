import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

// defining all the routes in the application
// the "_app.tsx" layout wraps all authenticated pages — it provides the sidebar, topbar, and auth guard
// routes outside the layout (login, print, eSewa result) are standalone pages
export default [
  layout("routes/_app.tsx", [
    index("routes/_app.dashboard.tsx"), // the admin dashboard — the default "/" route
    route("products", "routes/_app.products.tsx"),
    route("billing", "routes/_app.billing.tsx"), // the cashier's billing/POS page
    route("invoices", "routes/_app.invoices.tsx"),
    route("history", "routes/_app.history.tsx"),
    route("analytics", "routes/_app.analytics.tsx"),
    route("alerts", "routes/_app.alerts.tsx"),
    route("profile", "routes/_app.profile.tsx"), // admin profile page
    route("settings", "routes/_app.settings.tsx"),
    route("discounts", "routes/_app.discounts.tsx"),
    route("cashier-profile", "routes/_app.cashierProfile.tsx"), // cashier's own profile page
    route("customer-discounts", "routes/_app.customerDiscounts.tsx"), // cashier's customer discount view
    route("logout", "routes/_app.logout.tsx"),
  ]),

  route("login", "routes/login.tsx"), // standalone login page (no layout wrapper)
  route("invoices/:id/print", "routes/invoices.print.tsx"), // printable invoice view (opens in new tab)
  route("payments/esewa/result", "routes/payments.esewa.result.tsx"), // eSewa payment result callback page
] satisfies RouteConfig;

