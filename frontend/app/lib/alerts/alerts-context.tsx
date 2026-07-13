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

// defining the shape of the alerts context — this is what every component gets when they call useAlerts()
type AlertsContextValue = {
  alerts: AppAlert[];
  loading: boolean;
  unreadCount: number;
  refreshAlerts: (limit?: number) => Promise<void>;
  markAlertRead: (alertKey: string) => Promise<void>;
  markAlertUnread: (alertKey: string) => Promise<void>;
  markAllAlertsRead: (alertKeys?: string[]) => Promise<void>;
  resolveAlert: (alertKey: string) => Promise<void>;
  dismissAlert: (alertKey: string) => Promise<void>;
};

const AlertsContext = createContext<AlertsContextValue | null>(null);

// the AlertsProvider wraps the app and manages the global alerts state
// we put this at the top of the component tree so the topbar bell icon and the alerts page
// both share the same alerts data without making separate API calls
export function AlertsProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState<AppAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const latestLimitRef = useRef(100); // storing the last limit so refresh uses the same value

  // fetching alerts from the API and updating the state
  async function refreshAlerts(limit = latestLimitRef.current) {
    latestLimitRef.current = limit;
    setLoading(true);
    try {
      setAlerts(await fetchAlerts(limit));
    } catch {
      setAlerts([]); // if the API fails, we show an empty list instead of crashing
    } finally {
      setLoading(false);
    }
  }

  // loading alerts on first render
  useEffect(() => {
    refreshAlerts(100);
  }, []);

  // marking a single alert as read — we optimistically update the UI first and then call the API
  // if the API call fails, we refresh all alerts to get back in sync
  async function markAlertRead(alertKey: string) {
    setAlerts((current) =>
      current.map((alert) =>
        alert.key === alertKey ? { ...alert, read: true } : alert,
      ),
    );

    try {
      await markAlertReadApi(alertKey);
    } catch {
      await refreshAlerts(); // re-fetching to restore the correct state
    }
  }

  // marking a single alert as unread — same optimistic update pattern
  async function markAlertUnread(alertKey: string) {
    setAlerts((current) =>
      current.map((alert) =>
        alert.key === alertKey ? { ...alert, read: false } : alert,
      ),
    );

    try {
      await markAlertUnreadApi(alertKey);
    } catch {
      await refreshAlerts();
    }
  }

  // marking all alerts as read — if no specific keys are provided, we mark all unread ones
  async function markAllAlertsRead(alertKeys?: string[]) {
    const keys =
      alertKeys && alertKeys.length > 0
        ? alertKeys
        : alerts.filter((alert) => !alert.read).map((alert) => alert.key);

    if (keys.length === 0) return; // nothing to mark

    // optimistically marking everything as read in the UI
    setAlerts((current) => current.map((alert) => ({ ...alert, read: true })));

    try {
      await markAllAlertsReadApi(keys);
    } catch {
      await refreshAlerts();
    }
  }

  async function resolveAlert(alertKey: string) {
    setAlerts((current) => current.filter((alert) => alert.key !== alertKey));

    try {
      await resolveAlertApi(alertKey);
    } catch {
      await refreshAlerts();
    }
  }

  async function dismissAlert(alertKey: string) {
    setAlerts((current) => current.filter((alert) => alert.key !== alertKey));

    try {
      await dismissAlertApi(alertKey);
    } catch {
      await refreshAlerts();
    }
  }

  // computing the unread count for the bell icon badge
  const unreadCount = alerts.filter((alert) => !alert.read).length;

  return (
    <AlertsContext.Provider
      value={{
        alerts,
        loading,
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

// custom hook to access the alerts context — throws if used outside the AlertsProvider
export function useAlerts() {
  const context = useContext(AlertsContext);
  if (!context) {
    throw new Error("useAlerts must be used within an AlertsProvider");
  }
  return context;
}
