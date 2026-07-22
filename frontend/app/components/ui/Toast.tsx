import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router";
import Icon from "~/components/ui/Icon";
import { isRateLimited } from "~/lib/api/client";

export type ToastTone = "success" | "info" | "danger" | "warning";

type ToastItem = {
  id: number;
  tone: ToastTone;
  message: string;
  durationMs: number | null;
};

type ToastContextValue = {
  showToast: (
    tone: ToastTone,
    message: string,
    options?: { durationMs?: number | null; persistent?: boolean },
  ) => void;
  clearToasts: () => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function toneClasses(tone: ToastTone) {
  if (tone === "success") {
    return {
      shell: "border-emerald-200 bg-emerald-50 text-emerald-700",
      circle: "bg-emerald-600 text-white",
      icon: "check_circle",
      helper: "Change saved in KhataSathi.",
    };
  }
  if (tone === "danger") {
    return {
      shell: "border-rose-200 bg-rose-50 text-rose-700",
      circle: "bg-rose-600 text-white",
      icon: "error",
      helper: "Please review and try again.",
    };
  }
  if (tone === "warning") {
    return {
      shell: "border-amber-200 bg-amber-50 text-amber-700",
      circle: "bg-amber-500 text-white",
      icon: "warning",
      helper: "Check before continuing.",
    };
  }
  return {
    shell: "border-blue-200 bg-blue-50 text-blue-700",
    circle: "bg-blue-600 text-white",
    icon: "info",
    helper: "Information updated.",
  };
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);
  const recentToastRef = useRef<Map<string, number>>(new Map());

  const removeToast = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setItems([]);
    recentToastRef.current.clear();
  }, []);

  const showToast = useCallback<ToastContextValue["showToast"]>(
    (tone, message, options) => {
      const normalizedMessage = message.trim();
      // Route changes intentionally cancel work owned by the previous screen.
      // This is normal lifecycle cleanup, not an error the user can act on.
      if (
        tone === "danger" &&
        /request skipped after leaving its route|request cancel(?:led|ed)|background refresh skipped/i.test(
          normalizedMessage,
        )
      ) {
        return;
      }
      if (
        tone === "danger" &&
        isRateLimited() &&
        /429|too many requests|rate limit|temporarily paused/i.test(
          normalizedMessage,
        )
      ) {
        return;
      }
      const now = Date.now();
      const dedupeKey = `${tone}:${normalizedMessage}`;
      const lastShownAt = recentToastRef.current.get(dedupeKey);

      if (lastShownAt && now - lastShownAt < 1800) {
        return;
      }

      recentToastRef.current.set(dedupeKey, now);
      recentToastRef.current.forEach((shownAt, key) => {
        if (now - shownAt > 6000) {
          recentToastRef.current.delete(key);
        }
      });

      const id = nextIdRef.current;
      nextIdRef.current += 1;
      const durationMs =
        options?.persistent || options?.durationMs === null
          ? null
          : options?.durationMs ??
            (tone === "success" ? 2000 : tone === "danger" ? 6000 : 4000);

      setItems((current) => [
        ...current.slice(-2),
        { id, tone, message: normalizedMessage, durationMs },
      ]);
    },
    [],
  );

  useEffect(() => {
    clearToasts();
  }, [clearToasts, location.pathname]);

  const value = useMemo(
    () => ({ showToast, clearToasts }),
    [clearToasts, showToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed left-1/2 top-4 z-[90] flex w-[min(420px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-3">
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onClose={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({
  item,
  onClose,
}: {
  item: ToastItem;
  onClose: (id: number) => void;
}) {
  useEffect(() => {
    if (item.durationMs === null) return undefined;
    const timer = window.setTimeout(() => onClose(item.id), item.durationMs);
    return () => window.clearTimeout(timer);
  }, [item.durationMs, item.id, onClose]);

  const tone = toneClasses(item.tone);
  const trimmed = item.message.trim();
  const [firstSentence, ...rest] = trimmed.split(/(?<=\.)\s+/);
  const title = firstSentence || trimmed;
  const subtitle = rest.join(" ") || tone.helper;

  return (
    <div
      className={`rounded-[18px] border px-4 py-3 shadow-[0_18px_44px_rgba(15,23,42,0.16)] backdrop-blur ${tone.shell}`}
      role={item.tone === "danger" ? "alert" : "status"}
    >
      <div className="flex items-center gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tone.circle}`}
        >
          <Icon name={tone.icon} className="text-[20px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-extrabold leading-5">
            {title.replace(/\.$/, "")}
          </div>
          <div className="truncate text-[12px] font-semibold opacity-75">
            {subtitle.replace(/\.$/, "")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onClose(item.id)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-transparent text-inherit opacity-70 transition hover:border-current hover:bg-white/60 hover:opacity-100"
          aria-label="Close notification"
        >
          <Icon name="close" className="text-[16px]" />
        </button>
      </div>
    </div>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside ToastProvider");
  }
  return context;
}
