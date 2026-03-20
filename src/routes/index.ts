import { Router } from 'express';
import { ScannerService } from '../modules/scanner/scanner.service';
import { ScannerController } from '../modules/scanner/scanner.controller';
import { createScannerRouter } from '../modules/scanner/scanner.routes';

const router = Router();

const scannerService    = new ScannerService();
const scannerController = new ScannerController(scannerService);

router.use('/scanner', createScannerRouter(scannerController));

export { router as mainRouter };
