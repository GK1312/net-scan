import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../config/logger.config';

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = uuidv4();
  const startTime = Date.now();

  res.locals['requestId'] = requestId;
  res.locals['startTime'] = startTime;

  res.on('finish', () => {
    logger.info('HTTP request', {
      method:    req.method,
      path:      req.path,
      status:    res.statusCode,
      duration:  Date.now() - startTime,
      requestId,
      ip:        req.ip,
    });
  });

  next();
}
