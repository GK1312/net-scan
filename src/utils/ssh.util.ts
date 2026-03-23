/**
 * SSH utility — used when both PowerShell and WMI/DCOM are blocked.
 * Connects via ssh2, runs CMD commands (systeminfo, reg query, ipconfig),
 * and parses their output into structured data.
 */
import { createConnection } from 'net';
import { networkInterfaces } from 'os';
import { Client, ConnectConfig } from 'ssh2';
import {
  HardwareInfo,
  NetworkAdapterInfo,
  SoftwareEntry,
  DiskInfo,
} from '../types/scanner.types';
import { AppError, ErrorCode } from './app-error.util';
import { logger } from '../config/logger.config';

/**
 * Returns true if the given IP/hostname refers to this machine.
 * Used to detect self-scans so the scanner can use local WMI instead of
 * remote DCOM — bypassing UAC remote token filtering (which causes access
 * denied even with valid admin credentials when connecting to oneself via IP).
 */
export function isLocalTarget(ip: string): boolean {
  if (ip === 'localhost' || ip === '127.0.0.1' || ip === '::1') return true;
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    if (iface) {
      for (const net of iface) {
        if (net.address === ip) return true;
      }
    }
  }
  return false;
}

/**
 * Fast TCP port reachability check using a raw socket with a timeout.
 * Resolves true if the port accepts a connection, false on timeout/error.
 */
export function tcpPortCheck(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error',   () => { clearTimeout(timer); resolve(false); });
  });
}

// ─── Connection helpers ───────────────────────────────────────────────────────

export function createSshClient(
  host: string,
  username: string,
  password: string,
  port = 22,
  timeoutMs = 10000,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    const timer = setTimeout(() => {
      conn.destroy();
      reject(new AppError(504, ErrorCode.PS_TIMEOUT, `SSH connect timed out to ${host}:${port}`));
    }, timeoutMs);

    conn.on('ready', () => { clearTimeout(timer); resolve(conn); });
    conn.on('error', (err) => { clearTimeout(timer); reject(err); });

    const config: ConnectConfig = {
      host,
      port,
      username,
      password,
      readyTimeout: timeoutMs,
      // Allow legacy algorithms for older Windows SSH servers
      algorithms: {
        kex: [
          'curve25519-sha256',
          'ecdh-sha2-nistp256',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
        ],
      },
    };
    conn.connect(config);
  });
}

export function execSshCommand(
  conn: Client,
  command: string,
  timeoutMs = 30000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    conn.exec(command, (err, stream) => {
      if (err) return reject(err);

      const timer = setTimeout(() => {
        stream.destroy();
        reject(new AppError(504, ErrorCode.PS_TIMEOUT, `SSH command timed out: ${command.slice(0, 60)}`));
      }, timeoutMs);

      stream.on('data', (d: Buffer) => stdoutChunks.push(d));
      stream.stderr.on('data', (d: Buffer) => stderrChunks.push(d));

      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: code ?? 0,
        });
      });

      stream.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    });
  });
}

// ─── systeminfo parser ────────────────────────────────────────────────────────

function extractField(lines: string[], key: string): string {
  const prefix = key.toLowerCase();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const fieldName = line.slice(0, colon).trim().toLowerCase();
    if (fieldName === prefix) {
      return line.slice(colon + 1).trim();
    }
  }
  return '';
}

export function parseSystemInfo(raw: string): Partial<HardwareInfo> {
  const lines = raw.split(/\r?\n/).map((l) => l.trimEnd());

  const hostname       = extractField(lines, 'Host Name');
  const osName         = extractField(lines, 'OS Name');
  const osVersion      = extractField(lines, 'OS Version');
  const osMfr          = extractField(lines, 'OS Manufacturer');
  const osInstall      = extractField(lines, 'Original Install Date');
  const sysMfr         = extractField(lines, 'System Manufacturer');
  const sysModel       = extractField(lines, 'System Model');
  const sysType        = extractField(lines, 'System Type');
  const winDir         = extractField(lines, 'Windows Directory');
  const bootDevice     = extractField(lines, 'Boot Device');
  const domain         = extractField(lines, 'Domain');
  const registeredUser = extractField(lines, 'Registered Owner');
  const totalMemStr    = extractField(lines, 'Total Physical Memory');

  // Build number from "OS Version: 10.0.26100 N/A Build 26100"
  const buildMatch = /Build\s+(\d+)/i.exec(osVersion);
  const buildNumber = buildMatch ? buildMatch[1] : osVersion;

  // Memory — "16,050 MB" → GB
  const memMB = parseFloat(totalMemStr.replace(/,/g, '').replace(/\s*MB.*/i, ''));
  const totalMemGB = isNaN(memMB) ? 0 : Math.round((memMB / 1024) * 100) / 100;

  // CPU from Processor(s) section — "[01]: Intel64 Family ... ~1600 Mhz"
  let cpu = '';
  let maxClockMHz = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/\[01\]:/i.test(lines[i])) {
      const cpuInfo = lines[i].replace(/^\s*\[01\]:\s*/, '').trim();
      cpu = cpuInfo;
      const clockMatch = /~(\d+)\s*Mhz/i.exec(cpuInfo);
      if (clockMatch) maxClockMHz = parseInt(clockMatch[1], 10);
      break;
    }
  }

  return {
    Hostname:             hostname,
    Domain:               domain,
    Manufacturer:         sysMfr,
    Model:                sysModel,
    SystemType:           sysType,
    OperatingSystem:      osName,
    OsName:               osName,
    BuildNumber:          buildNumber,
    OsInstallDate:        osInstall,
    OsManufacturer:       osMfr,
    WindowsDirectory:     winDir,
    BootDevice:           bootDevice,
    RegisteredUser:       registeredUser,
    TotalPhysicalMemoryGB: totalMemGB,
    Cpu:                  cpu,
    MaxClockSpeedMHz:     maxClockMHz,
    CurrentClockSpeedMHz: maxClockMHz,
    // Fields not available from systeminfo — left as defaults
    HypervisorPresent:    false,
    PartOfDomain:         domain.toUpperCase() !== 'WORKGROUP' && domain !== '',
    NumberOfLogicalProcessors: 0,
    NumberOfProcessors:   0,
    TotalCores:           0,
    TotalSockets:         0,
    CoresPerSocket:       0,
    NumberOfDrives:       0,
    Disks:                [],
    NetworkAdapters:      [],
    GraphicsCard:         '',
    OsArchitecture:       '',
    PrimaryUserName:      '',
    SystemFamily:         '',
    SystemSKUNumber:      '',
    CspName:              '',
    CspVendor:            '',
    CspVersion:           '',
    LicenseName:          '',
    LicenseDescription:   '',
    LicenseProductKey:    '',
  };
}

