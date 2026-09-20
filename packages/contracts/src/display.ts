export const DISPLAY_WIDTH = 800;
export const DISPLAY_HEIGHT = 480;
export const DISPLAY_PAGE_IDS = ["overview", "stocks", "codex"] as const;

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

export interface DisplayManifest {
  schemaVersion: 1;
  generatedAt: string;
  refreshAfterSeconds: number;
  defaultPage: DisplayPageId;
  pages: DisplayPageDescriptor[];
}
