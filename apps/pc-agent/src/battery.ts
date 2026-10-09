import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BATTERY_DEVICE_IDS, parseBatteryReport, type BatteryDeviceId, type BatteryReport } from "../../../packages/contracts/src/battery.js";

export interface BatteryDeviceConfig { id: BatteryDeviceId; name: string }

export function parseBatteryConfig(value: unknown): BatteryDeviceConfig[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Invalid battery device configuration");
  const devices = value.map((device): BatteryDeviceConfig => {
    const entry = (device ?? {}) as Record<string, unknown>;
    if (!BATTERY_DEVICE_IDS.includes(entry.id as BatteryDeviceId) || typeof entry.name !== "string" ||
        !entry.name.trim()) {
      throw new Error("Invalid battery device configuration");
    }
    return { id: entry.id as BatteryDeviceId, name: entry.name.trim() };
  });
  if (new Set(devices.map(device => device.id)).size !== devices.length) {
    throw new Error("Invalid battery device configuration");
  }
  return devices;
}

// Read existing Windows state only (no pairing or GATT); System-class Hands-Free nodes hold live values.
const helperScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$config = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Enumeration.DeviceInformation,Windows,ContentType=WindowsRuntime]
$null = [Windows.Devices.Enumeration.DeviceInformationCollection,Windows,ContentType=WindowsRuntime]
$null = [Windows.Devices.Bluetooth.BluetoothDevice,Windows,ContentType=WindowsRuntime]
$selector = [Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelectorFromPairingState($true)
$operation = [Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector,[string[]]@('System.Devices.Aep.IsConnected'))
$method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation')
} | Select-Object -First 1
$task = $method.MakeGenericMethod([Windows.Devices.Enumeration.DeviceInformationCollection]).Invoke($null,@($operation))
if (-not $task.Wait(8000)) { $operation.Cancel(); throw 'Bluetooth enumeration timed out' }
$connected = @{}
foreach ($device in $task.Result) {
  foreach ($property in $device.Properties) {
    if ($property.Key -eq 'System.Devices.Aep.IsConnected' -and $property.Value -eq $true) {
      $connected[$device.Name] = $true
    }
  }
}
$nodes = @(Get-PnpDevice -Class System -PresentOnly -ErrorAction Stop)
$observedAt = [DateTime]::UtcNow.ToString('o')
$readings = @(foreach ($entry in $config) {
  $isConnected = $connected[$entry.name] -eq $true
  $percent = $null
  if ($isConnected) {
    foreach ($suffix in @(' Hands-Free AG',' Hands-Free HF')) {
      $matches = @($nodes | Where-Object { $_.FriendlyName -eq ($entry.name + $suffix) -and $_.Status -eq 'OK' })
      # Ambiguous records must not become another device's battery reading.
      if ($matches.Count -ne 1) { continue }
      $property = Get-PnpDeviceProperty -InstanceId $matches[0].InstanceId -KeyName '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2' -ErrorAction SilentlyContinue
      if ($null -ne $property -and $property.Data -is [byte] -and $property.Data -le 100) {
        $percent = [int]$property.Data
        break
      }
    }
  }
  @{id=$entry.id; percent=$percent; connected=$isConnected; observedAt=$(if ($null -ne $percent) {$observedAt} else {$null})}
})
@{schemaVersion=1; measuredAt=$observedAt; devices=$readings} | ConvertTo-Json -Compress -Depth 4
`;

export async function readBatteryUsage(): Promise<BatteryReport | undefined> {
  if (process.platform !== "win32") return undefined;
  const path = resolve(process.env.INKPULSE_BATTERY_CONFIG_FILE ?? "config/battery.local.json");
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.INKPULSE_BATTERY_CONFIG_FILE) return undefined;
    throw new Error("Could not read battery device configuration");
  }
  const devices = parseBatteryConfig(JSON.parse(raw));
  const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(helperScript, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 20_000, maxBuffer: 32_768 }, (error, stdout) => {
      if (error) reject(new Error("Bluetooth battery collection failed"));
      else resolveOutput(stdout);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(devices));
  });
  return parseBatteryReport(JSON.parse(output.trim()));
}
