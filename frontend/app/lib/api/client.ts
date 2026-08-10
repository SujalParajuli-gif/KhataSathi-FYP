import axios, {
  AxiosError,
  CanceledError,
  type GenericAbortSignal,
  type InternalAxiosRequestConfig,
} from "axios";
import { API_BASE_URL } from "./baseUrl";

type RateLimitRequestConfig = InternalAxiosRequestConfig & {
  _rateLimitRetried?: boolean;
  _routeAtRequest?: string;
};

const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

let rateLimitGate: Promise<void> | null = null;
let openGate: (() => void) | null = null;
let gateTimer: ReturnType<typeof setTimeout> | null = null;
let blockedUntil = 0;
let retrySlotTail: Promise<void> = Promise.resolve();
const rateLimitRetries = new Map<string, Promise<unknown>>();
const inFlightReads = new Map<string, Promise<unknown>>();

function emitRateLimitEvent(retryAfterMs: number) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("rate_limited", {
      detail: { retryAfterMs, blockedUntil },
    }),
  );
}

function releaseGate() {
  const resolve = openGate;
  rateLimitGate = null;
  openGate = null;
  gateTimer = null;
  blockedUntil = 0;
  resolve?.();

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("rate_limit_cleared"));
  }
}

function scheduleGateRelease() {
  if (gateTimer) clearTimeout(gateTimer);
  const waitMs = Math.max(0, blockedUntil - Date.now());
  gateTimer = setTimeout(() => {
    if (Date.now() < blockedUntil) {
      scheduleGateRelease();
      return;
    }
    releaseGate();
  }, waitMs);
}

function closeGate(retryAfterMs: number) {
  // A small grace period prevents the first retry from landing on the exact
  // millisecond boundary of a fixed-window limiter while server and browser
  // clocks/network timing differ slightly.
  const nextBlockedUntil = Date.now() + Math.max(1_000, retryAfterMs) + 500;
  blockedUntil = Math.max(blockedUntil, nextBlockedUntil);

  if (!rateLimitGate) {
    rateLimitGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
  }

  scheduleGateRelease();
  emitRateLimitEvent(Math.max(0, blockedUntil - Date.now()));
  return rateLimitGate;
}

function parseRetryAfter(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1_000, Math.ceil(value * 1_000));
  }

  if (typeof value === "string") {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
      return Math.max(1_000, Math.ceil(seconds * 1_000));
    }

    const retryAt = Date.parse(value);
    if (Number.isFinite(retryAt)) {
      return Math.max(1_000, retryAt - Date.now());
    }
  }

  return 15_000;
}

function readResponseHeader(
  headers: AxiosError["response"] extends { headers: infer T } ? T : unknown,
  name: string,
) {
  if (!headers || typeof headers !== "object") return undefined;
  const candidate = headers as {
    get?: (headerName: string) => unknown;
    [key: string]: unknown;
  };
  return candidate.get?.(name) ?? candidate[name.toLowerCase()] ?? candidate[name];
}

function requestPath(config: InternalAxiosRequestConfig) {
  try {
    return new URL(config.url || "", "http://khatasathi.local").pathname;
  } catch {
    return String(config.url || "").split("?", 1)[0];
  }
}

function currentRoutePath() {
  return typeof window === "undefined" ? "server" : window.location.pathname;
}

function stableSerialize(value: unknown): string {
  if (value instanceof URLSearchParams) return value.toString();
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${key}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return String(value ?? "");
}

function requestKey(config: InternalAxiosRequestConfig) {
  return [
    String(config.method || "get").toUpperCase(),
    requestPath(config),
    stableSerialize(config.params),
    currentRoutePath(),
  ].join("|");
}

function isSharedReferenceRead(config: RateLimitRequestConfig) {
  if (String(config.method || "get").toUpperCase() !== "GET") return false;
  const path = requestPath(config).replace(/\/+$/, "");
  return (
    path === "/api/users" ||
    path === "/api/brands" ||
    path === "/api/products/categories" ||
    path === "/api/settings/business"
  );
}

function isStaleRoute(config: RateLimitRequestConfig) {
  // Shared reference reads feed short-lived endpoint caches and remain useful
  // after navigation. Other queued reads are discarded when their screen is
  // no longer active.
  if (isSharedReferenceRead(config)) return false;
  return Boolean(
    config._routeAtRequest && config._routeAtRequest !== currentRoutePath(),
  );
}

function isSafeRead(config: InternalAxiosRequestConfig) {
  const method = String(config.method || "get").toUpperCase();
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function isBackgroundRequest(config: InternalAxiosRequestConfig) {
  const path = requestPath(config).replace(/\/+$/, "");
  if (
    path === "/api/users/me/presence" ||
    path === "/api/users/cashiers/presence"
  ) {
    return true;
  }
  return String(config.method || "get").toUpperCase() === "GET" &&
    path.startsWith("/api/alerts");
}

function isMediaRequest(config: InternalAxiosRequestConfig) {
  const method = String(config.method || "get").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const path = requestPath(config).replace(/\/+$/, "");
  return /^\/api\/documents\/[^/]+\/file$/.test(path);
}

function isLoginRequest(config: InternalAxiosRequestConfig) {
  return requestPath(config).replace(/\/+$/, "") === "/api/auth/login";
}

function cooldownError(config: InternalAxiosRequestConfig) {
  return new AxiosError(
    "Requests are temporarily paused after a rate limit response.",
    "ERR_RATE_LIMIT_COOLDOWN",
    config,
  );
}

function waitWithAbort(promise: Promise<void>, signal?: GenericAbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new CanceledError("Request cancelled"));
  if (!signal.addEventListener) return promise;

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new CanceledError("Request cancelled"));
    signal.addEventListener?.("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener?.("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener?.("abort", onAbort);
        reject(error);
      },
    );
  });
}

