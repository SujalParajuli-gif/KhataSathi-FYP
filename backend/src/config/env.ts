function parseOriginList(value?: string) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function getAllowedCorsOrigins() {
  const configured = parseOriginList(
    process.env.CORS_ORIGINS || process.env.FRONTEND_BASE_URL,
  );

  if (process.env.NODE_ENV === "production") {
    if (configured.length > 0) {
      return configured;
    }

    throw new Error(
      "FRONTEND_BASE_URL or CORS_ORIGINS is required in production.",
    );
  }

  return Array.from(new Set([
    ...configured,
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
  ]));
}

export function getRateLimitConfig() {
  return {
    loginLimitPerMinute: Number(process.env.LOGIN_RATE_LIMIT_PER_MINUTE || 5),
    apiLimitPerWindow: Number(process.env.API_RATE_LIMIT_REQUESTS || 600),
    backgroundLimitPerWindow: Number(
      process.env.BACKGROUND_RATE_LIMIT_REQUESTS || 200,
    ),
    mediaLimitPerWindow: Number(
      process.env.MEDIA_RATE_LIMIT_REQUESTS || 600,
    ),
    apiWindowMinutes: Number(process.env.API_RATE_LIMIT_WINDOW_MINUTES || 15),
  };
}

export function getSessionConfig() {
  const ttlHours = Number(process.env.SESSION_TTL_HOURS || 168);
  if (!Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > 24 * 30) {
    throw new Error("SESSION_TTL_HOURS must be between 1 and 720 hours.");
  }
  const configuredSecret = process.env.SESSION_SECRET?.trim();
  if (process.env.NODE_ENV === "production" && !configuredSecret) {
    throw new Error("SESSION_SECRET is required in production.");
  }
  const sessionSecret =
    configuredSecret || "khatasathi-local-development-session-secret-change-me";
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }

  return {
    ttlHours,
    secureCookies: process.env.NODE_ENV === "production",
    sessionSecret,
  };
}
