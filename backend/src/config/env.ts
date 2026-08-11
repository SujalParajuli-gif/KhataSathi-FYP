import path from "path";

function parseOriginList(value?: string) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function productionEnvironmentProblems(
  env: NodeJS.ProcessEnv,
) {
  const problems: string[] = [];
  if (env.NODE_ENV !== "production") return problems;

  let databaseUrl: URL | null = null;
  try {
    databaseUrl = new URL(String(env.DATABASE_URL || ""));
  } catch {
    problems.push("DATABASE_URL must be a valid MySQL connection URL.");
  }
  if (databaseUrl) {
    if (databaseUrl.protocol !== "mysql:") {
      problems.push("DATABASE_URL must use the mysql protocol.");
    }
    if (!databaseUrl.username || !databaseUrl.password || !databaseUrl.pathname.slice(1)) {
      problems.push("DATABASE_URL must include an application user, password, and database.");
    }
    if (databaseUrl.username.toLowerCase() === "root") {
      problems.push("DATABASE_URL must not use the MySQL root account in production.");
    }
  }

  const sessionSecret = String(env.SESSION_SECRET || "");
  if (sessionSecret.length < 32) {
    problems.push("SESSION_SECRET must contain at least 32 characters.");
  }

  const origins = parseOriginList(env.CORS_ORIGINS || env.FRONTEND_BASE_URL);
  if (origins.length === 0) {
    problems.push("FRONTEND_BASE_URL or CORS_ORIGINS is required in production.");
  }
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (parsed.protocol !== "https:" && !local) {
        problems.push(`Production origin must use HTTPS: ${origin}`);
      }
    } catch {
      problems.push(`Invalid production origin: ${origin}`);
    }
  }

  if (env.TZ !== "Asia/Kathmandu") {
    problems.push("TZ must be Asia/Kathmandu for shop schedules and business dates.");
  }
  for (const variable of [
    "UPLOADS_ROOT",
    "DOCUMENT_STORAGE_ROOT",
    "BACKUP_ROOT",
    "BACKUP_STATUS_ROOT",
  ] as const) {
    const value = String(env[variable] || "").trim();
    if (!value || !path.isAbsolute(value)) {
      problems.push(`${variable} must be an explicit absolute path in production.`);
    }
  }
  return problems;
}

export function validateProductionEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const problems = productionEnvironmentProblems(env);
  if (problems.length > 0) {
    throw new Error(`Invalid production environment:\n- ${problems.join("\n- ")}`);
  }
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
