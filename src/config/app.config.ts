export const appConfig = {
  env: process.env["NODE_ENV"] ?? "development",
  port: parseInt(process.env["PORT"] ?? "3000", 10),

  log: {
    level: process.env["LOG_LEVEL"] ?? "info",
    dir: process.env["LOG_DIR"] ?? "./logs",
  },

  ps: {
    executionTimeoutMs: parseInt(
      process.env["PS_EXECUTION_TIMEOUT_MS"] ?? "60000",
      10,
    ),
    // 30 s default: PowerShell 7 on Linux takes ~3-4 s to start, plus WinRM
    // TCP handshake and NTLM auth.  10 s is consistently too short.
    connectTimeoutMs: parseInt(
      process.env["PS_CONNECT_TIMEOUT_MS"] ?? "30000",
      10,
    ),
  },

  rateLimit: {
    windowMs: parseInt(process.env["RATE_LIMIT_WINDOW_MS"] ?? "60000", 10),
    max: parseInt(process.env["RATE_LIMIT_MAX"] ?? "100", 10),
  },

  corsOrigins: (process.env["CORS_ORIGINS"] ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
} as const;

export type AppConfig = typeof appConfig;
