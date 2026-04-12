import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
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

  route("login", "routes/login.tsx"),
  route("invoices/:id/print", "routes/invoices.print.tsx"),
  route("payments/esewa/result", "routes/payments.esewa.result.tsx"),
] satisfies RouteConfig;

