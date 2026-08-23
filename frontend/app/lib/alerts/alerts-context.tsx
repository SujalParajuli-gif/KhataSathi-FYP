import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  dismissAlertApi,
  markAlertReadApi,
  markAlertUnreadApi,
  markAllAlertsReadApi,
  resolveAlertApi,
} from "~/lib/api/endpoints";
import { fetchAlerts, type AppAlert } from "~/lib/alerts/alerts";
import { isRateLimitError } from "~/lib/api/client";

type AlertsContextValue = {
  alerts: AppAlert[];
  loading: boolean;
  error: string | null;
  unreadCount: number;
  refreshAlerts: (limit?: number) => Promise<void>;
  markAlertRead: (alertKey: string) => Promise<void>;
  markAlertUnread: (alertKey: string) => Promise<void>;
  markAllAlertsRead: (alertKeys?: string[]) => Promise<void>;
  resolveAlert: (alertKey: string) => Promise<void>;
  dismissAlert: (alertKey: string) => Promise<void>;
};

const AlertsContext = createContext<AlertsContextValue | null>(null);

const emptyAlertsContext: AlertsContextValue = {
  alerts: [],
  loading: false,
  error: null,
  unreadCount: 0,
  refreshAlerts: async () => {},
  markAlertRead: async () => {},
  markAlertUnread: async () => {},
  markAllAlertsRead: async () => {},
  resolveAlert: async () => {},
  dismissAlert: async () => {},
};

export function AlertsProvider({
  children,
  enabled = true,
  identityKey,
}: {
  children: ReactNode;
  enabled?: boolean;
  identityKey?: string;
}) {
  const [alerts, setAlerts] = useState<AppAlert[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const latestLimitRef = useRef(100);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const activeIdentityRef = useRef(identityKey);

  async function refreshAlerts(limit = latestLimitRef.current) {
    if (!enabled) return;
    if (refreshInFlightRef.current) return refreshInFlightRef.current;

    latestLimitRef.current = limit;
    const requestIdentity = identityKey;
    let refresh: Promise<void> = Promise.resolve();
    refresh = (async () => {
      setLoading(true);
      try {
        const nextAlerts = await fetchAlerts(limit);
        if (activeIdentityRef.current === requestIdentity) {
          setAlerts(nextAlerts);
          setError(null);
        }
      } catch {
        // Preserve the last successful result. Empty data must mean there are
        // no alerts, not that a transient request failed.
        if (activeIdentityRef.current === requestIdentity) {
          setError("Alerts could not be loaded. Check the connection and try again.");
        }
      } finally {
        if (activeIdentityRef.current === requestIdentity) setLoading(false);
        if (refreshInFlightRef.current === refresh) {
          refreshInFlightRef.current = null;
        }
      }
    })();

    refreshInFlightRef.current = refresh;
    return refresh;
  }

  useEffect(() => {
    activeIdentityRef.current = identityKey;
    refreshInFlightRef.current = null;
    setAlerts([]);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void refreshAlerts(100);
  }, [enabled, identityKey]);

  async function refreshAfterMutationFailure(error: unknown) {
    if (!isRateLimitError(error)) await refreshAlerts();
  }

  async function markAlertRead(alertKey: string) {
    try {
      await markAlertReadApi(alertKey);
      setAlerts((current) =>
        current.map((alert) =>
          alert.key === alertKey ? { ...alert, read: true } : alert,
        ),
      );
    } catch (error) {
      await refreshAfterMutationFailure(error);
    }
  }

  async function markAlertUnread(alertKey: string) {
    try {
      await markAlertUnreadApi(alertKey);
      setAlerts((current) =>
        current.map((alert) =>
          alert.key === alertKey ? { ...alert, read: false } : alert,
        ),
      );
    } catch (error) {
      await refreshAfterMutationFailure(error);
    }
  }

  async function markAllAlertsRead(alertKeys?: string[]) {
    const keys =
      alertKeys && alertKeys.length > 0
        ? alertKeys
        : alerts.filter((alert) => !alert.read).map((alert) => alert.key);
    if (keys.length === 0) return;

    try {
      await markAllAlertsReadApi(keys);
      const keySet = new Set(keys);
      setAlerts((current) =>
        current.map((alert) =>
          keySet.has(alert.key) ? { ...alert, read: true } : alert,
        ),
      );
    } catch (error) {
      await refreshAfterMutationFailure(error);
    }
  }

  async function resolveAlert(alertKey: string) {
    try {
      await resolveAlertApi(alertKey);
      setAlerts((current) => current.filter((alert) => alert.key !== alertKey));
    } catch (error) {
      await refreshAfterMutationFailure(error);
    }
  }

  async function dismissAlert(alertKey: string) {
    try {
      await dismissAlertApi(alertKey);
      setAlerts((current) => current.filter((alert) => alert.key !== alertKey));
    } catch (error) {
      await refreshAfterMutationFailure(error);
    }
  }

  const unreadCount = alerts.filter((alert) => !alert.read).length;

  if (!enabled) {
    return (
      <AlertsContext.Provider value={emptyAlertsContext}>
        {children}
      </AlertsContext.Provider>
    );
  }

  return (
    <AlertsContext.Provider
      value={{
        alerts,
        loading,
        error,
        unreadCount,
        refreshAlerts,
        markAlertRead,
        markAlertUnread,
        markAllAlertsRead,
        resolveAlert,
        dismissAlert,
      }}
    >
      {children}
    </AlertsContext.Provider>
  );
}

export function useAlerts() {
  const context = useContext(AlertsContext);
  if (!context) {
    throw new Error("useAlerts must be used within an AlertsProvider");
  }
  return context;
}
