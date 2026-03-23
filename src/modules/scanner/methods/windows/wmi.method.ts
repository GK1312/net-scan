/**
 * WMI method — PowerShell INDEPENDENT.
 * Uses VBScript (cscript.exe) with WbemScripting.SWbemLocator over DCOM.
 * No powershell.exe is ever invoked.
 *
 * Requirements on target:
 *   - Ports: 135 (RPC endpoint mapper) + dynamic high ports
 *   - Services: Remote Registry, Windows Management Instrumentation
 *   - Firewall: "Windows Management Instrumentation (WMI)" exception enabled
 *
 * Use this method when the client has PowerShell disabled/restricted.
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
  buildVbsCredentialBlock,
  executeVBScript,
} from '../../../../utils/vbscript.util';
import { parsePsOutput } from '../../../../utils/powershell.util';
import { tcpPortCheck, isLocalTarget } from '../../../../utils/ssh.util';
import { appConfig } from '../../../../config/app.config';

// ─── Shared VBScript JSON helpers (injected at top of every script) ───────────
const VBS_HELPERS = `
Function JStr(s)
    Dim i, c, code, result, v, hx
    If IsNull(s) Or IsEmpty(s) Then JStr = "null" : Exit Function
    v = CStr(s)
    result = ""
    For i = 1 To Len(v)
        c = Mid(v, i, 1)
        code = AscW(c)
        If code < 0 Then code = code + 65536
        If code = 34 Then
            result = result & "\\"""
        ElseIf code = 92 Then
            result = result & "\\\\"
        ElseIf code = 10 Then
            result = result & "\\n"
        ElseIf code = 13 Then
            result = result & "\\r"
        ElseIf code = 9 Then
            result = result & "\\t"
        ElseIf code < 32 Then
            hx = Hex(code)
            result = result & "\\u00" & Right("0" & hx, 2)
        ElseIf code > 127 Then
            hx = Hex(code)
            result = result & "\\u" & Right("000" & hx, 4)
        Else
            result = result & c
        End If
    Next
    JStr = """" & result & """"
End Function

Function JNum(n)
    On Error Resume Next
    If IsNull(n) Or IsEmpty(n) Then JNum = "0" : Exit Function
    Dim v : v = CLng(n)
    If Err.Number <> 0 Then Err.Clear : JNum = "0" Else JNum = CStr(v)
End Function

Function JBool(b)
    On Error Resume Next
    If IsNull(b) Or IsEmpty(b) Then JBool = "false" : Exit Function
    If CBool(b) Then JBool = "true" Else JBool = "false"
End Function

Function JDblGB(bytes)
    On Error Resume Next
    If IsNull(bytes) Or IsEmpty(bytes) Then JDblGB = "0" : Exit Function
    Dim gb : gb = CDbl(bytes) / 1073741824
    If Err.Number <> 0 Then Err.Clear : JDblGB = "0" : Exit Function
    gb = Int(gb * 100 + 0.5) / 100
    JDblGB = CStr(gb)
End Function

Function JDblSizeGB(bytes)
    On Error Resume Next
    If IsNull(bytes) Or IsEmpty(bytes) Then JDblSizeGB = "0" : Exit Function
    Dim gb : gb = CDbl(bytes) / 1073741824
    If Err.Number <> 0 Then Err.Clear : JDblSizeGB = "0" : Exit Function
    gb = Int(gb * 100 + 0.5) / 100
    JDblSizeGB = CStr(gb)
End Function
`;

// ─── Hardware Script ──────────────────────────────────────────────────────────
function buildHardwareScript(credBlock: string): string {
  return `
${VBS_HELPERS}

On Error Resume Next
${credBlock}

Dim locator, svc
Set locator = CreateObject("WbemScripting.SWbemLocator")
If Err.Number <> 0 Then
    WScript.StdOut.Write "{""__error"":" & JStr("WMI locator failed: " & Err.Description) & "}"
    WScript.Quit 1
End If
Err.Clear

If sUser = "" Then
    Set svc = locator.ConnectServer(sTarget, "root\\cimv2")
Else
    Set svc = locator.ConnectServer(sTarget, "root\\cimv2", sUser, sPass)
End If
If Err.Number <> 0 Then
    WScript.StdOut.Write "{""__error"":" & JStr("WMI connect failed: " & Err.Description) & "}"
    WScript.Quit 1
End If
svc.Security_.ImpersonationLevel = 3
svc.Security_.AuthenticationLevel = 6
Err.Clear

' ── Win32_ComputerSystem ─────────────────────────────────────────────────────
Dim csName, csDomain, csHyper, csMfr, csModel
Dim csLogProc, csNumProc, csPartDomain, csSysFamily, csSKU, csSysType, csTotalMem, csPrimUser
csName="":csDomain="":csHyper=False:csMfr="":csModel=""
csLogProc=0:csNumProc=0:csPartDomain=False:csSysFamily="":csSKU="":csSysType="":csTotalMem=0:csPrimUser=""

Dim cs
For Each cs In svc.ExecQuery("SELECT Name,Domain,HypervisorPresent,Manufacturer,Model,NumberOfLogicalProcessors,NumberOfProcessors,PartOfDomain,SystemFamily,SystemSKUNumber,SystemType,TotalPhysicalMemory,UserName FROM Win32_ComputerSystem")
    csName=cs.Name: csDomain=cs.Domain
    If Not IsNull(cs.HypervisorPresent) Then csHyper=cs.HypervisorPresent
    csMfr=cs.Manufacturer: csModel=cs.Model
    csLogProc=cs.NumberOfLogicalProcessors: csNumProc=cs.NumberOfProcessors
    If Not IsNull(cs.PartOfDomain) Then csPartDomain=cs.PartOfDomain
    csSysFamily=cs.SystemFamily: csSKU=cs.SystemSKUNumber
    csSysType=cs.SystemType: csTotalMem=cs.TotalPhysicalMemory: csPrimUser=cs.UserName
    Exit For
Next
Err.Clear

' ── Win32_OperatingSystem ────────────────────────────────────────────────────
Dim osBoot,osBuild,osCaption,osInstall,osMfr,osName,osArch,osOwner,osWinDir
osBoot="":osBuild="":osCaption="":osInstall="":osMfr="":osName="":osArch="":osOwner="":osWinDir=""

Dim os
For Each os In svc.ExecQuery("SELECT BootDevice,BuildNumber,Caption,InstallDate,Manufacturer,Name,OSArchitecture,RegisteredUser,WindowsDirectory FROM Win32_OperatingSystem")
    osBoot=os.BootDevice: osBuild=os.BuildNumber: osCaption=os.Caption
    If Not IsNull(os.InstallDate) Then
        Dim dt : dt = os.ConvertToDateTime(os.InstallDate)
        osInstall = CStr(Year(dt)) & "-" & Right("0"&Month(dt),2) & "-" & Right("0"&Day(dt),2) & "T" & Right("0"&Hour(dt),2) & ":" & Right("0"&Minute(dt),2) & ":" & Right("0"&Second(dt),2)
    End If
    osMfr=os.Manufacturer: osName=os.Name: osArch=os.OSArchitecture
    osOwner=os.RegisteredUser: osWinDir=os.WindowsDirectory
    Exit For
Next
If InStr(osName,"|") > 0 Then osName = Left(osName, InStr(osName,"|")-1)
Err.Clear

' ── Win32_Processor ──────────────────────────────────────────────────────────
Dim cpuName,cpuMax,cpuCurr,cpuCount,cpuCores,totalCores
cpuName="":cpuMax=0:cpuCurr=0:cpuCount=0:cpuCores=0:totalCores=0

Dim cpu
For Each cpu In svc.ExecQuery("SELECT Name,MaxClockSpeed,CurrentClockSpeed,NumberOfCores FROM Win32_Processor")
    If cpuCount = 0 Then cpuName=cpu.Name: cpuMax=cpu.MaxClockSpeed: cpuCurr=cpu.CurrentClockSpeed: cpuCores=cpu.NumberOfCores
    If Not IsNull(cpu.NumberOfCores) Then totalCores = totalCores + cpu.NumberOfCores
    cpuCount = cpuCount + 1
Next
Err.Clear

' ── Win32_LogicalDisk ────────────────────────────────────────────────────────
Dim diskJson, diskCount
diskJson="[": diskCount=0

Dim dk
For Each dk In svc.ExecQuery("SELECT DeviceID,Size FROM Win32_LogicalDisk WHERE DriveType=3")
    If diskCount > 0 Then diskJson = diskJson & ","
    Dim dkSz : dkSz = 0
    If Not IsNull(dk.Size) Then dkSz = Int(CDbl(dk.Size)/1073741824*100+0.5)/100
    diskJson = diskJson & "{""DeviceId"":" & JStr(dk.DeviceID) & ",""SizeGB"":" & CStr(dkSz) & "}"
    diskCount = diskCount + 1
Next
diskJson = diskJson & "]"
Err.Clear

' ── Win32_VideoController ────────────────────────────────────────────────────
Dim gpuName : gpuName=""
Dim gpu
For Each gpu In svc.ExecQuery("SELECT Name FROM Win32_VideoController")
    gpuName=gpu.Name: Exit For
Next
Err.Clear

' ── Win32_NetworkAdapterConfiguration ────────────────────────────────────────
Dim netJson, netCount
netJson="[": netCount=0

Dim net
For Each net In svc.ExecQuery("SELECT Description,MACAddress,IPAddress FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled=True")
    If netCount > 0 Then netJson = netJson & ","
    Dim ipJson : ipJson="["
    If Not IsNull(net.IPAddress) Then
        Dim ipArr : ipArr = net.IPAddress
        Dim ii
        For ii = 0 To UBound(ipArr)
            If ii > 0 Then ipJson = ipJson & ","
            ipJson = ipJson & JStr(ipArr(ii))
        Next
    End If
    ipJson = ipJson & "]"
    netJson = netJson & "{""Name"":" & JStr(net.Description) & ",""MacAddress"":" & JStr(net.MACAddress) & ",""IpAddresses"":" & ipJson & "}"
    netCount = netCount + 1
Next
netJson = netJson & "]"
Err.Clear

' ── Win32_ComputerSystemProduct ──────────────────────────────────────────────
Dim cspName,cspVendor,cspVersion : cspName="":cspVendor="":cspVersion=""
Dim csp
For Each csp In svc.ExecQuery("SELECT Name,Vendor,Version FROM Win32_ComputerSystemProduct")
    cspName=csp.Name: cspVendor=csp.Vendor: cspVersion=csp.Version: Exit For
Next
Err.Clear

' ── SoftwareLicensingProduct ─────────────────────────────────────────────────
Dim licName,licDesc,licKey : licName="":licDesc="":licKey=""
Dim lic
For Each lic In svc.ExecQuery("SELECT Name,Description,ProductKeyLastFive FROM SoftwareLicensingProduct WHERE ApplicationId='55c92734-d682-4d71-983e-d6ec3f16059f' AND LicenseStatus=1")
    licName=lic.Name: licDesc=lic.Description: licKey=lic.ProductKeyLastFive: Exit For
Next
Err.Clear

' ── Output JSON ──────────────────────────────────────────────────────────────
Dim o
o = "{"
o = o & """Hostname"":" & JStr(csName) & ","
o = o & """Domain"":" & JStr(csDomain) & ","
o = o & """HypervisorPresent"":" & JBool(csHyper) & ","
o = o & """Manufacturer"":" & JStr(csMfr) & ","
o = o & """Model"":" & JStr(csModel) & ","
o = o & """NumberOfLogicalProcessors"":" & JNum(csLogProc) & ","
o = o & """NumberOfProcessors"":" & JNum(csNumProc) & ","
o = o & """PartOfDomain"":" & JBool(csPartDomain) & ","
o = o & """SystemFamily"":" & JStr(csSysFamily) & ","
o = o & """SystemSKUNumber"":" & JStr(csSKU) & ","
o = o & """SystemType"":" & JStr(csSysType) & ","
o = o & """TotalPhysicalMemoryGB"":" & JDblGB(csTotalMem) & ","
o = o & """PrimaryUserName"":" & JStr(csPrimUser) & ","
o = o & """BootDevice"":" & JStr(osBoot) & ","
o = o & """BuildNumber"":" & JStr(osBuild) & ","
o = o & """OperatingSystem"":" & JStr(osCaption) & ","
o = o & """OsInstallDate"":" & JStr(osInstall) & ","
o = o & """OsManufacturer"":" & JStr(osMfr) & ","
o = o & """LicenseName"":" & JStr(licName) & ","
o = o & """LicenseDescription"":" & JStr(licDesc) & ","
o = o & """LicenseProductKey"":" & JStr(licKey) & ","
o = o & """OsName"":" & JStr(osName) & ","
o = o & """OsArchitecture"":" & JStr(osArch) & ","
o = o & """RegisteredUser"":" & JStr(osOwner) & ","
o = o & """WindowsDirectory"":" & JStr(osWinDir) & ","
o = o & """CspName"":" & JStr(cspName) & ","
o = o & """CspVendor"":" & JStr(cspVendor) & ","
o = o & """CspVersion"":" & JStr(cspVersion) & ","
o = o & """Cpu"":" & JStr(cpuName) & ","
o = o & """MaxClockSpeedMHz"":" & JNum(cpuMax) & ","
o = o & """CurrentClockSpeedMHz"":" & JNum(cpuCurr) & ","
o = o & """Disks"":" & diskJson & ","
o = o & """NumberOfDrives"":" & CStr(diskCount) & ","
o = o & """GraphicsCard"":" & JStr(gpuName) & ","
o = o & """NetworkAdapters"":" & netJson & ","
o = o & """TotalSockets"":" & JNum(csNumProc) & ","
o = o & """TotalCores"":" & CStr(totalCores) & ","
o = o & """CoresPerSocket"":" & JNum(cpuCores)
o = o & "}"
WScript.StdOut.Write(o)
`;
}

// ─── Software Script (StdRegProv via WMI — no PS) ────────────────────────────
function buildSoftwareScript(credBlock: string): string {
  return `
${VBS_HELPERS}

On Error Resume Next
${credBlock}

Dim locator, svc
Set locator = CreateObject("WbemScripting.SWbemLocator")
If Err.Number <> 0 Then
    WScript.StdOut.Write "{""__error"":""WMI locator failed""}"
    WScript.Quit 1
End If
If sUser = "" Then
    Set svc = locator.ConnectServer(sTarget, "root\\default")
Else
    Set svc = locator.ConnectServer(sTarget, "root\\default", sUser, sPass)
End If
If Err.Number <> 0 Then
    WScript.StdOut.Write "{""__error"":" & JStr("WMI connect failed: " & Err.Description) & "}"
    WScript.Quit 1
End If
svc.Security_.ImpersonationLevel = 3
svc.Security_.AuthenticationLevel = 6
Err.Clear

Dim oReg
Set oReg = svc.Get("StdRegProv")

Const HKLM = &H80000002

Dim paths(1)
paths(0) = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
paths(1) = "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"

Dim appsJson : appsJson = "["
Dim isFirst : isFirst = True

Dim p
For p = 0 To 1
    ' EnumKey
    Dim oEnumIn, oEnumOut
    Set oEnumIn = oReg.Methods_("EnumKey").InParameters.SpawnInstance_()
    oEnumIn.hDefKey      = HKLM
    oEnumIn.sSubKeyName  = paths(p)
    Set oEnumOut = oReg.ExecMethod_("EnumKey", oEnumIn)

    If Not IsNull(oEnumOut) And oEnumOut.ReturnValue = 0 Then
        Dim subkeys : subkeys = oEnumOut.sNames
        If Not IsNull(subkeys) Then
            Dim k
            For Each k In subkeys
                Dim fullPath : fullPath = paths(p) & "\\" & k

                ' GetStringValue for DisplayName
                Dim oGSIn, oGSOut
                Set oGSIn = oReg.Methods_("GetStringValue").InParameters.SpawnInstance_()
                oGSIn.hDefKey      = HKLM
                oGSIn.sSubKeyName  = fullPath
                oGSIn.sValueName   = "DisplayName"
                Set oGSOut = oReg.ExecMethod_("GetStringValue", oGSIn)
                Dim displayName : displayName = ""
                If Not IsNull(oGSOut) Then displayName = oGSOut.sValue

                If Not IsNull(displayName) And Trim(displayName) <> "" Then
                    ' Helper: get any string value
                    Dim oIn2, oOut2

                    Set oIn2 = oReg.Methods_("GetStringValue").InParameters.SpawnInstance_()
                    oIn2.hDefKey = HKLM : oIn2.sSubKeyName = fullPath : oIn2.sValueName = "DisplayVersion"
                    Set oOut2 = oReg.ExecMethod_("GetStringValue", oIn2)
                    Dim sVer : sVer = "" : If Not IsNull(oOut2) Then sVer = oOut2.sValue : If IsNull(sVer) Then sVer = ""

                    Set oIn2 = oReg.Methods_("GetStringValue").InParameters.SpawnInstance_()
                    oIn2.hDefKey = HKLM : oIn2.sSubKeyName = fullPath : oIn2.sValueName = "Publisher"
                    Set oOut2 = oReg.ExecMethod_("GetStringValue", oIn2)
                    Dim sPub : sPub = "" : If Not IsNull(oOut2) Then sPub = oOut2.sValue : If IsNull(sPub) Then sPub = ""

                    Set oIn2 = oReg.Methods_("GetStringValue").InParameters.SpawnInstance_()
                    oIn2.hDefKey = HKLM : oIn2.sSubKeyName = fullPath : oIn2.sValueName = "InstallDate"
                    Set oOut2 = oReg.ExecMethod_("GetStringValue", oIn2)
                    Dim sDate : sDate = "" : If Not IsNull(oOut2) Then sDate = oOut2.sValue : If IsNull(sDate) Then sDate = ""

                    Set oIn2 = oReg.Methods_("GetStringValue").InParameters.SpawnInstance_()
                    oIn2.hDefKey = HKLM : oIn2.sSubKeyName = fullPath : oIn2.sValueName = "ProductID"
                    Set oOut2 = oReg.ExecMethod_("GetStringValue", oIn2)
                    Dim sSN : sSN = "" : If Not IsNull(oOut2) Then sSN = oOut2.sValue : If IsNull(sSN) Then sSN = ""

                    If Not isFirst Then appsJson = appsJson & ","
                    isFirst = False
                    appsJson = appsJson & "{"
                    appsJson = appsJson & """ApplicationName"":" & JStr(displayName) & ","
                    appsJson = appsJson & """Version"":" & JStr(sVer) & ","
                    appsJson = appsJson & """Publisher"":" & JStr(sPub) & ","
                    appsJson = appsJson & """InstallDate"":" & JStr(sDate) & ","
                    appsJson = appsJson & """SerialNumber"":" & JStr(sSN) & ","
                    appsJson = appsJson & """RegistryPath"":""HKEY_LOCAL_MACHINE\\" & Replace(fullPath, "\\", "\\\\") & """"
                    appsJson = appsJson & "}"
                End If
                Err.Clear
            Next
        End If
    End If
    Err.Clear
Next

appsJson = appsJson & "]"
WScript.StdOut.Write(appsJson)
`;
}

// ─── Connection Test ──────────────────────────────────────────────────────────
function buildConnectionTestScript(credBlock: string): string {
  return `
${VBS_HELPERS}

On Error Resume Next
${credBlock}

Dim locator, svc
Set locator = CreateObject("WbemScripting.SWbemLocator")
If Err.Number <> 0 Then
    WScript.StdOut.Write "{""success"":false,""__error"":""WMI locator failed""}"
    WScript.Quit 1
End If
If sUser = "" Then
    Set svc = locator.ConnectServer(sTarget, "root\\cimv2")
Else
    Set svc = locator.ConnectServer(sTarget, "root\\cimv2", sUser, sPass)
End If
If Err.Number <> 0 Then
    WScript.StdOut.Write "{""success"":false,""__error"":" & JStr(Err.Description) & "}"
    WScript.Quit 1
End If
svc.Security_.ImpersonationLevel = 3
svc.Security_.AuthenticationLevel = 6
Err.Clear

Dim caption : caption = ""
Dim os
For Each os In svc.ExecQuery("SELECT Caption FROM Win32_OperatingSystem")
    caption = os.Caption: Exit For
Next

If Err.Number <> 0 Then
    WScript.StdOut.Write "{""success"":false,""__error"":" & JStr(Err.Description) & "}"
Else
    WScript.StdOut.Write "{""success"":true,""caption"":" & JStr(caption) & "}"
End If
`;
}

// ─── Local-target credential block ────────────────────────────────────────────
// When scanning the local machine via its own IP, Windows UAC remote token
// filtering strips admin privileges from the DCOM connection, causing access
// denied even with correct credentials.  Connecting via "." (no network path)
// uses the current process security context and bypasses UAC filtering.
function localCredBlock(): string {
  return `Dim sTarget, sUser, sPass\nsTarget = "."\nsUser = ""\nsPass = ""\n`;
}

// ─── Method Class ─────────────────────────────────────────────────────────────
export class WmiMethod extends BaseMethod {
  readonly methodName = ScanMethod.WMI;

  async testConnection(target: string, credentials: ScanCredentials): Promise<ConnectionTestResult> {
    const local = isLocalTarget(target);

    // For remote targets do a fast TCP pre-check on the RPC endpoint mapper
    // port to avoid waiting out the full DCOM timeout on unreachable hosts.
    // Skip the check for local targets — local WMI uses IPC, not TCP 135.
    if (!local) {
      const portOpen = await tcpPortCheck(target, 135, 3000);
      if (!portOpen) {
        return { success: false, target, method: this.methodName, error: `WMI/RPC port 135 is not reachable on ${target}` };
      }
    }

    try {
      const credBlock = local ? localCredBlock() : buildVbsCredentialBlock(target, credentials);
      const result    = await executeVBScript(buildConnectionTestScript(credBlock), {
        timeoutMs: appConfig.ps.connectTimeoutMs,
        context: `${this.methodName}:testConnection:${target}`,
      });
      const parsed = parsePsOutput<{ success: boolean; __error?: string }>(result.stdout, 'testConnection');
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
    const credBlock = isLocalTarget(target) ? localCredBlock() : buildVbsCredentialBlock(target, credentials);
    const result    = await executeVBScript(buildHardwareScript(credBlock), {
      timeoutMs: appConfig.ps.executionTimeoutMs,
      context: `${this.methodName}:hardware:${target}`,
    });
    return parsePsOutput<HardwareInfo>(result.stdout, 'hardware');
  }

  async fetchSoftwareInfo(target: string, credentials: ScanCredentials): Promise<SoftwareEntry[]> {
    const credBlock = isLocalTarget(target) ? localCredBlock() : buildVbsCredentialBlock(target, credentials);
    const result    = await executeVBScript(buildSoftwareScript(credBlock), {
      timeoutMs: appConfig.ps.executionTimeoutMs,
      context: `${this.methodName}:software:${target}`,
    });
    const parsed = parsePsOutput<SoftwareEntry[] | SoftwareEntry>(result.stdout, 'software');
    return Array.isArray(parsed) ? parsed : [parsed];
  }
}
