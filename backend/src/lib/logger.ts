type LogMeta = Record<string, unknown>;

function serializeError(error: unknown) {
  if (!(error instanceof Error)) {
    return error;
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

function writeLog(level: "info" | "warn" | "error", message: string, meta?: LogMeta) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta } : {}),
  };

  const line = JSON.stringify(payload, (_key, value) =>
    value instanceof Error ? serializeError(value) : value,
  );

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

export const logger = {
  info(message: string, meta?: LogMeta) {
    writeLog("info", message, meta);
  },
  warn(message: string, meta?: LogMeta) {
    writeLog("warn", message, meta);
  },
  error(message: string, error?: unknown, meta?: LogMeta) {
    writeLog("error", message, {
      ...(meta || {}),
      ...(error === undefined ? {} : { error: serializeError(error) }),
    });
  },
};
