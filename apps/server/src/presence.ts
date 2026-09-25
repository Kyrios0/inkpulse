import type { ActivityReport } from "../../../packages/contracts/src/activity.js";
import type { DisplayPresence } from "../../../packages/contracts/src/display.js";

export interface PresenceOptions {
  enabled: boolean;
  // No collector post for this long means the PC is asleep, off, or offline.
  collectorOfflineSeconds: number;
  // A changed AI usage reading releases the hold for this long, so a device
  // polling at its normal interval sees it at least once.
  aiReleaseSeconds: number;
}

export interface PresenceState {
  presence: DisplayPresence;
  holdRedraws: boolean;
}

export const defaultPresenceOptions: PresenceOptions = {
  enabled: true,
  collectorOfflineSeconds: 180,
  aiReleaseSeconds: 180,
};

// Tracks only the coarse PC classification, in memory. Missing activity is
// treated as present while posts continue (old or non-Windows collectors).
export class PresenceTracker {
  private lastPostAt: number | undefined;
  private away = true;
  private aiFingerprint: string | undefined;
  private aiChangedAt: number | undefined;

  constructor(private readonly options: PresenceOptions = defaultPresenceOptions) {}

  recordPost(activity: ActivityReport | undefined, now = Date.now()): void {
    if (this.lastPostAt === undefined ||
      now - this.lastPostAt > this.options.collectorOfflineSeconds * 1_000) this.away = true;
    this.lastPostAt = now;
    if (!activity || activity.presence === "present") this.away = false;
    else if (activity.presence === "away") this.away = true;
    // "transition" retains the prior state for hysteresis.
  }

  // Called with the displayed AI values after every render. Only a change in
  // what the pages show counts; collector online/offline labels do not.
  recordAiFingerprint(fingerprint: string, now = Date.now()): void {
    if (this.aiFingerprint !== undefined && fingerprint !== this.aiFingerprint) {
      this.aiChangedAt = now;
    }
    this.aiFingerprint = fingerprint;
  }

  state(now = Date.now()): PresenceState {
    if (!this.options.enabled) return { presence: "unknown", holdRedraws: false };
    const offline = this.lastPostAt === undefined ||
      now - this.lastPostAt > this.options.collectorOfflineSeconds * 1_000;
    if (offline) this.away = true;
    const aiReleased = this.aiChangedAt !== undefined &&
      now - this.aiChangedAt < this.options.aiReleaseSeconds * 1_000;
    return {
      presence: this.away ? "away" : "present",
      holdRedraws: this.away && !aiReleased,
    };
  }
}
