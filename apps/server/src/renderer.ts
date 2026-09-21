import { createHash } from "node:crypto";
import sharp from "sharp";
import { DISPLAY_HEIGHT, DISPLAY_PAGE_IDS, DISPLAY_WIDTH, type DisplayPageId } from "../../../packages/contracts/src/display.js";
import type { CodexUsageWindow } from "../../../packages/contracts/src/codex.js";
import type { DashboardData, StockQuote } from "./data.js";

export interface RenderedPage {
  id: DisplayPageId;
  title: string;
  png: Buffer;
  version: `sha256:${string}`;
  updatedAt: string;
}

export interface RenderedPageSet {
  generatedAt: string;
  pages: Map<DisplayPageId, RenderedPage>;
}

// A shared editorial grid: 28px margins, 72px header, 40px footer.
// Reserve solid black for readings and remaining capacity; gray is secondary.
const ink = "#000000";
const gray = "#555555";
const light = "#aaaaaa";

export async function renderPageSet(data: DashboardData): Promise<RenderedPageSet> {
  const definitions: Array<{ id: DisplayPageId; title: string; svg: string }> = [
    { id: "overview", title: "Overview", svg: renderOverview(data) },
    { id: "stocks", title: "Stocks", svg: renderStocks(data) },
    { id: "codex", title: "Codex", svg: renderCodex(data) },
  ];
  const rendered = await Promise.all(definitions.map(async ({ id, title, svg }) => {
    const png = await sharp(Buffer.from(svg)).png({ palette: true, colours: 4, dither: 0 }).toBuffer();
    return { id, title, png, version: `sha256:${createHash("sha256").update(png).digest("hex")}` as const, updatedAt: data.generatedAt };
  }));
  const pages = new Map(rendered.map(page => [page.id, page]));
  for (const id of DISPLAY_PAGE_IDS) {
    if (!pages.has(id)) throw new Error(`Renderer did not produce required page: ${id}`);
  }
  return { generatedAt: data.generatedAt, pages };
}

function renderOverview(data: DashboardData): string {
  const stocks = data.stocks.slice(0, 6);
  // Align the final divider with the adjacent column's bottom edge.
  const rowHeight = (422 - 130 - 19) / Math.max(1, stocks.length - 1);
  const rows = stocks.map((stock, index) => {
    const y = 130 + index * rowHeight;
    return `${text(28, y, stock.symbol, "symbol")}
      ${text(290, y, price(stock.price), "price", "end")}
      ${text(456, y, signed(stock.changePercent) + "%", "change", "end")}
      ${line(28, y + 19, 456, y + 19, light)}`;
  }).join("");
  const usage = data.codex.windows.slice(0, 2).map((window, index) => {
    const y = 128 + index * 144;
    return `${text(512, y, windowLabel(window), "label")}
      ${text(512, y + 59, remaining(window) + "%", "summary-number")}
      ${text(772, y + 57, "LEFT", "label", "end")}
      ${capacityBar(512, y + 76, 260, remaining(window))}
      ${text(512, y + 112, "Resets " + formatReset(window.resetsAt), "meta")}`;
  }).join("");
  return documentSvg("At a glance", "overview", data,
    `${text(28, 96, data.stocks.length > 6 ? "WATCHLIST / FIRST 6" : "WATCHLIST", "label")}
     ${text(456, 96, "DAY %", "label", "end")}
     ${text(512, 96, "CODEX / REMAINING", "label")}
     ${line(484, 88, 484, 422, light)}
     ${rows || text(28, 200, "No stock quotes yet", "body")}
     ${usage || text(512, 206, "Awaiting usage", "body")}
     ${text(512, 422, data.codex.collectorOnline ? "PC connected" : data.codex.windows.length ? "PC offline / last reading" : "PC offline", "meta")}`,
    stockStatus(data));
}

