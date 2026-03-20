export enum OsType {
  WINDOWS = 'windows',
  LINUX   = 'linux',
  MAC     = 'mac',
}

export enum ScanMethod {
  /** Uses PowerShell Remoting (Invoke-Command) over WinRM — requires Enable-PSRemoting on target */
  POWERSHELL = 'powershell',
  /** Uses VBScript + cscript.exe with WbemScripting.SWbemLocator over DCOM — PowerShell independent */
  WMI        = 'wmi',
  /** Uses SSH (ssh2) + CMD commands (systeminfo, reg query) — no PowerShell or WMI required */
  SSH        = 'ssh',
  /** Uses node-wmi npm package to query WMI over DCOM — pure Node.js, no temp files, no spawned helpers */
  NODE_WMI   = 'node-wmi',
}

export interface ScanCredentials {
  username: string;
  password: string;
  domain?: string;
}

export interface PingResult {
  alive: boolean;
  target: string;
  latencyMs?: number;
  rawOutput?: string;
}

export interface ConnectionTestResult {
  success: boolean;
  target: string;
  method: ScanMethod;
  error?: string;
}

export interface DiskInfo {
  deviceId: string;
  sizeGB: number;
}

export interface NetworkAdapterInfo {
  name: string;
  macAddress: string;
  ipAddresses: string[];
}

export interface HardwareInfo {
  Hostname: string;
  Domain: string;
  HypervisorPresent: boolean;
  Manufacturer: string;
  Model: string;
  NumberOfLogicalProcessors: number;
  NumberOfProcessors: number;
  PartOfDomain: boolean;
  SystemFamily: string;
  SystemSKUNumber: string;
  SystemType: string;
  TotalPhysicalMemoryGB: number;
  PrimaryUserName: string;
  BootDevice: string;
  BuildNumber: string;
  OperatingSystem: string;
  OsInstallDate: string;
  OsManufacturer: string;
  LicenseName: string;
  LicenseDescription: string;
  LicenseProductKey: string;
  OsName: string;
  OsArchitecture: string;
  RegisteredUser: string;
  WindowsDirectory: string;
  CspName: string;
  CspVendor: string;
  CspVersion: string;
  Cpu: string;
  MaxClockSpeedMHz: number;
  CurrentClockSpeedMHz: number;
  Disks: DiskInfo[];
  NumberOfDrives: number;
  GraphicsCard: string;
  NetworkAdapters: NetworkAdapterInfo[];
  TotalSockets: number;
  TotalCores: number;
  CoresPerSocket: number;
}

export interface SoftwareEntry {
  ApplicationName: string;
  Version: string;
  Publisher: string;
  SerialNumber: string;
  InstallDate: string;
  RegistryPath: string;
}

export interface ScanResult {
  target: string;
  method: ScanMethod;
  pingSuccess: boolean;
  connectionSuccess: boolean;
  hardware?: HardwareInfo;
  software?: SoftwareEntry[];
  errors: Record<string, string>;
  startedAt: string;
  completedAt: string;
}

export interface FullScanOptions {
  target: string;
  method: ScanMethod;
  credentials: ScanCredentials;
  skipPing: boolean;
  skipSoftware: boolean;
  continueOnError: boolean;
}

export interface PsExecutionOptions {
  timeoutMs: number;
  context?: string;
}

export interface PsExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
