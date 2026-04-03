import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../config/logger.config";

export function requestLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = uuidv4();
  const startTime = Date.now();

  res.locals["requestId"] = requestId;
  res.locals["startTime"] = startTime;

  res.on("finish", () => {
    const duration = Date.now() - startTime;
    const level =
      res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger.log(level, "HTTP request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      requestId,
      ip: req.ip,
      query: Object.keys(req.query).length ? req.query : undefined,
      body:
        req.body && Object.keys(req.body).length
          ? JSON.stringify(req.body)
          : undefined,
    });
  });

  next();
}
