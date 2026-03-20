import { Request, Response } from 'express';
import { failureResponse, buildMeta } from '../utils/response.util';

export function notFoundMiddleware(req: Request, res: Response): void {
  const requestId = (res.locals['requestId'] as string | undefined) ?? 'unknown';
  const startTime = (res.locals['startTime'] as number | undefined) ?? Date.now();

  res.status(404).json(
    failureResponse(
      'NOT_FOUND',
      `Cannot ${req.method} ${req.path}`,
      buildMeta(requestId, startTime),
    ),
  );
}
