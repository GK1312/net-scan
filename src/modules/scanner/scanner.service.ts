import {
  ScanMethod,
  ScanCredentials,
  PingResult,
  ConnectionTestResult,
  HardwareInfo,
  SoftwareEntry,
  ScanResult,
  FullScanOptions,
} from '../../types/scanner.types';
import { pingHost } from '../../utils/ping.util';
import { getMethod } from './methods/method.factory';
import { AppError, ErrorCode } from '../../utils/app-error.util';
import { logger } from '../../config/logger.config';

function extractMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ScannerService {
  async ping(target: string): Promise<PingResult> {
    logger.debug('Pinging target', { target });
    return pingHost(target);
  }

  async testConnection(
    target: string,
    method: ScanMethod,
    credentials: ScanCredentials,
  ): Promise<ConnectionTestResult> {
    logger.debug('Testing connection', { target, method });
    const handler = getMethod(method);
    return handler.testConnection(target, credentials);
  }

  async fetchHardware(
    target: string,
    method: ScanMethod,
    credentials: ScanCredentials,
  ): Promise<HardwareInfo> {
    logger.debug('Fetching hardware info', { target, method });
    return getMethod(method).fetchHardwareInfo(target, credentials);
  }

  async fetchSoftware(
    target: string,
    method: ScanMethod,
    credentials: ScanCredentials,
  ): Promise<SoftwareEntry[]> {
    logger.debug('Fetching software info', { target, method });
    return getMethod(method).fetchSoftwareInfo(target, credentials);
  }

  async fullScan(options: FullScanOptions): Promise<ScanResult> {
    const { target, method, credentials, skipPing, skipSoftware, continueOnError } = options;

    const result: ScanResult = {
      target,
      method,
      pingSuccess:       false,
      connectionSuccess: false,
      errors:            {},
      startedAt:         new Date().toISOString(),
      completedAt:       '',
    };

    logger.info('Starting full scan', { target, method, skipPing, skipSoftware });

    // ── Step 1: Ping ────────────────────────────────────────────────────────
    if (!skipPing) {
      try {
        const ping = await pingHost(target);
        result.pingSuccess = ping.alive;

        if (!ping.alive) {
          const msg = `Host ${target} did not respond to ping`;
          result.errors['ping'] = msg;
          if (!continueOnError) {
            throw new AppError(503, ErrorCode.PING_FAILED, msg);
          }
          logger.warn('Ping failed, continuing', { target });
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        result.errors['ping'] = extractMessage(err);
        if (!continueOnError) throw err;
      }
    } else {
      result.pingSuccess = true;
    }

    // ── Step 2: Test Connection ─────────────────────────────────────────────
    try {
      const conn = await getMethod(method).testConnection(target, credentials);
      result.connectionSuccess = conn.success;

      if (!conn.success) {
        const msg = conn.error ?? 'Connection test failed';
        result.errors['connection'] = msg;
        if (!continueOnError) {
          throw new AppError(503, ErrorCode.CONNECTION_FAILED, msg);
        }
        logger.warn('Connection test failed, continuing', { target, method });
      }
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.CONNECTION_FAILED) throw err;
      result.errors['connection'] = extractMessage(err);
      if (!continueOnError) throw err;
    }

    // Always stop if connection failed — hardware/software cannot be fetched
    // without an active connection regardless of continueOnError
    if (!result.connectionSuccess) {
      result.completedAt = new Date().toISOString();
      return result;
    }

    // ── Step 3: Hardware Info ───────────────────────────────────────────────
    try {
      result.hardware = await getMethod(method).fetchHardwareInfo(target, credentials);
    } catch (err) {
      result.errors['hardware'] = extractMessage(err);
      logger.warn('Hardware fetch failed', { target, method, error: extractMessage(err) });
      if (!continueOnError) throw err;
    }

    // ── Step 4: Software Info ───────────────────────────────────────────────
    if (!skipSoftware) {
      try {
        result.software = await getMethod(method).fetchSoftwareInfo(target, credentials);
      } catch (err) {
        result.errors['software'] = extractMessage(err);
        logger.warn('Software fetch failed', { target, method, error: extractMessage(err) });
        if (!continueOnError) throw err;
      }
    }

    result.completedAt = new Date().toISOString();
    logger.info('Full scan complete', {
      target,
      method,
      hardwareOk: !!result.hardware,
      softwareCount: result.software?.length ?? 0,
      errors: Object.keys(result.errors),
    });

    return result;
  }
}
