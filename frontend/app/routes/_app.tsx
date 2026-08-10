import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import AppShell from "~/components/layout/AppShell";
import { AppStartupState, ConnectionStatusBanner } from "~/components/ui/AppStatus";
import {
  getBusinessCapabilitiesApi,
  type BusinessCapabilities,
} from "~/lib/api/endpoints";
import { getAuthUser, isLoggedIn } from "~/lib/auth";
import { BusinessCapabilitiesProvider } from "~/lib/businessCapabilities";
import {
  businessModeLabel,
  capabilityFailureSurface,
  capabilityRetryDelay,
  classifyCapabilityIssue,
  readCachedCapabilities,
  writeCachedCapabilities,
  type CapabilityIssue,
} from "~/lib/capabilityRecovery";
import {
  getDefaultRoute,
  hasRouteAccess,
  normalizeProtectedPath,
} from "~/lib/routeAccess";

// Protected application boundary. Capabilities control navigation visibility,
// while the backend remains the authority for every protected operation.
export default function AppLayout() {
  const location = useLocation();
  const user = getAuthUser();
  const [capabilities, setCapabilities] = useState<BusinessCapabilities | null>(() =>
    user ? readCachedCapabilities(user.id) : null,
  );
  const capabilitiesRef = useRef<BusinessCapabilities | null>(capabilities);
  const [startupIssue, setStartupIssue] = useState<CapabilityIssue | null>(null);
  const [refreshIssue, setRefreshIssue] = useState<CapabilityIssue | null>(null);
  const [isRefreshingCapabilities, setIsRefreshingCapabilities] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [retryKey, setRetryKey] = useState(0);

  const retryCapabilities = useCallback(() => {
    setRetryKey((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!isLoggedIn() || getAuthUser()?.mustChangePassword) return undefined;

    const controller = new AbortController();
    setIsRefreshingCapabilities(true);
    getBusinessCapabilitiesApi({ signal: controller.signal })
      .then((nextCapabilities) => {
        capabilitiesRef.current = nextCapabilities;
        setCapabilities(nextCapabilities);
        if (user) writeCachedCapabilities(user.id, nextCapabilities);
        setStartupIssue(null);
        setRefreshIssue(null);
        setRetryAttempt(0);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        const issue = classifyCapabilityIssue(
          error,
          typeof navigator === "undefined" ? true : navigator.onLine,
        );
        if (capabilityFailureSurface(Boolean(capabilitiesRef.current)) === "banner") {
          setRefreshIssue(issue);
        } else {
          setStartupIssue(issue);
        }
        setRetryAttempt((attempt) => attempt + 1);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsRefreshingCapabilities(false);
      });

    return () => controller.abort();
    // The last confirmed capabilities are read through capabilitiesRef. Adding
    // capabilities here would create another request after every successful load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryKey]);

  useEffect(() => {
    function refreshCapabilities() {
      retryCapabilities();
    }
    function refreshCapabilitiesInBackground() {
      if (capabilitiesRef.current) retryCapabilities();
    }
    function refreshWhenVisible() {
      if (document.visibilityState === "visible") refreshCapabilitiesInBackground();
    }

    window.addEventListener("business_capabilities_changed", refreshCapabilities);
    window.addEventListener("focus", refreshCapabilitiesInBackground);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("business_capabilities_changed", refreshCapabilities);
      window.removeEventListener("focus", refreshCapabilitiesInBackground);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [retryCapabilities]);

  useEffect(() => {
    const issue = startupIssue || refreshIssue;
    if (
      !issue ||
      isRefreshingCapabilities ||
      issue.kind === "offline" ||
      issue.kind === "unauthenticated" ||
      issue.kind === "forbidden"
    ) {
      return undefined;
    }

    const timer = window.setTimeout(
      retryCapabilities,
      capabilityRetryDelay(retryAttempt),
    );
    return () => window.clearTimeout(timer);
  }, [isRefreshingCapabilities, refreshIssue, retryAttempt, retryCapabilities, retryKey, startupIssue]);

  useEffect(() => {
    function handleOnline() {
      retryCapabilities();
    }
    function handleOffline() {
      const issue = classifyCapabilityIssue(new Error("Browser offline"), false);
      if (capabilityFailureSurface(Boolean(capabilitiesRef.current)) === "banner") {
        setRefreshIssue(issue);
      } else {
        setStartupIssue(issue);
      }
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [retryCapabilities]);

  useEffect(() => {
    if (!capabilities || capabilities.staffDraftRequestsEnabled) return;
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith("khatasathi:staff-draft-request:")) {
        window.localStorage.removeItem(key);
      }
    }
  }, [capabilities]);

  if (!isLoggedIn() || !user) {
    return <Navigate to="/login" replace />;
  }

  if (user.mustChangePassword) {
    return <Navigate to="/change-password" replace />;
  }

  if (!capabilities) {
    return (
      <AppStartupState
        issue={startupIssue}
        busy={isRefreshingCapabilities}
        onRetry={retryCapabilities}
      />
    );
  }

  const normalizedPath = normalizeProtectedPath(
    location.pathname,
    user.role,
    capabilities,
  );

  if (normalizedPath !== location.pathname) {
    return <Navigate to={normalizedPath} replace />;
  }

  if (!hasRouteAccess(user.role, location.pathname, capabilities)) {
    return <Navigate to={getDefaultRoute(user.role, capabilities)} replace />;
  }

  return (
    <BusinessCapabilitiesProvider capabilities={capabilities}>
      <AppShell
        statusBanner={
          refreshIssue ? (
            <ConnectionStatusBanner
              issue={refreshIssue}
              context={`${refreshIssue.message} Using the last confirmed ${businessModeLabel(capabilities.businessMode)} mode.`}
              busy={isRefreshingCapabilities}
              onRetry={retryCapabilities}
            />
          ) : null
        }
      >
        <Outlet />
      </AppShell>
    </BusinessCapabilitiesProvider>
  );
}
