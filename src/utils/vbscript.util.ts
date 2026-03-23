/**
 * VBScript execution utility — PowerShell independent.
 * Scripts run via cscript.exe with credentials embedded in the script body
 * (written to a temp file), so nothing sensitive appears in process args.
 */
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { ScanCredentials, PsExecutionOptions, PsExecutionResult } from '../types/scanner.types';
import { AppError, ErrorCode } from './app-error.util';
import { logger } from '../config/logger.config';

/**
 * Escapes a value for safe embedding inside a VBScript double-quoted string.
 * In VBScript the only special character inside "" is the double-quote itself,
 * which is represented by doubling it: " → ""
 */
export function escapeVbsString(value: string): string {
  return value.replace(/"/g, '""');
}

/**
 * Returns the three credential lines to inject at the top of every VBScript.
 * Credentials are embedded in the script body, never in process args.
 */
export function buildVbsCredentialBlock(target: string, creds: ScanCredentials): string {
  const user = creds.domain
    ? `${creds.domain}\\${creds.username}`
    : creds.username;

  return (
    `Dim sTarget, sUser, sPass\n` +
    `sTarget = "${escapeVbsString(target)}"\n` +
    `sUser   = "${escapeVbsString(user)}"\n` +
    `sPass   = "${escapeVbsString(creds.password)}"\n`
  );
}

/**
 * Writes a VBScript to a uniquely-named temp file, executes it via cscript.exe,
 * then immediately deletes the temp file regardless of outcome.
 */
export function executeVBScript(
  script: string,
  options: PsExecutionOptions,
): Promise<PsExecutionResult> {
  const { timeoutMs, context = 'vbs-exec' } = options;
  const scriptPath = join(tmpdir(), `ns-${uuidv4()}.vbs`);

  return new Promise((resolve, reject) => {
    try {
      writeFileSync(scriptPath, script, { encoding: 'utf8' });
    } catch (err) {
      reject(new AppError(500, ErrorCode.PS_EXECUTION_FAILED,
        `Failed to write VBScript temp file: ${(err as Error).message}`,
        { context },
      ));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(
      'cscript',
      ['//NoLogo', '//E:vbscript', scriptPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d));

    function cleanup(): void {
      try { unlinkSync(scriptPath); } catch { /* best effort */ }
    }

    const timer = setTimeout(() => {
      child.kill();
      cleanup();
      reject(new AppError(504, ErrorCode.PS_TIMEOUT,
        `VBScript timed out after ${timeoutMs}ms`, { context }));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();

      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trimEnd();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trimEnd();

      if (stderr) {
        logger.warn('VBScript stderr', { context, stderr: stderr.slice(0, 500) });
      }

      // Surface stderr in the result so callers can see the actual cscript error
      // when stdout is empty (e.g. Option Explicit compile errors, syntax errors).
      if (!stdout && stderr) {
        resolve({ stdout: `{"__error":${JSON.stringify(stderr.trim().slice(0, 500))}}`, stderr, exitCode: code ?? 1 });
        return;
      }

      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(new AppError(500, ErrorCode.PS_EXECUTION_FAILED,
        `Failed to spawn cscript: ${err.message}`, { context }));
    });
  });
}
