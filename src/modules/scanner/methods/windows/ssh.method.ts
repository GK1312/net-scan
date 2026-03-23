/**
 * SSH method — no PowerShell, no WMI/DCOM required.
 * Connects via SSH (ssh2) and runs CMD-native commands:
 *   systeminfo  → hardware/OS info
 *   ipconfig /all → network adapters
 *   reg query ... /s → installed software from registry
 *
 * Requirements on target:
 *   - OpenSSH Server installed and running (Windows 10 1809+ optional feature)
 *   - Port 22 accessible
 *
 * Use this method when both PowerShell and WMI/DCOM are blocked.
 */
import { BaseMethod } from '../base.method';
import {
  ScanMethod,
  ScanCredentials,
  ConnectionTestResult,
  HardwareInfo,
  SoftwareEntry,
} from '../../../../types/scanner.types';
import {
  createSshClient,
  execSshCommand,
  parseSystemInfo,
  parseIpConfig,
  parseRegQuery,
  parseWmicDiskOutput,
  parseOsArchFromSystemInfo,
  logSshWarning,
  tcpPortCheck,
  isLocalTarget,
} from '../../../../utils/ssh.util';
import { appConfig } from '../../../../config/app.config';
import { logger } from '../../../../config/logger.config';

const SSH_PORT = 22;

function fullUsername(creds: ScanCredentials): string {
  return creds.domain ? `${creds.domain}\\${creds.username}` : creds.username;
}

export class SshMethod extends BaseMethod {
  readonly methodName = ScanMethod.SSH;

  async testConnection(target: string, credentials: ScanCredentials): Promise<ConnectionTestResult> {
    // Fast TCP pre-check to avoid waiting the full SSH handshake timeout
    const portOpen = await tcpPortCheck(target, SSH_PORT, 3000);
    if (!portOpen) {
      const hint = isLocalTarget(target)
        ? ` — install OpenSSH Server: Settings > Apps > Optional features > "OpenSSH Server"`
        : '';
      return { success: false, target, method: this.methodName, error: `SSH port ${SSH_PORT} is not reachable on ${target}${hint}` };
    }

    try {
      const conn = await createSshClient(
        target,
        fullUsername(credentials),
        credentials.password,
        SSH_PORT,
        appConfig.ps.connectTimeoutMs,
      );
      const { stdout } = await execSshCommand(conn, 'echo connection_ok', 5000);
      conn.end();
      const success = stdout.includes('connection_ok');
      return { success, target, method: this.methodName };
    } catch (err) {
      return {
        success: false,
        target,
        method: this.methodName,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async fetchHardwareInfo(target: string, credentials: ScanCredentials): Promise<HardwareInfo> {
    const context = `${this.methodName}:hardware:${target}`;
    if (!await tcpPortCheck(target, SSH_PORT, 3000)) {
      throw new Error(`SSH port ${SSH_PORT} is not reachable on ${target}`);
    }
    const conn = await createSshClient(
      target,
      fullUsername(credentials),
      credentials.password,
      SSH_PORT,
      appConfig.ps.connectTimeoutMs,
    );

    try {
      // ── systeminfo ─────────────────────────────────────────────────────────
      const { stdout: sysOut } = await execSshCommand(conn, 'systeminfo', appConfig.ps.executionTimeoutMs);
      const hw = parseSystemInfo(sysOut) as HardwareInfo;

      // ── ipconfig /all ──────────────────────────────────────────────────────
      try {
        const { stdout: ipOut } = await execSshCommand(conn, 'ipconfig /all', 15000);
        hw.NetworkAdapters = parseIpConfig(ipOut);

        // Set OsArchitecture from system type string
        hw.OsArchitecture = parseOsArchFromSystemInfo(sysOut);

        // Collect all IPs from adapters
        const allIps = hw.NetworkAdapters.flatMap((a) => a.ipAddresses).filter(Boolean);
        logger.debug('SSH hardware IPs collected', { context, count: allIps.length });
      } catch (err) {
        logSshWarning(context, 'ipconfig', err);
      }

      // ── disk info via wmic (best effort — may not be available) ───────────
      try {
        const { stdout: diskOut, exitCode } = await execSshCommand(
          conn,
          'wmic logicaldisk get Caption,Size,DriveType /format:csv',
          15000,
        );
        if (exitCode === 0 && diskOut.trim()) {
          // Filter DriveType=3 (local disks)
          const csvLines = diskOut.split(/\r?\n/).filter((l) => {
            const parts = l.split(',');
            return parts.length >= 4 && parts[3]?.trim() === '3';
          });
          // Rebuild CSV for parser: Node,Caption,Size
          const adjustedCsv = csvLines.map((l) => {
            const parts = l.split(',');
            return `${parts[0]},${parts[1]},${parts[2]}`;
          }).join('\n');
          hw.Disks = parseWmicDiskOutput(adjustedCsv);
          hw.NumberOfDrives = hw.Disks.length;
        }
      } catch (err) {
        logSshWarning(context, 'wmic disk', err);
      }

      return hw;
    } finally {
      conn.end();
    }
  }

  async fetchSoftwareInfo(target: string, credentials: ScanCredentials): Promise<SoftwareEntry[]> {
    const context = `${this.methodName}:software:${target}`;
    if (!await tcpPortCheck(target, SSH_PORT, 3000)) {
      throw new Error(`SSH port ${SSH_PORT} is not reachable on ${target}`);
    }
    const conn = await createSshClient(
      target,
      fullUsername(credentials),
      credentials.password,
      SSH_PORT,
      appConfig.ps.connectTimeoutMs,
    );

    const allSoftware: SoftwareEntry[] = [];

    const regPaths = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];

    try {
      for (const regPath of regPaths) {
        try {
          const { stdout } = await execSshCommand(
            conn,
            `reg query "${regPath}" /s`,
            appConfig.ps.executionTimeoutMs,
          );
          allSoftware.push(...parseRegQuery(stdout, regPath));
        } catch (err) {
          logSshWarning(context, `reg query ${regPath}`, err);
        }
      }
    } finally {
      conn.end();
    }

    // Deduplicate
    const seen = new Set<string>();
    return allSoftware.filter((e) => {
      const key = `${e.ApplicationName}|${e.Version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
