/**
 * node-wmi utility — wraps the `node-wmi` npm package with Promise-based helpers.
 *
 * node-wmi queries Windows WMI over DCOM — PowerShell-independent, no temp files,
 * no spawned helper processes.  Credentials are passed through the WMI COM API
 * in-memory (never in process arguments or written to disk).
 *
 * Remote requirements (same as the VBScript WMI method):
 *   - Port 135 (RPC endpoint mapper) + dynamic high ports (49152-65535)
 *   - Services: WMI, Remote Registry running on target
 *   - Firewall: "Windows Management Instrumentation (WMI)" exception enabled
 */
import { Query } from 'node-wmi';
import { AppError, ErrorCode } from './app-error.util';
import { logger } from '../config/logger.config';

// ─── Query helper ─────────────────────────────────────────────────────────────

export interface WmiQueryOptions {
  host: string;
  username: string;
  password: string;
  wmiClass: string;
  properties: string[];
  /** WQL WHERE clause, e.g. "DriveType=3" or "IPEnabled=True" */
  where?: string;
  /** Defaults to root\\CIMV2 */
  namespace?: string;
  timeoutMs?: number;
  context?: string;
}

/**
 * Executes a remote WMI query via the node-wmi package.
 * Returns a Promise that resolves with the result rows.
 */
export function wmiQuery(opts: WmiQueryOptions): Promise<Record<string, unknown>[]> {
  const {
    host, username, password, wmiClass, properties,
    where, namespace, timeoutMs = 30_000, context,
  } = opts;

  // node-wmi wraps credentials with single quotes when building the wmic.exe
  // command line (e.g. /USER:'it techvits').  Windows does not treat single
  // quotes as string delimiters, so a username containing a space causes wmic
  // to split the argument and report "Alias not found".  Use the "wmi"
  // (VBScript) or "powershell" method instead for accounts with spaces.
  if (username.includes(' ')) {
    return Promise.reject(new AppError(
      503,
      ErrorCode.PS_EXECUTION_FAILED,
      `node-wmi does not support usernames with spaces ("${username}"). ` +
      `Use the "wmi" (VBScript) or "powershell" scan method instead.`,
    ));
  }

  return new Promise((resolve, reject) => {
    logger.debug('node-wmi query', { context, host, class: wmiClass });

    const timer = setTimeout(() => {
      reject(new AppError(
        504,
        ErrorCode.PS_TIMEOUT,
        `node-wmi timed out: ${wmiClass} on ${host}`,
      ));
    }, timeoutMs);

    Query(
      {
        class:      wmiClass,
        host,
        username,
        password,
        namespace:  namespace ?? 'root\\CIMV2',
        properties,
        ...(where ? { where } : {}),
      },
      (err, result) => {
        clearTimeout(timer);
        if (err) {
          reject(new AppError(
            503,
            ErrorCode.PS_EXECUTION_FAILED,
            `node-wmi query failed for ${wmiClass}: ${err.message}`,
          ));
          return;
        }
        resolve(result ?? []);
      },
    );
  });
}

// ─── Value coercion helpers ────────────────────────────────────────────────────

export function safeStr(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

export function safeNum(val: unknown): number {
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

export function safeBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1';
  return Boolean(val);
}

/**
 * Converts a DMTF datetime string (WMI format "YYYYMMDDHHmmss.xxxxxx+TZO")
 * to an ISO-8601 string.  Returns '' if the input isn't a valid DMTF string.
 */
export function dmtfToIso(raw: unknown): string {
  const s = safeStr(raw);
  if (s.length < 14) return '';
  const y  = s.slice(0, 4);
  const mo = s.slice(4, 6);
  const d  = s.slice(6, 8);
  const h  = s.slice(8, 10);
  const mi = s.slice(10, 12);
  const sc = s.slice(12, 14);
  return `${y}-${mo}-${d}T${h}:${mi}:${sc}`;
}
