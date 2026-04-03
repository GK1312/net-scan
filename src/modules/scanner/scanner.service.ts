import {
  ScanMethod,
  ScanCredentials,
  PingResult,
  ConnectionTestResult,
  HardwareInfo,
  SoftwareEntry,
  ScanResult,
  FullScanOptions,
} from "../../types/scanner.types";
import { pingHost } from "../../utils/ping.util";
import { getMethod } from "./methods/method.factory";
import { AppError, ErrorCode } from "../../utils/app-error.util";
import { logger } from "../../config/logger.config";

function extractMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" ? (value as AnyRecord) : {};
}

function pick(raw: AnyRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      return raw[key];
    }
  }
  return undefined;
}

function toStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes";
  }
  return Boolean(value);
}

function formatLastScanTime(date: Date): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(date);

  return formatted
    .replace(/\//g, "-")
    .replace(",", "")
    .replace(" am", " AM")
    .replace(" pm", " PM");
}

function normalizeHardware(target: string, rawHardware: unknown): HardwareInfo {
  const raw = asRecord(rawHardware);

  const normalizedDisks = (
    Array.isArray(pick(raw, "Disks")) ? (pick(raw, "Disks") as unknown[]) : []
  )
    .map((disk) => {
      const d = asRecord(disk);
      return {
        deviceId: toStr(pick(d, "deviceId", "DeviceId", "DeviceID", "Caption")),
        sizeGB: toNum(pick(d, "sizeGB", "SizeGB", "Size")),
      };
    })
    .filter((disk) => disk.deviceId !== "");

  const normalizedNetworkAdapters = (
    Array.isArray(pick(raw, "NetworkAdapters"))
      ? (pick(raw, "NetworkAdapters") as unknown[])
      : []
  )
    .map((adapter) => {
      const a = asRecord(adapter);
      const ipRaw = pick(a, "ipAddresses", "IpAddresses", "IPAddress");
      const ipAddresses = Array.isArray(ipRaw)
        ? ipRaw.map((ip) => toStr(ip)).filter(Boolean)
        : toStr(ipRaw)
            .split(",")
            .map((ip) => ip.trim())
            .filter(Boolean);

      return {
        name: toStr(pick(a, "name", "Name", "Description")),
        macAddress: toStr(pick(a, "macAddress", "MacAddress", "MACAddress")),
        ipAddresses,
      };
    })
    .filter(
      (adapter) =>
        adapter.name !== "" ||
        adapter.macAddress !== "" ||
        adapter.ipAddresses.length > 0,
    );

  const numberOfDrives = Math.max(
    toNum(pick(raw, "NumberOfDrives", "Number_of_Drives")),
    normalizedDisks.length,
  );

  const macAddresses = normalizedNetworkAdapters
    .map((adapter) => adapter.macAddress)
    .filter(Boolean)
    .join(", ");
  const ipAddresses = normalizedNetworkAdapters
    .flatMap((adapter) => adapter.ipAddresses)
    .filter(Boolean)
    .join(", ");

  const drives = normalizedDisks.map((disk) => disk.deviceId).join(" , ");
  const sizeOfDrives = normalizedDisks
    .map((disk) => `${disk.deviceId} (Total: ${disk.sizeGB} GB)`)
    .join(", ");
  const disksLabel = normalizedDisks
    .map((disk) => `${disk.deviceId} (${disk.sizeGB} GB)`)
    .join(", ");

  const normalized: HardwareInfo & Record<string, unknown> = {
    Hostname: toStr(pick(raw, "Hostname", "HostName", "hostName")) || target,
    Domain: toStr(pick(raw, "Domain")),
    HypervisorPresent: toBool(pick(raw, "HypervisorPresent")),
    Manufacturer: toStr(pick(raw, "Manufacturer", "Manufactuter")),
    Model: toStr(pick(raw, "Model")),
    NumberOfLogicalProcessors: toNum(pick(raw, "NumberOfLogicalProcessors")),
    NumberOfProcessors: toNum(pick(raw, "NumberOfProcessors")),
    PartOfDomain: toBool(pick(raw, "PartOfDomain")),
    SystemFamily: toStr(pick(raw, "SystemFamily")),
    SystemSKUNumber: toStr(pick(raw, "SystemSKUNumber")),
    SystemType: toStr(pick(raw, "SystemType")),
    TotalPhysicalMemoryGB: toNum(
      pick(raw, "TotalPhysicalMemoryGB", "TotalPhysicalMemory (GB)"),
    ),
    PrimaryUserName: toStr(pick(raw, "PrimaryUserName", "Primary_UserName")),
    BootDevice: toStr(pick(raw, "BootDevice")),
    BuildNumber: toStr(pick(raw, "BuildNumber")),
    OperatingSystem: toStr(
      pick(raw, "OperatingSystem", "Operating_System", "OsName", "OS_Name"),
    ),
    OsInstallDate: toStr(pick(raw, "OsInstallDate", "OS_InstallDate")),
    OsManufacturer: toStr(pick(raw, "OsManufacturer", "OS_Manufacturer")),
    LicenseName: toStr(pick(raw, "LicenseName", "License_Name")),
    LicenseDescription: toStr(pick(raw, "LicenseDescription", "License_Desc")),
    LicenseProductKey: toStr(
      pick(raw, "LicenseProductKey", "License_Product_Key"),
    ),
    OsName: toStr(
      pick(raw, "OsName", "OS_Name", "OperatingSystem", "Operating_System"),
    ),
    OsArchitecture: toStr(pick(raw, "OsArchitecture", "OSArchitecture")),
    RegisteredUser: toStr(pick(raw, "RegisteredUser")),
    WindowsDirectory: toStr(pick(raw, "WindowsDirectory")),
    CspName: toStr(pick(raw, "CspName", "W32_CSP_Name")),
    CspVendor: toStr(pick(raw, "CspVendor", "W32_CSP_Vendor")),
    CspVersion: toStr(pick(raw, "CspVersion", "W32_CSP_Version")),
    Cpu: toStr(pick(raw, "Cpu", "CPU")),
    MaxClockSpeedMHz: toNum(
      pick(raw, "MaxClockSpeedMHz", "MaxClockSpeed(MHz)"),
    ),
    CurrentClockSpeedMHz: toNum(
      pick(raw, "CurrentClockSpeedMHz", "CurrentClockSpeed(MHz)"),
    ),
    Disks: normalizedDisks,
    NumberOfDrives: numberOfDrives,
    GraphicsCard: toStr(pick(raw, "GraphicsCard", "Graphics_Card")),
    NetworkAdapters: normalizedNetworkAdapters,
    TotalSockets: toNum(pick(raw, "TotalSockets", "Total_Sockets")),
    TotalCores: toNum(pick(raw, "TotalCores", "Total_Cores")),
    CoresPerSocket: toNum(pick(raw, "CoresPerSocket", "Cores_Per_Socket")),

    // CSV-style aliases required by downstream exports/consumers.
    HostName:
      toStr(pick(raw, "HostName")) ||
      toStr(pick(raw, "Hostname", "hostName")) ||
      target,
    Status: toStr(pick(raw, "Status")) || "OK",
    Remark: toStr(pick(raw, "Remark")) || "Success",
    Manufactuter: toStr(pick(raw, "Manufactuter", "Manufacturer")),
    "TotalPhysicalMemory (GB)": toNum(
      pick(raw, "TotalPhysicalMemory (GB)", "TotalPhysicalMemoryGB"),
    ),
    Primary_UserName: toStr(pick(raw, "Primary_UserName", "PrimaryUserName")),
    Operating_System: toStr(
      pick(raw, "Operating_System", "OperatingSystem", "OsName", "OS_Name"),
    ),
    OS_InstallDate: toStr(pick(raw, "OS_InstallDate", "OsInstallDate")),
    OS_Manufacturer: toStr(pick(raw, "OS_Manufacturer", "OsManufacturer")),
    License_Name: toStr(pick(raw, "License_Name", "LicenseName")),
    License_Desc: toStr(pick(raw, "License_Desc", "LicenseDescription")),
    License_Product_Key: toStr(
      pick(raw, "License_Product_Key", "LicenseProductKey"),
    ),
    OS_Name: toStr(
      pick(raw, "OS_Name", "OsName", "OperatingSystem", "Operating_System"),
    ),
    OSArchitecture: toStr(pick(raw, "OSArchitecture", "OsArchitecture")),
    W32_CSP_Name: toStr(pick(raw, "W32_CSP_Name", "CspName")),
    W32_CSP_Vendor: toStr(pick(raw, "W32_CSP_Vendor", "CspVendor")),
    W32_CSP_Version: toStr(pick(raw, "W32_CSP_Version", "CspVersion")),
    CPU: toStr(pick(raw, "CPU", "Cpu")),
    "MaxClockSpeed(MHz)": toNum(
      pick(raw, "MaxClockSpeed(MHz)", "MaxClockSpeedMHz"),
    ),
    "CurrentClockSpeed(MHz)": toNum(
      pick(raw, "CurrentClockSpeed(MHz)", "CurrentClockSpeedMHz"),
    ),
    Number_of_Drives: numberOfDrives,
    Drives: toStr(pick(raw, "Drives")) || drives,
    Size_of_Drives: toStr(pick(raw, "Size_of_Drives")) || sizeOfDrives,
    Graphics_Card: toStr(pick(raw, "Graphics_Card", "GraphicsCard")),
    Network_Adapters:
      toStr(pick(raw, "Network_Adapters")) ||
      normalizedNetworkAdapters
        .map((adapter) => adapter.name)
        .filter(Boolean)
        .join(", "),
    MacAddress: toStr(pick(raw, "MacAddress")) || macAddresses,
    IP_Address: toStr(pick(raw, "IP_Address")) || ipAddresses,
    Total_Sockets: toNum(pick(raw, "Total_Sockets", "TotalSockets")),
    Total_Cores: toNum(pick(raw, "Total_Cores", "TotalCores")),
    Cores_Per_Socket: toNum(pick(raw, "Cores_Per_Socket", "CoresPerSocket")),
    Last_Scan_Time:
      toStr(pick(raw, "Last_Scan_Time")) || formatLastScanTime(new Date()),
    DisksLabel: toStr(pick(raw, "Disks")) || disksLabel,
  };

  return normalized;
}