function delayWithAbort(delayMs: number, signal?: GenericAbortSignal) {
  if (signal?.aborted) return Promise.reject(new CanceledError("Request cancelled"));
  return new Promise<void>((resolve, reject) => {
    const onResolve = () => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(onResolve, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CanceledError("Request cancelled"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function waitForRetrySlot(config: RateLimitRequestConfig) {
  const scheduled = retrySlotTail.then(async () => {
    if (isStaleRoute(config)) {
      throw new CanceledError("Request skipped after leaving its route");
    }
    await delayWithAbort(
      125 + Math.floor(Math.random() * 125),
      config.signal,
    );
    if (isStaleRoute(config)) {
      throw new CanceledError("Request skipped after leaving its route");
    }
  });

  retrySlotTail = scheduled.catch(() => undefined);
  return scheduled;
}

export function isRateLimited() {
  return Boolean(rateLimitGate && Date.now() < blockedUntil);
}

export function isRateLimitError(error: unknown) {
  return (
    axios.isAxiosError(error) &&
    (error.response?.status === 429 || error.code === "ERR_RATE_LIMIT_COOLDOWN")
  );
}

api.interceptors.request.use(async (config: RateLimitRequestConfig) => {
  if (typeof window !== "undefined") {
    const method = String(config.method || "get").toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const csrfCookie = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("khatasathi_csrf="));
      if (csrfCookie) {
        config.headers["X-CSRF-Token"] = decodeURIComponent(
          csrfCookie.slice("khatasathi_csrf=".length),
        );
      }
    }
    config._routeAtRequest ||= currentRoutePath();
  }

  if (!isRateLimited()) return config;

  // Polling is expendable. Dropping it prevents a backlog that would fire as
  // soon as the cooldown ends.
  if (isBackgroundRequest(config)) {
    throw new CanceledError("Background refresh skipped during cooldown");
  }

  if (!isSafeRead(config)) {
    throw cooldownError(config);
  }

  // Reads requested by the route currently on screen may wait for recovery,
  // but they are released gradually and are discarded if navigation makes
  // them stale. Mutations never enter this queue.
  config._rateLimitRetried = true;
  await waitWithAbort(rateLimitGate!, config.signal);
  await waitForRetrySlot(config);
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    if (error.response?.status === 429 && error.config) {
      const config = error.config as RateLimitRequestConfig;
      const scope = (error.response.data as { scope?: string } | undefined)?.scope;

      // Login and background buckets are isolated. They must not pause the
      // entire application when their own allowance is exhausted.
      if (
        scope === "login" ||
        scope === "background" ||
        scope === "media" ||
        isMediaRequest(config) ||
        isLoginRequest(config)
      ) {
        return Promise.reject(error);
      }

      const gate = closeGate(
        parseRetryAfter(readResponseHeader(error.response.headers, "Retry-After")),
      );

      if (!isSafeRead(config) || config._rateLimitRetried) {
        return Promise.reject(error);
      }

      const key = requestKey(config);
      const existingRetry = rateLimitRetries.get(key);
      if (existingRetry) return existingRetry;

      config._rateLimitRetried = true;
      const retry = (async () => {
        await waitWithAbort(gate, config.signal);
        await waitForRetrySlot(config);
        return api(config);
      })().finally(() => {
        rateLimitRetries.delete(key);
      });
      rateLimitRetries.set(key, retry);
      return retry;
    }

    if (error.response?.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("khatasathi_token");
      localStorage.removeItem("khatasathi_auth_user");
      if (!window.location.pathname.includes("/login")) {
        window.location.href = "/login";
      }
    }

    if (
      error.response?.status === 428 &&
      (error.response.data as { code?: string } | undefined)?.code ===
        "PASSWORD_CHANGE_REQUIRED" &&
      typeof window !== "undefined" &&
      window.location.pathname !== "/change-password"
    ) {
      window.location.href = "/change-password";
    }

    return Promise.reject(error);
  },
);

// React development mode intentionally verifies effects more than once. Share
// identical signal-free reads that are already in flight so this verification
// cannot double the backend traffic. Search requests retain their AbortSignal
// and continue to use real cancellation instead of this coalescing path.
const originalGet = api.get.bind(api);
api.get = ((url: string, config?: Parameters<typeof api.get>[1]) => {
  if (config?.signal) return originalGet(url, config);

  const key = [
    currentRoutePath(),
    url,
    stableSerialize(config?.params),
    typeof window === "undefined" ? "server" : "browser-session",
  ].join("|");
  const existing = inFlightReads.get(key);
  if (existing) return existing;

  const request = originalGet(url, config).finally(() => {
    inFlightReads.delete(key);
  });
  inFlightReads.set(key, request);
  return request;
}) as typeof api.get;

export default api;
