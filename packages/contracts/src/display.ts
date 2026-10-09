export const DISPLAY_WIDTH = 800;
export const DISPLAY_HEIGHT = 480;
export const DISPLAY_PAGE_IDS = ["overview", "stocks"] as const;

export type DisplayPageId = (typeof DISPLAY_PAGE_IDS)[number];

export interface DisplayPageDescriptor {
  id: DisplayPageId;
  title: string;
  version: `sha256:${string}`;
  imageUrl: string;
  width: typeof DISPLAY_WIDTH;
  height: typeof DISPLAY_HEIGHT;
  format: "png";
  updatedAt: string;
}

// "unknown" means presence tracking is disabled on the server.
export type DisplayPresence = "present" | "away" | "unknown";

export interface DisplayManifest {
  schemaVersion: 1;
  generatedAt: string;
  refreshAfterSeconds: number;
  defaultPage: DisplayPageId;
  // Additive schema-1 fields; older firmware ignores them.
  presence: DisplayPresence;
  holdRedraws: boolean;
  // While held, the device may still redraw a changed page once per this many
  // seconds since its last panel refresh. 0 means fully held.
  awayRedrawSeconds: number;
  pages: DisplayPageDescriptor[];
}
