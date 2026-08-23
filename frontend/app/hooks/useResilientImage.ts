import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "~/lib/api/baseUrl";

const RETRY_DELAYS_MS = [350, 1200] as const;

type ImageStatus = "idle" | "loading" | "ready" | "failed";

type ImageState = {
  candidatesKey: string;
  sourceIndex: number;
  attempt: number;
  status: ImageStatus;
};

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

function createState(candidatesKey: string, hasImage: boolean): ImageState {
  return {
    candidatesKey,
    sourceIndex: 0,
    attempt: 0,
    status: hasImage ? "loading" : "idle",
  };
}

function absoluteBrowserUrl(url: string) {
  if (!url || typeof window === "undefined") return url;
  return new URL(url, window.location.href).href;
}

export function useResilientImage(
  src?: string | null,
  fallbackSrc?: string | null,
) {
  const candidates = useMemo(() => {
    const urls = [resolveMediaUrl(src), resolveMediaUrl(fallbackSrc)].filter(Boolean);
    return [...new Set(urls)];
  }, [src, fallbackSrc]);
  const candidatesKey = candidates.join("\n");
  const originalUrl = candidates[0] || "";
  const [state, setState] = useState<ImageState>(() => (
    createState(candidatesKey, Boolean(originalUrl))
  ));
  const retryTimerRef = useRef<number | null>(null);
  const imageElementRef = useRef<HTMLImageElement | null>(null);

  // Treat a new URL set as a new image immediately. This derived value prevents
  // one render of stale "ready" state while the synchronization effect runs.
  const currentState = state.candidatesKey === candidatesKey
    ? state
    : createState(candidatesKey, Boolean(originalUrl));
  const activeUrl = candidates[currentState.sourceIndex] || "";
  const requestUrl = addRetryVersion(activeUrl, currentState.attempt);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const normalizeState = useCallback((value: ImageState) => (
    value.candidatesKey === candidatesKey
      ? value
      : createState(candidatesKey, Boolean(originalUrl))
  ), [candidatesKey, originalUrl]);

  const eventBelongsToCurrentRequest = useCallback((element?: HTMLImageElement | null) => {
    if (!element || !requestUrl) return true;
    const expectedUrl = absoluteBrowserUrl(requestUrl);
    return element.currentSrc === expectedUrl || element.src === expectedUrl;
  }, [requestUrl]);

  useEffect(() => {
    if (state.candidatesKey === candidatesKey) return;
    clearRetryTimer();
    setState(createState(candidatesKey, Boolean(originalUrl)));
  }, [candidatesKey, clearRetryTimer, originalUrl, state.candidatesKey]);

  useEffect(() => () => clearRetryTimer(), [clearRetryTimer]);

  const markLoaded = useCallback((event?: { currentTarget: HTMLImageElement }) => {
    if (event && !eventBelongsToCurrentRequest(event.currentTarget)) return;
    clearRetryTimer();
    setState((value) => {
      const normalized = normalizeState(value);
      const nextStatus = candidates[normalized.sourceIndex] ? "ready" : "idle";
      if (normalized === value && normalized.status === nextStatus) return value;
      return {
        ...normalized,
        status: nextStatus,
      };
    });
  }, [candidates, clearRetryTimer, eventBelongsToCurrentRequest, normalizeState]);

  const markFailed = useCallback((event?: { currentTarget: HTMLImageElement }) => {
    if (event && !eventBelongsToCurrentRequest(event.currentTarget)) return;
    const failedState = currentState;
    const failedUrl = candidates[failedState.sourceIndex] || "";

    if (failedState.status === "failed") return;
    if (failedState.status === "loading" && retryTimerRef.current !== null) return;

    if (!failedUrl) {
      setState((value) => ({ ...normalizeState(value), status: "idle" }));
      return;
    }

    if (failedState.attempt < RETRY_DELAYS_MS.length) {
      clearRetryTimer();
      setState((value) => ({ ...normalizeState(value), status: "loading" }));
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        setState((value) => {
          const normalized = normalizeState(value);
          if (
            normalized.status === "ready"
            || normalized.sourceIndex !== failedState.sourceIndex
            || normalized.attempt !== failedState.attempt
          ) return normalized;
          return { ...normalized, attempt: normalized.attempt + 1, status: "loading" };
        });
      }, RETRY_DELAYS_MS[failedState.attempt]);
      return;
    }

    if (failedState.sourceIndex < candidates.length - 1) {
      clearRetryTimer();
      setState((value) => {
        const normalized = normalizeState(value);
        return {
          ...normalized,
          sourceIndex: normalized.sourceIndex + 1,
          attempt: 0,
          status: "loading",
        };
      });
      return;
    }

    clearRetryTimer();
    setState((value) => ({ ...normalizeState(value), status: "failed" }));
  }, [candidates, clearRetryTimer, currentState, eventBelongsToCurrentRequest, normalizeState]);

  const retryNow = useCallback(() => {
    if (!activeUrl) return;
    clearRetryTimer();
    setState((value) => {
      const normalized = normalizeState(value);
      return {
        ...normalized,
        attempt: 0,
        status: "loading",
      };
    });
  }, [activeUrl, clearRetryTimer, normalizeState]);

  // Cached images can finish between the DOM commit and the effect that normally
  // observes onLoad. Checking the element closes that race without refetching it.
  useEffect(() => {
    const element = imageElementRef.current;
    if (!element?.complete || !requestUrl || !eventBelongsToCurrentRequest(element)) return;
    if (element.naturalWidth > 0) markLoaded({ currentTarget: element });
    else markFailed({ currentTarget: element });
  }, [eventBelongsToCurrentRequest, markFailed, markLoaded, requestUrl]);

  return {
    imageRef: imageElementRef,
    originalUrl,
    activeUrl,
    requestUrl,
    status: currentState.status,
    ready: currentState.status === "ready",
    failed: currentState.status === "failed",
    loading: currentState.status === "loading",
    missing: currentState.status === "idle",
    usingFallback: currentState.sourceIndex > 0,
    markLoaded,
    markFailed,
    retryNow,
  };
}
