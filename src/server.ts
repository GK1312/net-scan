import "dotenv/config";
import os from "os";
import http from "http";
import { createApp } from "./app";
import { appConfig } from "./config/app.config";
import { logger } from "./config/logger.config";

const app = createApp();
const server = http.createServer(app);

server.listen(appConfig.port, () => {
  logger.info("Server started", {
    port: appConfig.port,
    env: appConfig.env,
    logLevel: appConfig.log.level,
    logDir: appConfig.log.dir,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    hostname: os.hostname(),
    pid: process.pid,
  });

  if (process.platform !== "win32") {
    logger.info(
      "Linux deployment detected — WMI and node-wmi methods are disabled. SSH and PowerShell methods are available.",
    );
  }
});

function gracefulShutdown(signal: string): void {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason });
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { err });
  process.exit(1);
});
