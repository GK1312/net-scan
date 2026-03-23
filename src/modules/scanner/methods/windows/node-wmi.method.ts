/**
 * Node-WMI method — uses the `node-wmi` npm package to query WMI over DCOM.
 *
 * Compared with the VBScript WMI method:
 *   ✓  No spawned helper processes (cscript.exe)
 *   ✓  No temporary files written to disk
 *   ✓  Pure Node.js async/Promise API
 *   ✓  Credentials kept in-memory (not in process args, not on disk)
 *   ✗  Software scan uses Win32_Product — slow (60-120 s) and triggers
 *      Windows Installer self-repair; use VBScript WMI or SSH for software.
 *
 * Remote requirements (identical to the VBScript WMI method):
 *   - Port 135 (RPC endpoint mapper) + dynamic high ports (49152-65535)
 *   - Services: WMI, Remote Registry running on target
 *   - Firewall: "Windows Management Instrumentation (WMI)" exception enabled
 *
 * Use this method when PowerShell is blocked and you prefer a native Node.js
 * WMI client with no VBScript/temp-file overhead.
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
  wmiQuery,
  safeStr,
  safeNum,
  safeBool,
  dmtfToIso,
} from '../../../../utils/node-wmi.util';
import { tcpPortCheck, isLocalTarget } from '../../../../utils/ssh.util';
import { appConfig } from '../../../../config/app.config';
import { logger } from '../../../../config/logger.config';

function fullUsername(creds: ScanCredentials): string {
  return creds.domain ? `${creds.domain}\\${creds.username}` : creds.username;
}

export class NodeWmiMethod extends BaseMethod {
  readonly methodName = ScanMethod.NODE_WMI;

  // ── Connection test ─────────────────────────────────────────────────────────

  async testConnection(target: string, credentials: ScanCredentials): Promise<ConnectionTestResult> {
    const local = isLocalTarget(target);

    if (!local) {
      // Fast TCP pre-check on RPC endpoint mapper port to avoid long DCOM timeout.
      // Skip for local targets — local WMI uses IPC, not TCP 135.
      const portOpen = await tcpPortCheck(target, 135, 3000);
      if (!portOpen) {
        return { success: false, target, method: this.methodName, error: `WMI/RPC port 135 is not reachable on ${target}` };
      }
    }

    try {
      const rows = await wmiQuery({
        host:       local ? 'localhost' : target,
        username:   local ? ''          : fullUsername(credentials),
        password:   local ? ''          : credentials.password,
        wmiClass:   'Win32_OperatingSystem',
        properties: ['Caption'],
        timeoutMs:  appConfig.ps.connectTimeoutMs,
        context:    `${this.methodName}:test:${target}`,
      });
      return { success: rows.length > 0, target, method: this.methodName };
    } catch (err) {
      return {
        success: false,
        target,
        method: this.methodName,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Hardware info ───────────────────────────────────────────────────────────

  async fetchHardwareInfo(target: string, credentials: ScanCredentials): Promise<HardwareInfo> {
    const context = `${this.methodName}:hardware:${target}`;
    const local   = isLocalTarget(target);
    const host     = local ? 'localhost'              : target;
    const username = local ? ''                       : fullUsername(credentials);
    const password = local ? ''                       : credentials.password;

    const q = (wmiClass: string, properties: string[], where?: string) =>
      wmiQuery({
        host,
        username,
        password,
        wmiClass,
        properties,
        where,
        timeoutMs: appConfig.ps.executionTimeoutMs,
        context,
      });

    // Run core queries in parallel — each is an independent DCOM call
    const [csRows, osRows, cpuRows, diskRows, gpuRows, netRows] = await Promise.all([
      q('Win32_ComputerSystem', [
        'Name', 'Domain', 'HypervisorPresent', 'Manufacturer', 'Model',
        'NumberOfLogicalProcessors', 'NumberOfProcessors', 'PartOfDomain',
        'SystemFamily', 'SystemSKUNumber', 'SystemType', 'TotalPhysicalMemory', 'UserName',
      ]),
      q('Win32_OperatingSystem', [
        'BootDevice', 'BuildNumber', 'Caption', 'InstallDate',
        'Manufacturer', 'Name', 'OSArchitecture', 'RegisteredUser', 'WindowsDirectory',
      ]),
      q('Win32_Processor', ['Name', 'MaxClockSpeed', 'CurrentClockSpeed', 'NumberOfCores']),
      q('Win32_LogicalDisk', ['DeviceID', 'Size'], 'DriveType=3'),
      q('Win32_VideoController', ['Name']),
      q('Win32_NetworkAdapterConfiguration', ['Description', 'MACAddress', 'IPAddress'], 'IPEnabled=True'),
    ]);

    // Optional queries — skip silently on access-denied / class not found
    let cspRows: Record<string, unknown>[] = [];
    let licRows: Record<string, unknown>[] = [];
    try {
      [cspRows, licRows] = await Promise.all([
        q('Win32_ComputerSystemProduct', ['Name', 'Vendor', 'Version']),
        wmiQuery({
          host,
          username,
          password,
          wmiClass:   'SoftwareLicensingProduct',
          properties: ['Name', 'Description', 'ProductKeyLastFive'],
          where:      "ApplicationId='55c92734-d682-4d71-983e-d6ec3f16059f' AND LicenseStatus=1",
          timeoutMs:  appConfig.ps.executionTimeoutMs,
          context,
        }),
      ]);
    } catch {
      logger.debug('node-wmi: optional queries (csp/lic) failed — skipped', { context });
    }

    const cs  = csRows[0]  ?? {};
    const os  = osRows[0]  ?? {};
    const cpu = cpuRows[0] ?? {};
    const csp = cspRows[0] ?? {};
    const lic = licRows[0] ?? {};

    const totalMem   = safeNum(cs.TotalPhysicalMemory);
    const totalCores = cpuRows.reduce((sum, r) => sum + safeNum(r.NumberOfCores), 0);
    // Win32_OperatingSystem.Name includes pipe-separated extras: strip them
    const osName     = safeStr(os.Name).split('|')[0].trim();

    // IPAddress in WMI is an array; node-wmi may return it as array or string
    const toIpArray = (val: unknown): string[] => {
      if (Array.isArray(val)) return (val as unknown[]).map(String);
      const s = safeStr(val);
      return s ? s.split(',').map((v) => v.trim()).filter(Boolean) : [];
    };

    return {
      Hostname:                  safeStr(cs.Name),
      Domain:                    safeStr(cs.Domain),
      HypervisorPresent:         safeBool(cs.HypervisorPresent),
      Manufacturer:              safeStr(cs.Manufacturer),
      Model:                     safeStr(cs.Model),
      NumberOfLogicalProcessors: safeNum(cs.NumberOfLogicalProcessors),
      NumberOfProcessors:        safeNum(cs.NumberOfProcessors),
      PartOfDomain:              safeBool(cs.PartOfDomain),
      SystemFamily:              safeStr(cs.SystemFamily),
      SystemSKUNumber:           safeStr(cs.SystemSKUNumber),
      SystemType:                safeStr(cs.SystemType),
      TotalPhysicalMemoryGB:     Math.round((totalMem / 1_073_741_824) * 100) / 100,
      PrimaryUserName:           safeStr(cs.UserName),
      BootDevice:                safeStr(os.BootDevice),
      BuildNumber:               safeStr(os.BuildNumber),
      OperatingSystem:           safeStr(os.Caption),
      OsInstallDate:             dmtfToIso(os.InstallDate),
      OsManufacturer:            safeStr(os.Manufacturer),
      OsName:                    osName,
      OsArchitecture:            safeStr(os.OSArchitecture),
      RegisteredUser:            safeStr(os.RegisteredUser),
      WindowsDirectory:          safeStr(os.WindowsDirectory),
      CspName:                   safeStr(csp.Name),
      CspVendor:                 safeStr(csp.Vendor),
      CspVersion:                safeStr(csp.Version),
      LicenseName:               safeStr(lic.Name),
      LicenseDescription:        safeStr(lic.Description),
      LicenseProductKey:         safeStr(lic.ProductKeyLastFive),
      Cpu:                       safeStr(cpu.Name),
      MaxClockSpeedMHz:          safeNum(cpu.MaxClockSpeed),
      CurrentClockSpeedMHz:      safeNum(cpu.CurrentClockSpeed),
      Disks: diskRows.map((r) => ({
        deviceId: safeStr(r.DeviceID),
        sizeGB:   Math.round((safeNum(r.Size) / 1_073_741_824) * 100) / 100,
      })),
      NumberOfDrives:  diskRows.length,
      GraphicsCard:    safeStr(gpuRows[0]?.Name),
      NetworkAdapters: netRows.map((r) => ({
        name:        safeStr(r.Description),
        macAddress:  safeStr(r.MACAddress),
        ipAddresses: toIpArray(r.IPAddress),
      })),
      TotalSockets:   safeNum(cs.NumberOfProcessors),
      TotalCores:     totalCores,
      CoresPerSocket: safeNum(cpu.NumberOfCores),
    };
  }

  // ── Software info ───────────────────────────────────────────────────────────

  async fetchSoftwareInfo(target: string, credentials: ScanCredentials): Promise<SoftwareEntry[]> {
    const context = `${this.methodName}:software:${target}`;

    /**
     * Win32_Product only lists MSI-installed software and is notoriously slow
     * (can take 60-120 s) because it triggers Windows Installer reconfiguration
     * for every enumerated product.  For a complete, fast software list use the
     * VBScript WMI method (StdRegProv) or the SSH method (reg query).
     */
    logger.warn(
      'node-wmi: Win32_Product query may take 60-120 s and trigger Windows Installer. ' +
      'Use the WMI or SSH method for a complete, fast software list.',
      { context },
    );

    const local = isLocalTarget(target);
    const rows = await wmiQuery({
      host:       local ? 'localhost'           : target,
      username:   local ? ''                    : fullUsername(credentials),
      password:   local ? ''                    : credentials.password,
      wmiClass:   'Win32_Product',
      properties: ['Name', 'Version', 'Vendor', 'InstallDate', 'IdentifyingNumber'],
      // Give Win32_Product plenty of time
      timeoutMs:  Math.max(appConfig.ps.executionTimeoutMs, 120_000),
      context,
    });

    return rows
      .filter((r) => safeStr(r.Name) !== '')
      .map((r) => ({
        ApplicationName: safeStr(r.Name),
        Version:         safeStr(r.Version),
        Publisher:       safeStr(r.Vendor),
        InstallDate:     safeStr(r.InstallDate),
        SerialNumber:    safeStr(r.IdentifyingNumber),
        RegistryPath:    '',   // Not available from Win32_Product
      }));
  }
}
