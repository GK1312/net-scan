/**
 * PowerShell Remoting method.
 * Uses Invoke-Command over WinRM — requires Enable-PSRemoting on target.
 * Port: 5985 (HTTP) or 5986 (HTTPS).
 *
 * When the target is the local machine (own IP / localhost), WinRM loopback
 * restrictions and UAC remote token filtering prevent Invoke-Command from
 * working reliably.  In that case the local script variants run Get-WmiObject
 * directly in the current PowerShell process — no WinRM required.
 *
 * Use this method when the client allows PowerShell access.
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
  buildCredentialBlock,
  executePowerShell,
} from '../../../../utils/powershell.util';
import { isLocalTarget } from '../../../../utils/ssh.util';
import { appConfig } from '../../../../config/app.config';

// ─── Remote Hardware Script (WinRM / Invoke-Command) ─────────────────────────
function buildHardwareScript(credBlock: string): string {
  return `
${credBlock}
try {
    $hw = Invoke-Command -ComputerName $__target -Credential $__cred -ErrorAction Stop -ScriptBlock {
        $cs      = Get-WmiObject Win32_ComputerSystem
        $os      = Get-WmiObject Win32_OperatingSystem
        $cpuArr  = @(Get-WmiObject Win32_Processor)
        $diskArr = @(Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3")
        $gpuArr  = @(Get-WmiObject Win32_VideoController)
        $netArr  = @(Get-WmiObject Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True")
        $csp     = Get-WmiObject Win32_ComputerSystemProduct -ErrorAction SilentlyContinue
        $lic     = @(Get-WmiObject SoftwareLicensingProduct -Filter "ApplicationId='55c92734-d682-4d71-983e-d6ec3f16059f' AND LicenseStatus=1" -ErrorAction SilentlyContinue)

        $totalCores = 0
        foreach ($c in $cpuArr) { $totalCores += $c.NumberOfCores }
        $coresPerSocket = if ($cpuArr.Count -gt 0) { $cpuArr[0].NumberOfCores } else { 0 }

        $diskList = @($diskArr | ForEach-Object { @{ DeviceId = $_.DeviceID; SizeGB = [math]::Round($_.Size / 1GB, 2) } })
        $netList  = @($netArr | ForEach-Object {
            $ipArr = if ($_.IPAddress) { @($_.IPAddress) } else { @() }
            @{ Name = $_.Description; MacAddress = $_.MACAddress; IpAddresses = $ipArr }
        })

        $osInstallDate = ''
        try { $osInstallDate = $os.ConvertToDateTime($os.InstallDate).ToString('yyyy-MM-ddTHH:mm:ssK') } catch {}

        $licName = ''; $licDesc = ''; $licKey = ''
        if ($lic.Count -gt 0) {
            $licName = if ($lic[0].Name)              { $lic[0].Name }              else { '' }
            $licDesc = if ($lic[0].Description)       { $lic[0].Description }       else { '' }
            $licKey  = if ($lic[0].ProductKeyLastFive) { $lic[0].ProductKeyLastFive } else { '' }
        }
        $cspName = ''; $cspVendor = ''; $cspVersion = ''
        if ($csp) {
            $cspName    = if ($csp.Name)    { $csp.Name }    else { '' }
            $cspVendor  = if ($csp.Vendor)  { $csp.Vendor }  else { '' }
            $cspVersion = if ($csp.Version) { $csp.Version } else { '' }
        }

        @{
            Hostname                  = if ($cs.Name)             { $cs.Name }             else { '' }
            Domain                    = if ($cs.Domain)           { $cs.Domain }           else { '' }
            HypervisorPresent         = [bool]$cs.HypervisorPresent
            Manufacturer              = if ($cs.Manufacturer)     { $cs.Manufacturer }     else { '' }
            Model                     = if ($cs.Model)            { $cs.Model }            else { '' }
            NumberOfLogicalProcessors = [int]$cs.NumberOfLogicalProcessors
            NumberOfProcessors        = [int]$cs.NumberOfProcessors
            PartOfDomain              = [bool]$cs.PartOfDomain
            SystemFamily              = if ($cs.SystemFamily)     { $cs.SystemFamily }     else { '' }
            SystemSKUNumber           = if ($cs.SystemSKUNumber)  { $cs.SystemSKUNumber }  else { '' }
            SystemType                = if ($cs.SystemType)       { $cs.SystemType }       else { '' }
            TotalPhysicalMemoryGB     = [math]::Round($cs.TotalPhysicalMemory / 1GB, 2)
            PrimaryUserName           = if ($cs.UserName)         { $cs.UserName }         else { '' }
            BootDevice                = if ($os.BootDevice)       { $os.BootDevice }       else { '' }
            BuildNumber               = if ($os.BuildNumber)      { $os.BuildNumber }      else { '' }
            OperatingSystem           = if ($os.Caption)          { $os.Caption }          else { '' }
            OsInstallDate             = $osInstallDate
            OsManufacturer            = if ($os.Manufacturer)     { $os.Manufacturer }     else { '' }
            LicenseName               = $licName
            LicenseDescription        = $licDesc
            LicenseProductKey         = $licKey
            OsName                    = if ($os.Caption)          { $os.Caption }          else { '' }
            OsArchitecture            = if ($os.OSArchitecture)   { $os.OSArchitecture }   else { '' }
            RegisteredUser            = if ($os.RegisteredUser)   { $os.RegisteredUser }   else { '' }
            WindowsDirectory          = if ($os.WindowsDirectory) { $os.WindowsDirectory } else { '' }
            CspName                   = $cspName; CspVendor = $cspVendor; CspVersion = $cspVersion
            Cpu                       = if ($cpuArr.Count -gt 0) { $cpuArr[0].Name }               else { '' }
            MaxClockSpeedMHz          = if ($cpuArr.Count -gt 0) { [int]$cpuArr[0].MaxClockSpeed }   else { 0 }
            CurrentClockSpeedMHz      = if ($cpuArr.Count -gt 0) { [int]$cpuArr[0].CurrentClockSpeed } else { 0 }
            Disks                     = $diskList; NumberOfDrives = $diskArr.Count
            GraphicsCard              = if ($gpuArr.Count -gt 0) { $gpuArr[0].Name } else { '' }
            NetworkAdapters           = $netList
            TotalSockets              = [int]$cs.NumberOfProcessors
            TotalCores                = $totalCores; CoresPerSocket = $coresPerSocket
        } | ConvertTo-Json -Compress -Depth 5
    }
    Write-Output $hw
} catch {
    @{ __error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

// ─── Remote Software Script (WinRM / Invoke-Command) ─────────────────────────
function buildSoftwareScript(credBlock: string): string {
  return `
${credBlock}
try {
    $sw = Invoke-Command -ComputerName $__target -Credential $__cred -ErrorAction Stop -ScriptBlock {
        $regPaths = @(
            'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
        )
        $apps = @()
        foreach ($base in $regPaths) {
            $items = Get-ItemProperty "$base\\*" -ErrorAction SilentlyContinue
            if ($items) {
                foreach ($item in $items) {
                    $displayName = $item.DisplayName
                    if ($displayName -and $displayName.Trim() -ne '') {
                        $subKeyName = Split-Path $item.PSPath -Leaf
                        $apps += @{
                            ApplicationName = $displayName
                            Version         = if ($item.DisplayVersion) { $item.DisplayVersion } else { '' }
                            Publisher       = if ($item.Publisher)       { $item.Publisher }       else { '' }
                            InstallDate     = if ($item.InstallDate)     { $item.InstallDate }     else { '' }
                            SerialNumber    = if ($item.ProductID)       { $item.ProductID }       else { '' }
                            RegistryPath    = "HKEY_LOCAL_MACHINE\\" + ($base -replace 'HKLM:\\\\', '') + "\\$subKeyName"
                        }
                    }
                }
            }
        }
        $apps | ConvertTo-Json -Compress -Depth 3
    }
    Write-Output $sw
} catch {
    @{ __error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

// ─── Remote Connection Test (WinRM / Invoke-Command) ─────────────────────────
function buildConnectionTestScript(credBlock: string): string {
  return `
try {
${credBlock}
    # Fast TCP pre-check: WinRM ignores PSSessionOption timeouts for unreachable
    # hosts and can hang for 20+ seconds. Use TcpClient.Wait() instead.
    $tcp = New-Object System.Net.Sockets.TcpClient
    $conn = $tcp.ConnectAsync($__target, 5985)
    $portOpen = $conn.Wait(3000) -and -not $conn.IsFaulted
    try { $tcp.Close() } catch {}

    if (-not $portOpen) {
        Write-Output (@{ success = $false; __error = "WinRM port 5985 is not reachable on $__target" } | ConvertTo-Json -Compress)
    } else {
        $so = New-PSSessionOption -OpenTimeout 6000 -OperationTimeout 6000
        $result = Invoke-Command -ComputerName $__target -Credential $__cred -SessionOption $so -ErrorAction Stop -ScriptBlock {
            @{ success = $true; caption = (Get-WmiObject Win32_OperatingSystem).Caption } | ConvertTo-Json -Compress
        }
        Write-Output $result
    }
} catch {
    $ErrorActionPreference = 'Continue'
    $errMsg = if ($_.Exception) { [string]$_.Exception.Message } else { [string]$_.ToString() }
    Write-Output (@{ success = $false; __error = $errMsg } | ConvertTo-Json -Compress)
}
`;
}

// ─── Local Connection Test (direct WMI — no WinRM) ───────────────────────────
function buildLocalConnectionTestScript(): string {
  return `
$ErrorActionPreference = 'Stop'
try {
    $caption = (Get-WmiObject Win32_OperatingSystem).Caption
    if (-not $caption) { $caption = '' }
    Write-Output (@{ success = $true; caption = $caption } | ConvertTo-Json -Compress)
} catch {
    $errMsg = if ($_.Exception) { [string]$_.Exception.Message } else { [string]$_.ToString() }
    Write-Output (@{ success = $false; __error = $errMsg } | ConvertTo-Json -Compress)
}
`;
}

// ─── Local Hardware Script (direct WMI — no WinRM) ───────────────────────────
function buildLocalHardwareScript(): string {
  return `
$ErrorActionPreference = 'Stop'
try {
    $cs      = Get-WmiObject Win32_ComputerSystem
    $os      = Get-WmiObject Win32_OperatingSystem
    $cpuArr  = @(Get-WmiObject Win32_Processor)
    $diskArr = @(Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3")
    $gpuArr  = @(Get-WmiObject Win32_VideoController)
    $netArr  = @(Get-WmiObject Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True")
    $csp     = Get-WmiObject Win32_ComputerSystemProduct -ErrorAction SilentlyContinue
    $lic     = @(Get-WmiObject SoftwareLicensingProduct -Filter "ApplicationId='55c92734-d682-4d71-983e-d6ec3f16059f' AND LicenseStatus=1" -ErrorAction SilentlyContinue)

    $totalCores = 0
    foreach ($c in $cpuArr) { $totalCores += $c.NumberOfCores }
    $coresPerSocket = if ($cpuArr.Count -gt 0) { $cpuArr[0].NumberOfCores } else { 0 }

    $diskList = @($diskArr | ForEach-Object { @{ DeviceId = $_.DeviceID; SizeGB = [math]::Round($_.Size / 1GB, 2) } })
    $netList  = @($netArr | ForEach-Object {
        $ipArr = if ($_.IPAddress) { @($_.IPAddress) } else { @() }
        @{ Name = $_.Description; MacAddress = $_.MACAddress; IpAddresses = $ipArr }
    })

    $osInstallDate = ''
    try { $osInstallDate = $os.ConvertToDateTime($os.InstallDate).ToString('yyyy-MM-ddTHH:mm:ssK') } catch {}

    $licName = ''; $licDesc = ''; $licKey = ''
    if ($lic.Count -gt 0) {
        $licName = if ($lic[0].Name)              { $lic[0].Name }              else { '' }
        $licDesc = if ($lic[0].Description)       { $lic[0].Description }       else { '' }
        $licKey  = if ($lic[0].ProductKeyLastFive) { $lic[0].ProductKeyLastFive } else { '' }
    }
    $cspName = ''; $cspVendor = ''; $cspVersion = ''
    if ($csp) {
        $cspName    = if ($csp.Name)    { $csp.Name }    else { '' }
        $cspVendor  = if ($csp.Vendor)  { $csp.Vendor }  else { '' }
        $cspVersion = if ($csp.Version) { $csp.Version } else { '' }
    }

    @{
        Hostname                  = if ($cs.Name)             { $cs.Name }             else { '' }
        Domain                    = if ($cs.Domain)           { $cs.Domain }           else { '' }
        HypervisorPresent         = [bool]$cs.HypervisorPresent
        Manufacturer              = if ($cs.Manufacturer)     { $cs.Manufacturer }     else { '' }
        Model                     = if ($cs.Model)            { $cs.Model }            else { '' }
        NumberOfLogicalProcessors = [int]$cs.NumberOfLogicalProcessors
        NumberOfProcessors        = [int]$cs.NumberOfProcessors
        PartOfDomain              = [bool]$cs.PartOfDomain
        SystemFamily              = if ($cs.SystemFamily)     { $cs.SystemFamily }     else { '' }
        SystemSKUNumber           = if ($cs.SystemSKUNumber)  { $cs.SystemSKUNumber }  else { '' }
        SystemType                = if ($cs.SystemType)       { $cs.SystemType }       else { '' }
        TotalPhysicalMemoryGB     = [math]::Round($cs.TotalPhysicalMemory / 1GB, 2)
        PrimaryUserName           = if ($cs.UserName)         { $cs.UserName }         else { '' }
        BootDevice                = if ($os.BootDevice)       { $os.BootDevice }       else { '' }
        BuildNumber               = if ($os.BuildNumber)      { $os.BuildNumber }      else { '' }
        OperatingSystem           = if ($os.Caption)          { $os.Caption }          else { '' }
        OsInstallDate             = $osInstallDate
        OsManufacturer            = if ($os.Manufacturer)     { $os.Manufacturer }     else { '' }
        LicenseName               = $licName
        LicenseDescription        = $licDesc
        LicenseProductKey         = $licKey
        OsName                    = if ($os.Caption)          { $os.Caption }          else { '' }
        OsArchitecture            = if ($os.OSArchitecture)   { $os.OSArchitecture }   else { '' }
        RegisteredUser            = if ($os.RegisteredUser)   { $os.RegisteredUser }   else { '' }
        WindowsDirectory          = if ($os.WindowsDirectory) { $os.WindowsDirectory } else { '' }
        CspName                   = $cspName; CspVendor = $cspVendor; CspVersion = $cspVersion
        Cpu                       = if ($cpuArr.Count -gt 0) { $cpuArr[0].Name }               else { '' }
        MaxClockSpeedMHz          = if ($cpuArr.Count -gt 0) { [int]$cpuArr[0].MaxClockSpeed }   else { 0 }
        CurrentClockSpeedMHz      = if ($cpuArr.Count -gt 0) { [int]$cpuArr[0].CurrentClockSpeed } else { 0 }
        Disks                     = $diskList; NumberOfDrives = $diskArr.Count
        GraphicsCard              = if ($gpuArr.Count -gt 0) { $gpuArr[0].Name } else { '' }
        NetworkAdapters           = $netList
        TotalSockets              = [int]$cs.NumberOfProcessors
        TotalCores                = $totalCores; CoresPerSocket = $coresPerSocket
    } | ConvertTo-Json -Compress -Depth 5
} catch {
    @{ __error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

// ─── Local Software Script (direct registry — no WinRM) ──────────────────────
function buildLocalSoftwareScript(): string {
  return `
$ErrorActionPreference = 'Stop'
try {
    $regPaths = @(
        'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    )
    $apps = @()
    foreach ($base in $regPaths) {
        $items = Get-ItemProperty "$base\\*" -ErrorAction SilentlyContinue
        if ($items) {
            foreach ($item in $items) {
                $displayName = $item.DisplayName
                if ($displayName -and $displayName.Trim() -ne '') {
                    $subKeyName = Split-Path $item.PSPath -Leaf
                    $apps += @{
                        ApplicationName = $displayName
                        Version         = if ($item.DisplayVersion) { $item.DisplayVersion } else { '' }
                        Publisher       = if ($item.Publisher)       { $item.Publisher }       else { '' }
                        InstallDate     = if ($item.InstallDate)     { $item.InstallDate }     else { '' }
                        SerialNumber    = if ($item.ProductID)       { $item.ProductID }       else { '' }
                        RegistryPath    = "HKEY_LOCAL_MACHINE\\" + ($base -replace 'HKLM:\\\\', '') + "\\$subKeyName"
                    }
                }
            }
        }
    }
    $apps | ConvertTo-Json -Compress -Depth 3
} catch {
    @{ __error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

// ─── Method Class ─────────────────────────────────────────────────────────────
export class PowerShellMethod extends BaseMethod {
  readonly methodName = ScanMethod.POWERSHELL;

  async testConnection(target: string, credentials: ScanCredentials): Promise<ConnectionTestResult> {
    try {
      const local  = isLocalTarget(target);
      const script = local
        ? buildLocalConnectionTestScript()
        : buildConnectionTestScript(buildCredentialBlock(target, credentials));
      const result = await executePowerShell(script, {
        timeoutMs: appConfig.ps.connectTimeoutMs,
        context: `${this.methodName}:testConnection:${target}`,
      });
      if (!result.stdout.trim()) {
        return { success: false, target, method: this.methodName, error: 'PowerShell returned no output' };
      }
      const parsed = this.parseJson<{ success: boolean; __error?: string }>(result.stdout, 'testConnection');
      return { success: parsed.success, target, method: this.methodName, ...(parsed.__error ? { error: parsed.__error } : {}) };
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
    const local  = isLocalTarget(target);
    const script = local
      ? buildLocalHardwareScript()
      : buildHardwareScript(buildCredentialBlock(target, credentials));
    const result = await executePowerShell(script, {
      timeoutMs: appConfig.ps.executionTimeoutMs,
      context: `${this.methodName}:hardware:${target}`,
    });
    return this.parseJson<HardwareInfo>(result.stdout, 'hardware');
  }

  async fetchSoftwareInfo(target: string, credentials: ScanCredentials): Promise<SoftwareEntry[]> {
    const local  = isLocalTarget(target);
    const script = local
      ? buildLocalSoftwareScript()
      : buildSoftwareScript(buildCredentialBlock(target, credentials));
    const result = await executePowerShell(script, {
      timeoutMs: appConfig.ps.executionTimeoutMs,
      context: `${this.methodName}:software:${target}`,
    });
    const parsed = this.parseJson<SoftwareEntry[] | SoftwareEntry>(result.stdout, 'software');
    return Array.isArray(parsed) ? parsed : [parsed];
  }
}