function normalizeSoftware(
  target: string,
  rawSoftware: SoftwareEntry[],
): SoftwareEntry[] {
  const scanTime = formatLastScanTime(new Date());

  return rawSoftware.map((entry) => {
    const raw = asRecord(entry);
    const normalized: SoftwareEntry & Record<string, unknown> = {
      ApplicationName: toStr(pick(raw, "ApplicationName", "Application_Name")),
      Version: toStr(pick(raw, "Version")),
      Publisher: toStr(pick(raw, "Publisher")),
      SerialNumber: toStr(pick(raw, "SerialNumber")),
      InstallDate: toStr(pick(raw, "InstallDate")),
      RegistryPath: toStr(pick(raw, "RegistryPath")),

      // CSV-style aliases required by downstream exports/consumers.
      Hostname: toStr(pick(raw, "Hostname")) || target,
      Status: toStr(pick(raw, "Status")) || "OK",
      Remark: toStr(pick(raw, "Remark")) || "Successful",
      Application_Name:
        toStr(pick(raw, "Application_Name")) ||
        toStr(pick(raw, "ApplicationName", "Application_Name")),
      Last_Scan_Time: toStr(pick(raw, "Last_Scan_Time")) || scanTime,
    };

    return normalized;
  });
}

export class ScannerService {
  async ping(target: string): Promise<PingResult> {
    logger.debug("Pinging target", { target });
    return pingHost(target);
  }

