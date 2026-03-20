import { Router } from 'express';
import { ScannerController } from './scanner.controller';
import { validate } from './scanner.validation';
import {
  pingSchema,
  testConnectionSchema,
  hardwareSchema,
  softwareSchema,
  fullScanSchema,
} from './scanner.validation';

export function createScannerRouter(controller: ScannerController): Router {
  const router = Router();

  router.get('/methods', controller.getMethods);

  router.post('/ping',            validate(pingSchema),            controller.ping);
  router.post('/test-connection', validate(testConnectionSchema),  controller.testConnection);
  router.post('/hardware',        validate(hardwareSchema),        controller.fetchHardware);
  router.post('/software',        validate(softwareSchema),        controller.fetchSoftware);
  router.post('/scan',            validate(fullScanSchema),        controller.fullScan);

  return router;
}
