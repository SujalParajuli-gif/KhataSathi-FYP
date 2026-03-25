import { Navigate, Outlet, useLocation } from "react-router";
import AppShell from "~/components/layout/AppShell";
import { getAuthUser, isLoggedIn } from "~/lib/auth";
import {
  getDefaultRoute,
  hasRouteAccess,
  normalizeProtectedPath,
} from "~/lib/routeAccess";

export default function AppLayout() {
  const location = useLocation();

  if (!isLoggedIn()) {
    return <Navigate to="/login" replace />;
  }

  const user = getAuthUser();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const normalizedPath = normalizeProtectedPath(location.pathname, user.role);

  if (normalizedPath !== location.pathname) {
    return <Navigate to={normalizedPath} replace />;
  }

  if (!hasRouteAccess(user.role, location.pathname)) {
    return <Navigate to={getDefaultRoute(user.role)} replace />;
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