function renderStocks(data: DashboardData): string {
  const stocks = data.stocks;
  const compact = stocks.length > 6;
  const rowHeight = Math.min(64, 324 / Math.max(1, stocks.length));
  const rows = stocks.map((stock, index) => {
    const y = (compact ? 124 : 130) + index * rowHeight;
    return `${text(28, y, stock.symbol, compact ? "compact" : "symbol")}
      ${compact ? "" : text(28, y + 19, truncate(stock.name, 25), "meta")}
      ${text(372, y + 1, price(stock.price), compact ? "compact" : "price", "end")}
      ${text(520, y, signed(stock.changePercent) + "%", compact ? "compact" : "change", "end")}
      ${compact ? "" : text(520, y + 19, signed(stock.change) + " USD", "meta", "end")}
      ${sparkline(stock, 570, y - (compact ? 14 : 17), 198, compact ? 16 : 33)}
      ${line(28, y + (compact ? 9 : 31), 772, y + (compact ? 9 : 31), light)}`;
  }).join("");
  return documentSvg("Watchlist", "stocks", data,
    `${text(28, 96, "US EQUITIES", "label")}
     ${text(372, 96, "PRICE / USD", "label", "end")}
     ${text(520, 96, "DAY CHANGE", "label", "end")}
     ${text(570, 96, "PRICE TREND", "label")}
     ${rows || text(28, 210, "Waiting for stock quotes", "body")}`,
    stockStatus(data));
}

function renderCodex(data: DashboardData): string {
  const windows = data.codex.windows.slice(0, 2);
  const panels = windows.map((window, index) => {
    const x = 28 + index * 392;
    const left = remaining(window);
    return `${text(x, 110, windowLabel(window), "label")}
      ${left <= 10 ? text(x + 352, 110, "LOW", "label", "end") : ""}
      ${text(x, 228, String(left), "hero")}
      ${text(x + 352, 226, "%", "percent", "end")}
      ${text(x, 265, "REMAINING", "label")}
      ${capacityBar(x, 288, 352, left)}
      ${text(x, 345, percent(window.usedPercent) + "% used", "body")}
      ${text(x, 374, "Resets " + formatReset(window.resetsAt), "meta")}`;
  }).join("");
  return documentSvg("Codex capacity", "codex", data,
    `${panels || `${text(28, 194, "Awaiting your first reading", "empty-title")}
      ${text(28, 230, "Usage appears when the PC collector connects.", "body")}`}
     ${windows.length > 1 ? line(400, 96, 400, 384, light) : ""}
     ${line(28, 398, 772, 398, light)}
     <circle cx="33" cy="420" r="4" fill="${data.codex.collectorOnline ? ink : "#ffffff"}" stroke="${ink}" stroke-width="2"/>
     ${text(46, 425, data.codex.collectorOnline ? "PC connected" : windows.length ? "PC offline / showing last reading" : "PC offline", "meta")}
     ${text(772, 425, windows.length ? "Measured " + ageLabel(data.codex.measuredAt, data.generatedAt) : "No measurement", "meta", "end")}`,
    "Capacity bars show remaining allowance");
}

