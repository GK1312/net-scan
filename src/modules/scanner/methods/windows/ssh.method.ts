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
import { BaseMethod } from "../base.method";
import {
  ScanMethod,
  ScanCredentials,
  ConnectionTestResult,
  HardwareInfo,
  SoftwareEntry,
} from "../../../../types/scanner.types";
import {
  createSshClient,
  execSshCommand,
  parseSystemInfo,
  parseIpConfig,
  parseRegQuery,
  parseWmicDiskOutput,
  parseWmicCsvRows,
  parseOsArchFromSystemInfo,
  logSshWarning,
  tcpPortCheck,
  isLocalTarget,
} from "../../../../utils/ssh.util";
import { appConfig } from "../../../../config/app.config";
import { logger } from "../../../../config/logger.config";

const SSH_PORT = 22;

function fullUsername(creds: ScanCredentials): string {
  return creds.domain ? `${creds.domain}\\${creds.username}` : creds.username;
}

export class SshMethod extends BaseMethod {
  readonly methodName = ScanMethod.SSH;

  async testConnection(
    target: string,
    credentials: ScanCredentials,
  ): Promise<ConnectionTestResult> {
    // Fast TCP pre-check to avoid waiting the full SSH handshake timeout
    const portOpen = await tcpPortCheck(target, SSH_PORT, 3000);
    if (!portOpen) {
      const hint = isLocalTarget(target)
        ? ` — install OpenSSH Server: Settings > Apps > Optional features > "OpenSSH Server"`
        : "";
      return {
        success: false,
        target,
        method: this.methodName,
        error: `SSH port ${SSH_PORT} is not reachable on ${target}${hint}`,
      };
    }

    try {
      const conn = await createSshClient(
        target,
        fullUsername(credentials),
        credentials.password,
        SSH_PORT,
        appConfig.ps.connectTimeoutMs,
      );
      const { stdout } = await execSshCommand(conn, "echo connection_ok", 5000);
      conn.end();
      const success = stdout.includes("connection_ok");
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

  async fetchHardwareInfo(
    target: string,
    credentials: ScanCredentials,
  ): Promise<HardwareInfo> {
    const context = `${this.methodName}:hardware:${target}`;
    if (!(await tcpPortCheck(target, SSH_PORT, 3000))) {
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
      const { stdout: sysOut } = await execSshCommand(
        conn,
        "systeminfo",
        appConfig.ps.executionTimeoutMs,
      );
      const hw = parseSystemInfo(sysOut) as HardwareInfo;

      // ── richer WMIC details for required fields ──────────────────────────
      try {
        const { stdout: cpuOut, exitCode: cpuExit } = await execSshCommand(
          conn,
          "wmic cpu get Name,MaxClockSpeed,CurrentClockSpeed,NumberOfCores,NumberOfLogicalProcessors /format:csv",
          15000,
        );
        if (cpuExit === 0 && cpuOut.trim()) {
          const cpuRows = parseWmicCsvRows(cpuOut);
          if (cpuRows.length > 0) {
            const firstCpu = cpuRows[0];
            const toNum = (v: string | undefined): number => {
              const n = Number(v ?? "0");
              return Number.isFinite(n) ? n : 0;
            };

            hw.Cpu = firstCpu["Name"]?.trim() || hw.Cpu;
            hw.MaxClockSpeedMHz =
              toNum(firstCpu["MaxClockSpeed"]) || hw.MaxClockSpeedMHz;
            hw.CurrentClockSpeedMHz =
              toNum(firstCpu["CurrentClockSpeed"]) || hw.CurrentClockSpeedMHz;
            hw.TotalSockets = cpuRows.length;
            hw.TotalCores = cpuRows.reduce(
              (sum, row) => sum + toNum(row["NumberOfCores"]),
              0,
            );
            hw.NumberOfLogicalProcessors = cpuRows.reduce(
              (sum, row) => sum + toNum(row["NumberOfLogicalProcessors"]),
              0,
            );
            hw.CoresPerSocket =
              hw.TotalSockets > 0
                ? Math.floor(hw.TotalCores / hw.TotalSockets)
                : 0;
            hw.NumberOfProcessors = hw.TotalSockets;
          }
        }
      } catch (err) {
        logSshWarning(context, "wmic cpu", err);
      }

      try {
        const { stdout: csOut, exitCode: csExit } = await execSshCommand(
          conn,
          "wmic computersystem get Domain,HypervisorPresent,Manufacturer,Model,NumberOfLogicalProcessors,NumberOfProcessors,PartOfDomain,SystemFamily,SystemSKUNumber,SystemType,TotalPhysicalMemory,UserName /format:csv",
          15000,
        );
        if (csExit === 0 && csOut.trim()) {
          const csRows = parseWmicCsvRows(csOut);
          const cs = csRows[0];
          if (cs) {
            const toNum = (v: string | undefined): number => {
              const n = Number(v ?? "0");
              return Number.isFinite(n) ? n : 0;
            };

            hw.Domain = cs["Domain"]?.trim() || hw.Domain;
            hw.HypervisorPresent =
              (cs["HypervisorPresent"] ?? "").toLowerCase() === "true" ||
              hw.HypervisorPresent;
            hw.Manufacturer = cs["Manufacturer"]?.trim() || hw.Manufacturer;
            hw.Model = cs["Model"]?.trim() || hw.Model;
            hw.NumberOfLogicalProcessors =
              toNum(cs["NumberOfLogicalProcessors"]) ||
              hw.NumberOfLogicalProcessors;
            hw.NumberOfProcessors =
              toNum(cs["NumberOfProcessors"]) || hw.NumberOfProcessors;
            hw.PartOfDomain =
              (cs["PartOfDomain"] ?? "").toLowerCase() === "true" ||
              hw.PartOfDomain;
            hw.SystemFamily = cs["SystemFamily"]?.trim() || hw.SystemFamily;
            hw.SystemSKUNumber =
              cs["SystemSKUNumber"]?.trim() || hw.SystemSKUNumber;
            hw.SystemType = cs["SystemType"]?.trim() || hw.SystemType;
            hw.PrimaryUserName = cs["UserName"]?.trim() || hw.PrimaryUserName;

            const memBytes = toNum(cs["TotalPhysicalMemory"]);
            if (memBytes > 0) {
              hw.TotalPhysicalMemoryGB =
                Math.round((memBytes / 1_073_741_824) * 100) / 100;
            }
          }
        }
      } catch (err) {
        logSshWarning(context, "wmic computersystem", err);
      }

      try {
        const { stdout: osOut, exitCode: osExit } = await execSshCommand(
          conn,
          "wmic os get BootDevice,BuildNumber,Caption,InstallDate,Manufacturer,Name,OSArchitecture,RegisteredUser,WindowsDirectory /format:csv",
          15000,
        );
        if (osExit === 0 && osOut.trim()) {
          const osRows = parseWmicCsvRows(osOut);
          const osRow = osRows[0];
          if (osRow) {
            hw.BootDevice = osRow["BootDevice"]?.trim() || hw.BootDevice;
            hw.BuildNumber = osRow["BuildNumber"]?.trim() || hw.BuildNumber;
            hw.OperatingSystem = osRow["Caption"]?.trim() || hw.OperatingSystem;
            hw.OsName =
              (osRow["Name"]?.split("|")[0] ?? "").trim() ||
              hw.OsName ||
              hw.OperatingSystem;
            hw.OsManufacturer =
              osRow["Manufacturer"]?.trim() || hw.OsManufacturer;
            hw.OsArchitecture =
              osRow["OSArchitecture"]?.trim() || hw.OsArchitecture;
            hw.RegisteredUser =
              osRow["RegisteredUser"]?.trim() || hw.RegisteredUser;
            hw.WindowsDirectory =
              osRow["WindowsDirectory"]?.trim() || hw.WindowsDirectory;

            const dmtf = osRow["InstallDate"]?.trim() ?? "";
            if (dmtf.length >= 14) {
              hw.OsInstallDate = `${dmtf.slice(0, 4)}-${dmtf.slice(4, 6)}-${dmtf.slice(6, 8)}T${dmtf.slice(8, 10)}:${dmtf.slice(10, 12)}:${dmtf.slice(12, 14)}`;
            }
          }
        }
      } catch (err) {
        logSshWarning(context, "wmic os", err);
      }

      try {
        const { stdout: cspOut, exitCode: cspExit } = await execSshCommand(
          conn,
          "wmic computersystemproduct get Name,Vendor,Version /format:csv",
          10000,
        );
        if (cspExit === 0 && cspOut.trim()) {
          const cspRows = parseWmicCsvRows(cspOut);
          const csp = cspRows[0];
          if (csp) {
            hw.CspName = csp["Name"]?.trim() || hw.CspName;
            hw.CspVendor = csp["Vendor"]?.trim() || hw.CspVendor;
            hw.CspVersion = csp["Version"]?.trim() || hw.CspVersion;
          }
        }
      } catch (err) {
        logSshWarning(context, "wmic computersystemproduct", err);
      }

      try {
        const { stdout: licOut, exitCode: licExit } = await execSshCommand(
          conn,
          `wmic path SoftwareLicensingProduct where "ApplicationId='55c92734-d682-4d71-983e-d6ec3f16059f' and LicenseStatus=1" get Name,Description,ProductKeyLastFive /format:csv`,
          15000,
        );
        if (licExit === 0 && licOut.trim()) {
          const licRows = parseWmicCsvRows(licOut);
          const lic = licRows[0];
          if (lic) {
            hw.LicenseName = lic["Name"]?.trim() || hw.LicenseName;
            hw.LicenseDescription =
              lic["Description"]?.trim() || hw.LicenseDescription;
            hw.LicenseProductKey =
              lic["ProductKeyLastFive"]?.trim() || hw.LicenseProductKey;
          }
        }
      } catch (err) {
        logSshWarning(context, "wmic licensing", err);
      }

      try {
        const { stdout: gpuOut, exitCode: gpuExit } = await execSshCommand(
          conn,
          "wmic path Win32_VideoController get Name /format:csv",
          10000,
        );
        if (gpuExit === 0 && gpuOut.trim()) {
          const gpuRows = parseWmicCsvRows(gpuOut);
          hw.GraphicsCard = gpuRows[0]?.["Name"]?.trim() || hw.GraphicsCard;
        }
      } catch (err) {
        logSshWarning(context, "wmic video", err);
      }

      // ── ipconfig /all ──────────────────────────────────────────────────────
      try {
        const { stdout: ipOut } = await execSshCommand(
          conn,
          "ipconfig /all",
          15000,
        );
        hw.NetworkAdapters = parseIpConfig(ipOut);

        // Set OsArchitecture from system type string
        hw.OsArchitecture =
          hw.OsArchitecture || parseOsArchFromSystemInfo(sysOut);

        // Collect all IPs from adapters
        const allIps = hw.NetworkAdapters.flatMap((a) => a.ipAddresses).filter(
          Boolean,
        );
        logger.debug("SSH hardware IPs collected", {
          context,
          count: allIps.length,
        });
      } catch (err) {
        logSshWarning(context, "ipconfig", err);
      }

      // ── disk info via wmic (best effort — may not be available) ───────────
      try {
        const { stdout: diskOut, exitCode } = await execSshCommand(
          conn,
          "wmic logicaldisk get Caption,Size,DriveType /format:csv",
          15000,
        );
        if (exitCode === 0 && diskOut.trim()) {
          // Filter DriveType=3 (local disks)
          const csvLines = diskOut.split(/\r?\n/).filter((l) => {
            const parts = l.split(",");
            return parts.length >= 4 && parts[3]?.trim() === "3";
          });
          // Rebuild CSV for parser: Node,Caption,Size
          const adjustedCsv = csvLines
            .map((l) => {
              const parts = l.split(",");
              return `${parts[0]},${parts[1]},${parts[2]}`;
            })
            .join("\n");
          hw.Disks = parseWmicDiskOutput(adjustedCsv);
          hw.NumberOfDrives = hw.Disks.length;
        }
      } catch (err) {
        logSshWarning(context, "wmic disk", err);
      }

      return hw;
    } finally {
      conn.end();
    }
  }

  async fetchSoftwareInfo(
    target: string,
    credentials: ScanCredentials,
  ): Promise<SoftwareEntry[]> {
    const context = `${this.methodName}:software:${target}`;
    if (!(await tcpPortCheck(target, SSH_PORT, 3000))) {
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
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
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
