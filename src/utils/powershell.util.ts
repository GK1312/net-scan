import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { ScanCredentials, PsExecutionOptions, PsExecutionResult } from '../types/scanner.types';
import { AppError, ErrorCode } from './app-error.util';
import { logger } from '../config/logger.config';

/**
 * Escapes a string for safe use inside a PowerShell single-quoted string.
 * In PS single-quoted strings the only special char is ' which becomes ''.
 */
function escapePsString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Builds the credential block that is prepended to every PS script.
 * The credential object is stored in $__cred and target in $__target.
 * Passwords are NEVER passed via process args - only through stdin script body.
 */
export function buildCredentialBlock(target: string, creds: ScanCredentials): string {
  const escapedTarget   = escapePsString(target);
  const escapedUser     = escapePsString(
    creds.domain ? `${creds.domain}\\${creds.username}` : creds.username,
  );
  const escapedPassword = escapePsString(creds.password);

  return `
# PS5.1 COMPATIBLE - do not use PS7-only syntax
$ErrorActionPreference = 'Stop'
$__local    = $false
$__target   = '${escapedTarget}'
$__username = '${escapedUser}'
$__password = ConvertTo-SecureString '${escapedPassword}' -AsPlainText -Force
$__cred     = New-Object System.Management.Automation.PSCredential($__username, $__password)
`;
}

/**
 * Credential block for local-machine scans.
 * Sets $__local = $true so script branches skip WinRM remoting and run
 * WMI queries directly — bypassing WinRM loopback restrictions and UAC
 * remote token filtering that block self-scans via the machine's own IP.
 */
export function buildLocalCredentialBlock(): string {
  return `
# PS5.1 COMPATIBLE - do not use PS7-only syntax
$ErrorActionPreference = 'Stop'
$__local  = $true
$__target = 'localhost'
$__cred   = $null
`;
}

/**
 * Executes a PowerShell script by writing it to a temp file and invoking via -File.
 * Using -File (rather than -Command -) is required for try/catch blocks to work
 * correctly when stdout is piped (Windows PowerShell 5.1 limitation).
 * The temp file is deleted immediately after execution regardless of outcome.
 */
export function executePowerShell(
  script: string,
  options: PsExecutionOptions,
): Promise<PsExecutionResult> {
  const { timeoutMs, context = 'ps-exec' } = options;
  const scriptPath = join(tmpdir(), `ns-${uuidv4()}.ps1`);

  return new Promise((resolve, reject) => {
    try {
      const content = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + script;
      writeFileSync(scriptPath, content, { encoding: 'utf8' });
    } catch (err) {
      reject(new AppError(500, ErrorCode.PS_EXECUTION_FAILED,
        `Failed to write PowerShell temp file: ${(err as Error).message}`,
        { context },
      ));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(
      'powershell.exe',
      ['-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    function cleanup(): void {
      try { unlinkSync(scriptPath); } catch { /* best effort */ }
    }

    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d));

    const timer = setTimeout(() => {
      child.kill();
      cleanup();
      reject(new AppError(504, ErrorCode.PS_TIMEOUT, `PowerShell timed out after ${timeoutMs}ms`, { context }));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();

      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trimEnd();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trimEnd();
      const exitCode = code ?? 1;

      if (stderr) {
        logger.warn('PowerShell stderr output', { context, stderr: stderr.slice(0, 500) });
      }

      resolve({ stdout, stderr, exitCode });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(new AppError(500, ErrorCode.PS_EXECUTION_FAILED, `Failed to spawn PowerShell: ${err.message}`, { context }));
    });
  });
}

/**
 * Parses the JSON output from a PowerShell script.
 * Throws a structured error if parsing fails or if the script returned an error object.
 */
export function parsePsOutput<T>(raw: string, context: string): T {
  const trimmed = raw.trim();

  if (!trimmed) {
    throw new AppError(500, ErrorCode.PARSE_ERROR, `Empty output from PowerShell`, { context });
  }

  let parsed: unknown;
  try {
    // Try direct parse first; fall back to extracting the last JSON object/array
    // (PS/VBS may print warnings before the JSON payload)
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const lastJsonMatch = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])(?=[^{[\]]*$)/);
      if (!lastJsonMatch) throw new Error('no_json_found');
      parsed = JSON.parse(lastJsonMatch[0]);
    }
  } catch (e) {
    const parseMsg = e instanceof SyntaxError ? e.message : String(e);
    throw new AppError(500, ErrorCode.PARSE_ERROR, `Failed to parse PowerShell JSON output`, {
      context,
      parseError: parseMsg,
      raw: trimmed.slice(0, 3000),
    });
  }

  // Check if the script itself returned an error object
  if (parsed && typeof parsed === 'object' && '__error' in (parsed as object)) {
    const errObj = parsed as Record<string, unknown>;
    throw new AppError(500, ErrorCode.PS_EXECUTION_FAILED, String(errObj['__error']), { context });
  }

  return parsed as T;
}
