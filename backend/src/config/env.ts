import type { SignOptions } from "jsonwebtoken";

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. Set it in the backend environment.`);
  }
  return value;
}

function parseOriginList(value?: string) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export const JWT_SECRET = requireEnv("JWT_SECRET");
export const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN ||
  "8h") as SignOptions["expiresIn"];

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
    apiLimitPerWindow: Number(process.env.API_RATE_LIMIT_REQUESTS || 300),
    apiWindowMinutes: Number(process.env.API_RATE_LIMIT_WINDOW_MINUTES || 15),
  };
}
