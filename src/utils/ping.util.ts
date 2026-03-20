import { spawn } from 'child_process';
import { PingResult } from '../types/scanner.types';

const LATENCY_REGEX_WIN  = /[Aa]verage\s*=\s*(\d+)ms/;
const LATENCY_REGEX_UNIX = /time[<=](\d+(?:\.\d+)?)\s*ms/;

export function pingHost(target: string, timeoutMs = 5000): Promise<PingResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const args = isWindows
      ? ['-n', '1', '-w', String(timeoutMs), target]
      : ['-c', '1', '-W', String(Math.ceil(timeoutMs / 1000)), target];

    const chunks: Buffer[] = [];
    const child = spawn('ping', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => chunks.push(d));

    const timer = setTimeout(() => {
      child.kill();
      resolve({ alive: false, target, rawOutput: 'timeout' });
    }, timeoutMs + 2000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');

      // On Windows, ping exits 0 even for "Destination host unreachable" or
      // "Request timed out" — check output text to detect these false positives.
      const unreachable = /destination host unreachable|request timed out|could not find host/i.test(raw);
      const alive = code === 0 && !unreachable;

      let latencyMs: number | undefined;
      const matchWin  = LATENCY_REGEX_WIN.exec(raw);
      const matchUnix = LATENCY_REGEX_UNIX.exec(raw);
      if (matchWin?.[1])  latencyMs = parseInt(matchWin[1], 10);
      if (matchUnix?.[1]) latencyMs = parseFloat(matchUnix[1]);

      resolve({ alive, target, ...(latencyMs !== undefined ? { latencyMs } : {}), rawOutput: raw });
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ alive: false, target, rawOutput: 'spawn error' });
    });
  });
}
