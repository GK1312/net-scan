import {
  ScanMethod,
  ScanCredentials,
  ConnectionTestResult,
  HardwareInfo,
  SoftwareEntry,
} from '../../../types/scanner.types';
import { AppError, ErrorCode } from '../../../utils/app-error.util';
import { parsePsOutput } from '../../../utils/powershell.util';

export abstract class BaseMethod {
  abstract readonly methodName: ScanMethod;

  abstract testConnection(
    target: string,
    credentials: ScanCredentials,
  ): Promise<ConnectionTestResult>;

  abstract fetchHardwareInfo(
    target: string,
    credentials: ScanCredentials,
  ): Promise<HardwareInfo>;

  abstract fetchSoftwareInfo(
    target: string,
    credentials: ScanCredentials,
  ): Promise<SoftwareEntry[]>;

  protected parseJson<T>(raw: string, context: string): T {
    return parsePsOutput<T>(raw, context);
  }

  protected assertSuccess(result: { exitCode: number; stderr: string }, context: string): void {
    if (result.exitCode !== 0) {
      throw new AppError(
        500,
        ErrorCode.PS_EXECUTION_FAILED,
        `PowerShell returned exit code ${result.exitCode}`,
        { context, stderr: result.stderr.slice(0, 500) },
      );
    }
  }
}