  async testConnection(
    target: string,
    method: ScanMethod,
    credentials: ScanCredentials,
  ): Promise<ConnectionTestResult> {
    logger.debug("Testing connection", { target, method });
    const handler = getMethod(method);
    return handler.testConnection(target, credentials);
  }

  async fetchHardware(
    target: string,
    method: ScanMethod,
    credentials: ScanCredentials,
  ): Promise<HardwareInfo> {
    logger.debug("Fetching hardware info", { target, method });
    const raw = await getMethod(method).fetchHardwareInfo(target, credentials);
    return normalizeHardware(target, raw);
  }

  async fetchSoftware(
    target: string,
    method: ScanMethod,
    credentials: ScanCredentials,
  ): Promise<SoftwareEntry[]> {
    logger.debug("Fetching software info", { target, method });
    const raw = await getMethod(method).fetchSoftwareInfo(target, credentials);
    return normalizeSoftware(target, raw);
  }

  async fullScan(options: FullScanOptions): Promise<ScanResult> {
    const {
      target,
      method,
      credentials,
      skipPing,
      skipSoftware,
      continueOnError,
    } = options;

    const result: ScanResult = {
      target,
      method,
      pingSuccess: false,
      connectionSuccess: false,
      errors: {},
      startedAt: new Date().toISOString(),
      completedAt: "",
    };

    logger.info("Starting full scan", {
      target,
      method,
      skipPing,
      skipSoftware,
    });

    // ── Step 1: Ping ────────────────────────────────────────────────────────
    if (!skipPing) {
      try {
        const ping = await pingHost(target);
        result.pingSuccess = ping.alive;

        if (!ping.alive) {
          const msg = `Host ${target} did not respond to ping`;
          result.errors["ping"] = msg;
          if (!continueOnError) {
            throw new AppError(503, ErrorCode.PING_FAILED, msg);
          }
          logger.warn("Ping failed, continuing", { target });
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        result.errors["ping"] = extractMessage(err);
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
        const msg = conn.error ?? "Connection test failed";
        result.errors["connection"] = msg;
        if (!continueOnError) {
          throw new AppError(503, ErrorCode.CONNECTION_FAILED, msg);
        }
        logger.warn("Connection test failed, continuing", { target, method });
      }
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.CONNECTION_FAILED)
        throw err;
      result.errors["connection"] = extractMessage(err);
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
      result.hardware = await this.fetchHardware(target, method, credentials);
    } catch (err) {
      result.errors["hardware"] = extractMessage(err);
      logger.warn("Hardware fetch failed", {
        target,
        method,
        error: extractMessage(err),
      });
      if (!continueOnError) throw err;
    }

    // ── Step 4: Software Info ───────────────────────────────────────────────
    if (!skipSoftware) {
      try {
        result.software = await this.fetchSoftware(target, method, credentials);
      } catch (err) {
        result.errors["software"] = extractMessage(err);
        logger.warn("Software fetch failed", {
          target,
          method,
          error: extractMessage(err),
        });
        if (!continueOnError) throw err;
      }
    }

    result.completedAt = new Date().toISOString();
    logger.info("Full scan complete", {
      target,
      method,
      hardwareOk: !!result.hardware,
      softwareCount: result.software?.length ?? 0,
      errors: Object.keys(result.errors),
    });

    return result;
  }
}
