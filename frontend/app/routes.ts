import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  // Root index redirects (handled by _app.tsx if not logged in)
  layout("routes/_app.tsx", [
    index("routes/_app.dashboard.tsx"),
    route("products", "routes/_app.products.tsx"),
    route("billing", "routes/_app.billing.tsx"),
    route("invoices", "routes/_app.invoices.tsx"),
    route("history", "routes/_app.history.tsx"),
    route("analytics", "routes/_app.analytics.tsx"),
    route("alerts", "routes/_app.alerts.tsx"),
    route("profile", "routes/_app.profile.tsx"),
    route("settings", "routes/_app.settings.tsx"),
    route("discounts", "routes/_app.discounts.tsx"),
    route("cashier-profile", "routes/_app.cashierProfile.tsx"),
    route("customer-discounts", "routes/_app.customerDiscounts.tsx"),
    route("logout", "routes/_app.logout.tsx"),
  ]),

  // Login page (outside the _app shell)
  route("login", "routes/login.tsx"),
] satisfies RouteConfig;
