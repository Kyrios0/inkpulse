import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import type { ActivityReport } from "../../../packages/contracts/src/activity.js";

// Windows-only helper: one hidden PowerShell process compiles a tiny P/Invoke
// shim once, then answers "<idleSeconds> <locked>" for every request line.
// GetLastInputInfo only sees input for the interactive session it runs in, so
// the collector task must run as the signed-in user, not as a service.
// Session flags: WTSINFOEXW.Data (8-byte aligned union) + SessionId + State.
const helperScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class InkPulseActivity {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  [DllImport("wtsapi32.dll")] static extern bool WTSQuerySessionInformationW(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
  public static long IdleSeconds() {
    var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return -1;
    return unchecked(GetTickCount() - info.dwTime) / 1000;
  }
  public static int Locked() {
    IntPtr buffer; int bytes;
    if (!WTSQuerySessionInformationW(IntPtr.Zero, -1, 25, out buffer, out bytes)) return -1;
    try {
      if (bytes < 20 || Marshal.ReadInt32(buffer, 0) != 1) return -1;
      int flags = Marshal.ReadInt32(buffer, 16);
      return flags == 0 ? 1 : flags == 1 ? 0 : -1;
    } finally { WTSFreeMemory(buffer); }
  }
}
"@
while ($null -ne [Console]::In.ReadLine()) {
  [Console]::Out.WriteLine(('{0} {1}' -f [InkPulseActivity]::IdleSeconds(), [InkPulseActivity]::Locked()))
  [Console]::Out.Flush()
}
`;

interface LocalActivity {
  idleSeconds: number;
  locked: boolean;
}

export function parseActivityLine(line: string): LocalActivity | undefined {
  const match = /^(-?\d+) (-?1|0)$/.exec(line.trim());
  if (!match) return undefined;
  const idleSeconds = Number(match[1]);
  if (!Number.isSafeInteger(idleSeconds) || idleSeconds < 0 || idleSeconds > 4_294_967) return undefined;
  // An unknown lock state (-1) falls back to idle time alone.
  return { idleSeconds, locked: match[2] === "1" };
}

export function classifyActivity(activity: LocalActivity, presentWithinSeconds: number,
  awayAfterIdleSeconds: number): ActivityReport {
  if (activity.locked || activity.idleSeconds >= awayAfterIdleSeconds) return { presence: "away" };
  if (activity.idleSeconds <= presentWithinSeconds) return { presence: "present" };
  return { presence: "transition" };
}

function configuredSeconds(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

export class ActivityProbe {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private pending: ((line: string | undefined) => void) | undefined;

  private readonly presentWithinSeconds = configuredSeconds("INKPULSE_PRESENT_WITHIN_SECONDS", 120, 10, 3_600);
  private readonly awayAfterIdleSeconds = configuredSeconds("INKPULSE_AWAY_AFTER_IDLE_SECONDS", 600, 60, 86_400);

  constructor(private readonly timeoutMilliseconds = 10_000) {
    if (this.presentWithinSeconds >= this.awayAfterIdleSeconds) {
      throw new Error("INKPULSE_PRESENT_WITHIN_SECONDS must be less than INKPULSE_AWAY_AFTER_IDLE_SECONDS");
    }
  }

  // Resolves undefined when activity is unavailable (non-Windows, helper
  // failure). Only a coarse state is returned for upload; raw values never
  // leave this process or appear in logs.
  async read(): Promise<ActivityReport | undefined> {
    if (process.platform !== "win32") return undefined;
    try {
      const child = this.child ?? this.start();
      const line = await new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => {
          this.pending = undefined;
          resolve(undefined);
        }, this.timeoutMilliseconds);
        this.pending = (value) => {
          clearTimeout(timer);
          this.pending = undefined;
          resolve(value);
        };
        child.stdin.write("\n");
      });
      const local = line === undefined ? undefined : parseActivityLine(line);
      if (!local) this.stop();
      return local ? classifyActivity(local, this.presentWithinSeconds, this.awayAfterIdleSeconds) : undefined;
    } catch {
      this.stop();
      return undefined;
    }
  }

  stop(): void {
    this.lines?.close();
    this.child?.kill();
    this.child = undefined;
    this.lines = undefined;
    this.pending?.(undefined);
  }

  private start(): ChildProcessWithoutNullStreams {
    const encoded = Buffer.from(helperScript, "utf16le").toString("base64");
    const child = spawn("powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stderr.resume();
    child.once("error", () => this.stop());
    child.once("exit", () => {
      if (this.child === child) this.stop();
    });
    child.stdin.on("error", () => this.stop());
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.pending?.(line));
    this.child = child;
    return child;
  }
}
