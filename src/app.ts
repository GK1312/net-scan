import express, { Express, Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { appConfig } from "./config/app.config";
import { requestLoggerMiddleware } from "./middleware/request-logger.middleware";
import { errorMiddleware } from "./middleware/error.middleware";
import { notFoundMiddleware } from "./middleware/not-found.middleware";
import { mainRouter } from "./routes/index";

export function createApp(): Express {
  const app = express();

  // ── Security headers ────────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS ────────────────────────────────────────────────────────────────
  app.use(
    cors({
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  );

  // ── Body parsing ────────────────────────────────────────────────────────
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // ── Rate limiting ───────────────────────────────────────────────────────
  app.use(
    rateLimit({
      windowMs: appConfig.rateLimit.windowMs,
      max: appConfig.rateLimit.max,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        message: "Too many requests, please try again later.",
      },
    }),
  );

  // ── Request logging ─────────────────────────────────────────────────────
  app.use(requestLoggerMiddleware);

  // ── Health check ────────────────────────────────────────────────────────
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      env: appConfig.env,
      timestamp: new Date().toISOString(),
    });
  });

  // ── API routes ──────────────────────────────────────────────────────────
  app.use("/api/v1", mainRouter);

  // ── 404 handler ─────────────────────────────────────────────────────────
  app.use(notFoundMiddleware);

  // ── Global error handler ────────────────────────────────────────────────
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) =>
    errorMiddleware(err, req, res, next),
  );

  return app;
}