function documentSvg(title: string, active: DisplayPageId, data: DashboardData, body: string, footer: string): string {
  const tabs = DISPLAY_PAGE_IDS.map((id, i) => {
    const x = 591 + i * 66;
    return `${id === active ? `<rect x="${x - 8}" y="448" width="60" height="23" fill="${ink}"/>` : ""}
      ${text(x + 22, 464, ["HOME", "STOCKS", "CODEX"][i]!, id === active ? "nav selected" : "nav", "middle")}`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="${DISPLAY_WIDTH}" height="${DISPLAY_HEIGHT}" viewBox="0 0 800 480">
    <rect width="800" height="480" fill="#ffffff"/>
    <style>
      text { font-family: "DejaVu Sans", Arial, sans-serif; fill: ${ink}; }
      .brand { font-size: 12px; font-weight: 700; letter-spacing: 2px; }
      .title { font-size: 28px; font-weight: 700; }
      .label { font-size: 12px; font-weight: 700; letter-spacing: 1px; }
      .symbol { font-size: 23px; font-weight: 700; }
      .price { font-size: 27px; font-weight: 700; }
      .change { font-size: 22px; font-weight: 700; }
      .compact { font-size: 18px; font-weight: 700; }
      .meta { font-size: 13px; fill: ${gray}; }
      .body { font-size: 18px; }
      .summary-number { font-size: 49px; font-weight: 700; letter-spacing: -2px; }
      .hero { font-size: 112px; font-weight: 700; letter-spacing: -5px; }
      .percent { font-size: 46px; }
      .empty-title { font-size: 30px; font-weight: 700; }
      .footer { font-size: 11px; fill: ${gray}; }
      .nav { font-size: 10px; font-weight: 700; }
      .selected { fill: #ffffff; }
    </style>
    ${text(28, 23, "INKPULSE", "brand")}
    ${text(28, 56, title, "title")}
    ${text(772, 25, formatTimestamp(data.generatedAt), "label", "end")}
    ${text(772, 51, data.stockSource.provider === "mock" ? "SAMPLE DATA / UTC" : "ALL TIMES UTC", "meta", "end")}
    ${line(28, 71, 772, 71, ink, 2)}
    ${body}
    ${line(28, 440, 772, 440, ink)}
    ${text(28, 464, footer, "footer")}
    ${tabs}
  </svg>`;
}

function text(x: number, y: number, value: string, style: string, anchor = "start"): string {
  return `<text x="${x}" y="${y}" class="${style}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

function line(x1: number, y1: number, x2: number, y2: number, color: string, width = 1): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}"/>`;
}

function capacityBar(x: number, y: number, width: number, value: number): string {
  const gap = 4;
  const segment = (width - gap * 19) / 20;
  const clamped = Math.max(0, Math.min(100, value));
  return Array.from({ length: 20 }, (_, i) => {
    const fill = Math.max(0, Math.min(1, clamped / 5 - i));
    const sx = x + i * (segment + gap);
    return `<rect x="${sx}" y="${y}" width="${segment}" height="14" fill="#ffffff" stroke="${light}"/>
      ${fill > 0 ? `<rect x="${sx}" y="${y}" width="${segment * fill}" height="14" fill="${ink}"/>` : ""}`;
  }).join("");
}

function sparkline(stock: StockQuote, x: number, y: number, width: number, height: number): string {
  const points = stock.points.filter(Number.isFinite);
  if (points.length < 2) return text(x + width / 2, y + 23, "No trend", "meta", "middle");
  const min = Math.min(...points);
  const max = Math.max(...points);
  const py = (value: number) => max === min ? y + height / 2 : y + height - (value - min) / (max - min) * height;
  const path = points.map((p, i) => `${i ? "L" : "M"}${(x + i / (points.length - 1) * width).toFixed(1)},${py(p).toFixed(1)}`).join(" ");
  return `<path d="${path}" fill="none" stroke="${ink}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x + width}" cy="${py(points[points.length - 1]!)}" r="3" fill="${ink}"/>`;
}

function percent(value: number): number { return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10; }
function remaining(window: CodexUsageWindow): number { return percent(100 - window.usedPercent); }
function signed(value: number): string { return (value > 0 ? "+" : value < 0 ? "−" : "") + Math.abs(value).toFixed(2); }
function price(value: number): string { return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function truncate(value: string, max: number): string { return value.length > max ? value.slice(0, max - 1) + "…" : value; }
function windowLabel(window: CodexUsageWindow): string { return truncate(window.label.replace(/ window$/i, "").toUpperCase(), 24); }
function stockStatus(data: DashboardData): string {
  return `${truncate(data.stockSource.provider.toUpperCase(), 16)} / ${data.stockSource.stale ? "STALE" : "FETCHED"} ${formatTimestamp(data.stockSource.fetchedAt)} UTC`;
}
function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(value)).replace(",", "").toUpperCase();
}
function formatReset(value: string | null): string {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(value));
}
function ageLabel(measuredAt: string, generatedAt: string): string {
  const minutes = Math.max(0, Math.round((new Date(generatedAt).getTime() - new Date(measuredAt).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
function escapeXml(value: string): string {
  const entities: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" };
  return value.replace(/[<>&"']/g, character => entities[character] ?? character);
}
