import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError, ErrorCode } from "../utils/app-error.util";
import { failureResponse, buildMeta } from "../utils/response.util";
import { logger } from "../config/logger.config";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId =
    (res.locals["requestId"] as string | undefined) ?? "unknown";
  const startTime =
    (res.locals["startTime"] as number | undefined) ?? Date.now();
  const meta = buildMeta(requestId, startTime);

  if (err instanceof AppError) {
    logger.warn("Application error", {
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      details: err.details,
      stack: err.stack,
      path: req.path,
      method: req.method,
      requestId,
    });
    res
      .status(err.statusCode)
      .json(failureResponse(err.code, err.message, meta, err.details));
    return;
  }

  if (err instanceof ZodError) {
    const issues = err.flatten();
    logger.warn("Validation error", {
      path: req.path,
      method: req.method,
      requestId,
      issues,
    });
    res
      .status(400)
      .json(
        failureResponse(
          ErrorCode.VALIDATION_ERROR,
          "Request validation failed",
          meta,
          { issues },
        ),
      );
    return;
  }

  const message = err instanceof Error ? err.message : "Unexpected error";
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error("Unhandled error", {
    message,
    stack,
    path: req.path,
    method: req.method,
    requestId,
    err: err instanceof Error ? undefined : err,
  });
  res
    .status(500)
    .json(failureResponse(ErrorCode.INTERNAL_ERROR, message, meta));
}
