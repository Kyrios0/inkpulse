import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  DISPLAY_HEIGHT,
  DISPLAY_PAGE_IDS,
  DISPLAY_WIDTH,
  type DisplayManifest,
  type DisplayPageId,
} from "../../../packages/contracts/src/display.js";
import {
  parseCodexUsageReport,
  type CodexUsageReport,
} from "../../../packages/contracts/src/codex.js";
import {
  parseActivityReport,
  type ActivityReport,
} from "../../../packages/contracts/src/activity.js";
import type { PresenceState } from "./presence.js";
import { parseBatteryReport, type BatteryReport } from "../../../packages/contracts/src/battery.js";
import type { RenderedPageSet } from "./renderer.js";

export interface ServerOptions {
  displayToken?: string;
  aiIngestToken?: string;
  onAiUsage?: (provider: "codex" | "claude", report: CodexUsageReport) => Promise<void>;
  onBattery?: (report: BatteryReport) => Promise<void>;
  // Called once per accepted collector post, with its activity block if sent.
  onCollectorPost?: (activity: ActivityReport | undefined) => void;
  presence?: () => PresenceState;
  awayRedrawSeconds?: number;
  refreshAfterSeconds?: number;
}

export type PageSetSource = RenderedPageSet | (() => RenderedPageSet);

