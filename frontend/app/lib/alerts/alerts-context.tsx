import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  markAlertReadApi,
  markAlertUnreadApi,
  markAllAlertsReadApi,
} from "~/lib/api/endpoints";
import { fetchAlerts, type AppAlert } from "~/lib/alerts/alerts";

type AlertsContextValue = {
  alerts: AppAlert[];
  loading: boolean;
  unreadCount: number;
  refreshAlerts: (limit?: number) => Promise<void>;
  markAlertRead: (alertKey: string) => Promise<void>;
  markAlertUnread: (alertKey: string) => Promise<void>;
  markAllAlertsRead: (alertKeys?: string[]) => Promise<void>;
};

const AlertsContext = createContext<AlertsContextValue | null>(null);

export function AlertsProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState<AppAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const latestLimitRef = useRef(100);

  async function refreshAlerts(limit = latestLimitRef.current) {
    latestLimitRef.current = limit;
    setLoading(true);
    try {
      setAlerts(await fetchAlerts(limit));
    } catch {
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshAlerts(100);
  }, []);

  async function markAlertRead(alertKey: string) {
    setAlerts((current) =>
      current.map((alert) =>
        alert.key === alertKey ? { ...alert, read: true } : alert,
      ),
    );

    try {
      await markAlertReadApi(alertKey);
    } catch {
      await refreshAlerts();
    }
  }

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

  async function markAllAlertsRead(alertKeys?: string[]) {
    const keys =
      alertKeys && alertKeys.length > 0
        ? alertKeys
        : alerts.filter((alert) => !alert.read).map((alert) => alert.key);

    if (keys.length === 0) return;

    setAlerts((current) => current.map((alert) => ({ ...alert, read: true })));

    try {
      await markAllAlertsReadApi(keys);
    } catch {
      await refreshAlerts();
    }
  }

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

