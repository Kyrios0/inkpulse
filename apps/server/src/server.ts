import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  DISPLAY_HEIGHT,
  DISPLAY_PAGE_IDS,
  DISPLAY_WIDTH,
  type DisplayManifest,
  type DisplayPageId,
} from "../../../packages/contracts/src/display.js";
import type { RenderedPageSet } from "./renderer.js";

export interface ServerOptions {
  displayToken?: string;
  refreshAfterSeconds?: number;
}

export type PageSetSource = RenderedPageSet | (() => RenderedPageSet);

export function createInkPulseServer(
  pageSetSource: PageSetSource,
  options: ServerOptions = {},
) {
  const refreshAfterSeconds = options.refreshAfterSeconds ?? 300;

  return createServer((request, response) => {
    const pageSet =
      typeof pageSetSource === "function" ? pageSetSource() : pageSetSource;
    routeRequest(request, response, pageSet, {
      ...options,
      refreshAfterSeconds,
    });
  });
}

function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pageSet: RenderedPageSet,
  options: Required<Pick<ServerOptions, "refreshAfterSeconds">> & ServerOptions,
): void {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      pages: pageSet.pages.size,
      generatedAt: pageSet.generatedAt,
    });
    return;
  }

  if (url.pathname.startsWith("/api/v1/display/") && !isAuthorized(request, options.displayToken)) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="inkpulse-display"');
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/display/manifest") {
    response.setHeader("Cache-Control", "private, no-cache");
    sendJson(response, 200, buildManifest(pageSet, options.refreshAfterSeconds));
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

function buildManifest(
  pageSet: RenderedPageSet,
  refreshAfterSeconds: number,
): DisplayManifest {
  return {
    schemaVersion: 1,
    generatedAt: pageSet.generatedAt,
    refreshAfterSeconds,
    defaultPage: "overview",
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