export function createInkPulseServer(
  pageSetSource: PageSetSource,
  options: ServerOptions = {},
) {
  const refreshAfterSeconds = options.refreshAfterSeconds ?? 300;

  return createServer((request, response) => {
    void routeRequest(request, response, pageSetSource, {
      ...options,
      refreshAfterSeconds,
    }).catch((error: unknown) => {
      console.error("Request failed", error);
      if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
      else response.destroy();
    });
  });
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pageSetSource: PageSetSource,
  options: Required<Pick<ServerOptions, "refreshAfterSeconds">> & ServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pageSet =
    typeof pageSetSource === "function" ? pageSetSource() : pageSetSource;

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      pages: pageSet.pages.size,
      generatedAt: pageSet.generatedAt,
    });
    return;
  }

  if (["/api/v1/metrics/ai", "/api/v1/metrics/codex", "/api/v1/metrics/claude"].includes(url.pathname)) {
    if (request.method !== "PUT") {
      response.setHeader("Allow", "PUT");
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (!options.aiIngestToken || !options.onAiUsage) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!isAuthorized(request, options.aiIngestToken)) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="inkpulse-usage-ingest"');
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      sendJson(response, 415, { error: "content_type_must_be_json" });
      return;
    }

    try {
      const { reports, activity, battery } = parseUsagePayload(await readJsonBody(request, 8_192), url.pathname);
      if (battery && !options.onBattery) throw new SyntaxError("Battery ingest unavailable");
      if (reports.some(([, report]) => Date.parse(report.measuredAt) > Date.now() + 5 * 60_000) ||
          (battery && Date.parse(battery.measuredAt) > Date.now() + 5 * 60_000)) {
        sendJson(response, 400, { error: "measured_at_is_in_the_future" });
        return;
      }
      for (const [provider, report] of reports) await options.onAiUsage(provider, report);
      if (battery) await options.onBattery!(battery);
      options.onCollectorPost?.(activity);
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
    } catch (error) {
      if (error instanceof RequestBodyError) {
        sendJson(response, error.status, { error: error.code });
        return;
      }
      if (error instanceof SyntaxError || isValidationError(error)) {
        sendJson(response, 400, { error: "invalid_payload" });
        return;
      }
      throw error;
    }
    return;
  }

  if (url.pathname.startsWith("/api/v1/display/") && !isAuthorized(request, options.displayToken)) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="inkpulse-display"');
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/display/manifest") {
    response.setHeader("Cache-Control", "private, no-cache");
    const presence = options.presence?.() ?? { presence: "unknown", holdRedraws: false };
    sendJson(response, 200, buildManifest(pageSet, options.refreshAfterSeconds, presence,
      options.awayRedrawSeconds ?? 0));
    return;
  }

  const pageMatch = url.pathname.match(
    /^\/api\/v1\/display\/pages\/(overview|stocks|codex)\.png$/,
  );
  if (request.method === "GET" && pageMatch) {
    const pageId = pageMatch[1] as DisplayPageId;
    const page = pageSet.pages.get(pageId);
    if (!page) {
      sendJson(response, 404, { error: "page_not_found" });
      return;
    }

    const etag = `"${page.version}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { ETag: etag });
      response.end();
      return;
    }

    const hasVersionedUrl = url.searchParams.get("v") === page.version;
    response.writeHead(200, {
      "Cache-Control": hasVersionedUrl
        ? "private, max-age=31536000, immutable"
        : "private, no-cache",
      "Content-Length": page.png.length,
      "Content-Type": "image/png",
      ETag: etag,
    });
    response.end(page.png);
    return;
  }

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

interface UsagePayload {
  reports: Array<["codex" | "claude", CodexUsageReport]>;
  activity?: ActivityReport;
  battery?: BatteryReport;
}

function parseUsagePayload(value: unknown, pathname: string): UsagePayload {
  if (pathname === "/api/v1/metrics/claude") {
    return { reports: [["claude", parseCodexUsageReport(value)]] };
  }
  if (value && typeof value === "object" && "reports" in value) {
    const batch = value as { schemaVersion?: unknown; reports?: unknown; activity?: unknown; battery?: unknown };
    if (batch.schemaVersion !== 1 || !batch.reports || typeof batch.reports !== "object" || Array.isArray(batch.reports)) {
      throw new SyntaxError("Invalid AI usage batch");
    }
    const activity = batch.activity === undefined ? undefined : parseActivityReport(batch.activity);
    const battery = batch.battery === undefined ? undefined : parseBatteryReport(batch.battery);
    const reports = batch.reports as Record<string, unknown>;
    const providers = Object.keys(reports);
    // An activity-only batch keeps presence current when no provider has a reading.
    if ((!providers.length && !activity && !battery) || providers.some(provider => provider !== "codex" && provider !== "claude")) {
      throw new SyntaxError("Invalid AI usage provider");
    }
    return {
      reports: providers.map(provider => [provider as "codex" | "claude", parseCodexUsageReport(reports[provider])]),
      ...(activity ? { activity } : {}),
      ...(battery ? { battery } : {}),
    };
  }
  // Older collectors sent a single Codex report to this route.
  if (pathname === "/api/v1/metrics/codex") return { reports: [["codex", parseCodexUsageReport(value)]] };
  throw new SyntaxError("AI usage batch required");
}

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) throw new RequestBodyError(413, "payload_too_large");
    chunks.push(buffer);
  }
  if (length === 0) throw new RequestBodyError(400, "empty_payload");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("Invalid Codex") ||
      error.message.startsWith("Codex usage window") ||
      error.message === "Invalid activity report" || error.message === "Invalid battery report")
  );
}

function buildManifest(
  pageSet: RenderedPageSet,
  refreshAfterSeconds: number,
  presence: PresenceState,
  awayRedrawSeconds: number,
): DisplayManifest {
  return {
    schemaVersion: 1,
    generatedAt: pageSet.generatedAt,
    refreshAfterSeconds,
    defaultPage: "overview",
    presence: presence.presence,
    holdRedraws: presence.holdRedraws,
    awayRedrawSeconds,
    pages: DISPLAY_PAGE_IDS.map((id) => {
      const page = pageSet.pages.get(id);
      if (!page) throw new Error(`Missing rendered page: ${id}`);

      return {
        id,
        title: page.title,
        version: page.version,
        imageUrl: `/api/v1/display/pages/${id}.png?v=${encodeURIComponent(page.version)}`,
        width: DISPLAY_WIDTH,
        height: DISPLAY_HEIGHT,
        format: "png",
        updatedAt: page.updatedAt,
      };
    }),
  };
}

function isAuthorized(request: IncomingMessage, expectedToken?: string): boolean {
  if (!expectedToken) return true;
  const prefix = "Bearer ";
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith(prefix)) return false;

  const supplied = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "Content-Length": body.length,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}
