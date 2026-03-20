import { Request, Response, NextFunction } from 'express';
import { ScannerService } from './scanner.service';
import { getAvailableMethods } from './methods/method.factory';
import { successResponse, buildMeta } from '../../utils/response.util';
import {
  PingPayload,
  TestConnectionPayload,
  HardwarePayload,
  SoftwarePayload,
  FullScanPayload,
} from './scanner.validation';
import { ApiMeta } from '../../types/api.types';

function getMeta(res: Response): ApiMeta {
  return buildMeta(
    (res.locals['requestId'] as string | undefined) ?? 'unknown',
    (res.locals['startTime'] as number | undefined) ?? Date.now(),
  );
}

export class ScannerController {
  constructor(private readonly service: ScannerService) {}

  getMethods = (_req: Request, res: Response): void => {
    res.json(
      successResponse(getAvailableMethods(), 'Available scanning methods', getMeta(res)),
    );
  };

  ping = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { target } = req.body as PingPayload;
      const data = await this.service.ping(target);
      res.json(successResponse(data, 'Ping completed', getMeta(res)));
    } catch (err) {
      next(err);
    }
  };

  testConnection = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { target, method, credentials } = req.body as TestConnectionPayload;
      const data = await this.service.testConnection(target, method, credentials);
      res.json(successResponse(data, 'Connection test successful', getMeta(res)));
    } catch (err) {
      next(err);
    }
  };

  fetchHardware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { target, method, credentials } = req.body as HardwarePayload;
      const data = await this.service.fetchHardware(target, method, credentials);
      res.json(successResponse(data, 'Hardware information retrieved', getMeta(res)));
    } catch (err) {
      next(err);
    }
  };

  fetchSoftware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { target, method, credentials } = req.body as SoftwarePayload;
      const data = await this.service.fetchSoftware(target, method, credentials);
      res.json(
        successResponse(
          { hostname: target, count: data.length, software: data },
          'Software information retrieved',
          getMeta(res),
        ),
      );
    } catch (err) {
      next(err);
    }
  };

  fullScan = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as FullScanPayload;
      const data = await this.service.fullScan({
        target:          body.target,
        method:          body.method,
        credentials:     body.credentials,
        skipPing:        body.skipPing,
        skipSoftware:    body.skipSoftware,
        continueOnError: body.continueOnError,
      });

      const hasErrors = Object.keys(data.errors).length > 0;
      res.json(
        successResponse(
          data,
          hasErrors ? 'Scan completed with some errors' : 'Scan completed successfully',
          getMeta(res),
        ),
      );
    } catch (err) {
      next(err);
    }
  };
}
