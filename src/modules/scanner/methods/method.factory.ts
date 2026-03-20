import { ScanMethod } from '../../../types/scanner.types';
import { BaseMethod } from './base.method';
import { PowerShellMethod } from './windows/powershell.method';
import { WmiMethod } from './windows/wmi.method';
import { SshMethod } from './windows/ssh.method';
import { NodeWmiMethod } from './windows/node-wmi.method';
import { AppError, ErrorCode } from '../../../utils/app-error.util';

const instances = new Map<ScanMethod, BaseMethod>();

export function getMethod(method: ScanMethod): BaseMethod {
  if (!instances.has(method)) {
    let instance: BaseMethod;
    switch (method) {
      case ScanMethod.POWERSHELL:
        instance = new PowerShellMethod();
        break;
      case ScanMethod.WMI:
        instance = new WmiMethod();
        break;
      case ScanMethod.SSH:
        instance = new SshMethod();
        break;
      case ScanMethod.NODE_WMI:
        instance = new NodeWmiMethod();
        break;
      default:
        throw new AppError(400, ErrorCode.UNKNOWN_METHOD, `Unknown scan method: ${method as string}`);
    }
    instances.set(method, instance);
  }
  return instances.get(method) as BaseMethod;
}

export function getAvailableMethods(): Array<{
  id: ScanMethod;
  name: string;
  description: string;
  requirements: string;
  powershellRequired: boolean;
}> {
  return [
    {
      id: ScanMethod.POWERSHELL,
      name: 'PowerShell Remoting',
      description: 'Runs PowerShell scripts remotely via Invoke-Command over WinRM. Most complete data. Requires PowerShell access on target.',
      requirements: 'Port 5985 (HTTP) or 5986 (HTTPS). Target must have PowerShell Remoting enabled (Run: Enable-PSRemoting -Force).',
      powershellRequired: true,
    },
    {
      id: ScanMethod.WMI,
      name: 'WMI over DCOM (PowerShell-free)',
      description: 'Uses VBScript + cscript.exe with WbemScripting.SWbemLocator. Connects via DCOM/RPC. PowerShell is NOT required on either machine.',
      requirements: 'Port 135 (RPC) + dynamic high ports. Enable firewall exception: "Windows Management Instrumentation (WMI)". Services: WMI, Remote Registry must be running.',
      powershellRequired: false,
    },
    {
      id: ScanMethod.SSH,
      name: 'SSH (systeminfo + reg query)',
      description: 'Connects via SSH and runs CMD-native commands: systeminfo, ipconfig /all, reg query. No PowerShell or WMI/DCOM required.',
      requirements: 'Port 22. OpenSSH Server must be installed on target (Windows 10 1809+ optional feature: Settings → Apps → Optional Features → OpenSSH Server).',
      powershellRequired: false,
    },
    {
      id: ScanMethod.NODE_WMI,
      name: 'Node-WMI (native Node.js WMI client)',
      description: 'Uses the node-wmi npm package to query WMI over DCOM. Pure Node.js — no PowerShell, no VBScript, no temp files. Credentials stay in-memory. ⚠ Software scan uses Win32_Product (slow, MSI-only).',
      requirements: 'Port 135 (RPC) + dynamic high ports (49152-65535). Same DCOM requirements as the WMI method: WMI service + "Windows Management Instrumentation (WMI)" firewall exception on target.',
      powershellRequired: false,
    },
  ];
}