// ─── ipconfig /all parser ─────────────────────────────────────────────────────

export function parseIpConfig(raw: string): NetworkAdapterInfo[] {
  const adapters: NetworkAdapterInfo[] = [];
  // Each adapter block starts with a non-whitespace line containing "adapter"
  const blocks = raw.split(/\r?\n(?=[^\s])/);

  for (const block of blocks) {
    const adapterMatch = /adapter\s+(.+?):/i.exec(block);
    if (!adapterMatch) continue;
    const name = adapterMatch[1].trim();

    const macMatch = /Physical Address[\s.]+:\s*([A-F0-9]{2}(?:[:-][A-F0-9]{2}){5})/i.exec(block);
    const mac = macMatch ? macMatch[1].toUpperCase() : '';

    const ipMatches = [...block.matchAll(/IPv4 Address[\s.]+:\s*([0-9.]+)/gi)];
    const ipAddresses = ipMatches.map((m) => m[1].replace(/\(Preferred\)/i, '').trim());

    if (name && (mac || ipAddresses.length > 0)) {
      adapters.push({ name, macAddress: mac, ipAddresses });
    }
  }

  return adapters;
}

// ─── reg query /s parser ──────────────────────────────────────────────────────

export function parseRegQuery(raw: string, _basePath: string): SoftwareEntry[] {
  const entries: SoftwareEntry[] = [];

  // Split into per-key sections: each starts with HKEY_...
  const sections = raw.split(/\r?\n(?=HKEY_)/i);

  for (const section of sections) {
    const sectionLines = section.split(/\r?\n/);
    const keyPath = sectionLines[0]?.trim() ?? '';
    if (!keyPath) continue;

    const values: Record<string, string> = {};
    for (const line of sectionLines.slice(1)) {
      // Format: "    ValueName    REG_SZ    ValueData"
      const match = /^\s+(.+?)\s{2,}REG_\w+\s{2,}(.*)$/.exec(line);
      if (match) {
        values[match[1].trim()] = match[2].trim();
      }
    }

    const displayName = values['DisplayName'];
    if (!displayName || displayName.trim() === '') continue;

    entries.push({
      ApplicationName: displayName,
      Version:         values['DisplayVersion'] ?? '',
      Publisher:       values['Publisher']      ?? '',
      InstallDate:     values['InstallDate']    ?? '',
      SerialNumber:    values['ProductID']      ?? '',
      RegistryPath:    keyPath.replace('HKEY_LOCAL_MACHINE', 'HKEY_LOCAL_MACHINE'),
    });
  }

  // Remove duplicates (same app appears in both 64-bit and 32-bit hives sometimes)
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = `${e.ApplicationName}|${e.Version}|${e.Publisher}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── wmic disk parser (optional — may not be available) ──────────────────────

export function parseWmicDiskOutput(raw: string): DiskInfo[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('Caption'));
  const disks: DiskInfo[] = [];

  for (const line of lines) {
    // CSV format: Node,Caption,Size
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const caption = parts[1]?.trim() ?? '';
    const sizeBytes = parseInt(parts[2]?.trim() ?? '0', 10);
    if (caption && !isNaN(sizeBytes) && sizeBytes > 0) {
      disks.push({
        deviceId: caption,
        sizeGB:   Math.round((sizeBytes / 1_073_741_824) * 100) / 100,
      });
    }
  }

  return disks;
}

// ─── systeminfo architecture helper ──────────────────────────────────────────

export function parseOsArchFromSystemInfo(raw: string): string {
  const sysType = extractField(raw.split(/\r?\n/), 'System Type');
  if (/64/i.test(sysType)) return '64-bit';
  if (/32/i.test(sysType)) return '32-bit';
  return sysType;
}

export function logSshWarning(context: string, label: string, err: unknown): void {
  logger.warn(`SSH: ${label} step failed, skipping`, {
    context,
    error: err instanceof Error ? err.message : String(err),
  });
}
