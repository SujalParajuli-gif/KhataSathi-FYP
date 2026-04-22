import { Navigate, Outlet, useLocation } from "react-router";
import AppShell from "~/components/layout/AppShell";
import { getAuthUser, isLoggedIn } from "~/lib/auth";
import {
  getDefaultRoute,
  hasRouteAccess,
  normalizeProtectedPath,
} from "~/lib/routeAccess";

// the main wrapper for all protected routes
// this checks if a user is logged in before rendering any child pages
export default function AppLayout() {
  const location = useLocation();

  // immediate redirect to the login screen if the auth token is completely missing
  if (!isLoggedIn()) {
    return <Navigate to="/login" replace />;
  }

  // reading the saved user object after confirming the token exists
  // we keep this as a second guard because a token without matching user data would break role checks below
  const user = getAuthUser();

  // this handles when local auth state is incomplete or corrupted
  // without this, the layout would try to read role-based routes from a null user
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // normalizing paths based on roles (e.g. redirecting cashiers hitting the root / path over to /billing)
  const normalizedPath = normalizeProtectedPath(location.pathname, user.role);

  if (normalizedPath !== location.pathname) {
    return <Navigate to={normalizedPath} replace />;
  }

  // verifying the user's role actually has permission to view the requested page
  // if they don't, we kick them back to their default safe route
  if (!hasRouteAccess(user.role, location.pathname)) {
    return <Navigate to={getDefaultRoute(user.role)} replace />;
  }

  // rendering the shared app shell only after all auth and access checks pass
  // this keeps protected UI from flashing briefly for someone who should be redirected
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

