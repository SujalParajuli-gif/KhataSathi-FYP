import { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "~/lib/api/baseUrl";

const RETRY_DELAYS_MS = [350, 1200] as const;

export function resolveMediaUrl(src?: string | null) {
  if (!src) return "";
  if (
    src.startsWith("blob:")
    || src.startsWith("data:")
    || src.startsWith("http://")
    || src.startsWith("https://")
  ) return src;
  return `${API_BASE_URL}${src}`;
}

function addRetryVersion(url: string, attempt: number) {
  if (!url || attempt === 0 || url.startsWith("blob:") || url.startsWith("data:")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}ks_image_retry=${attempt}`;
}

export function useResilientImage(src?: string | null) {
  const originalUrl = useMemo(() => resolveMediaUrl(src), [src]);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">(
    originalUrl ? "loading" : "idle",
  );
  const retryTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    setAttempt(0);
    setStatus(originalUrl ? "loading" : "idle");
    return () => {
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    };
  }, [originalUrl]);

  function markLoaded() {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    setStatus("ready");
  }

  function markFailed() {
    if (!originalUrl) {
      setStatus("idle");
      return;
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      setStatus("loading");
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => {
        setAttempt((current) => current + 1);
      }, RETRY_DELAYS_MS[attempt]);
      return;
    }
    setStatus("failed");
  }

  function retryNow() {
    if (!originalUrl) return;
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    setStatus("loading");
    setAttempt((current) => current + 1);
  }

  return {
    originalUrl,
    requestUrl: addRetryVersion(originalUrl, attempt),
    status,
    ready: status === "ready",
    failed: status === "failed",
    markLoaded,
    markFailed,
    retryNow,
  };
}
