import { createHash } from "node:crypto";
import sharp from "sharp";
import { DISPLAY_HEIGHT, DISPLAY_PAGE_IDS, DISPLAY_WIDTH, type DisplayPageId } from "../../../packages/contracts/src/display.js";
import type { CodexUsageWindow } from "../../../packages/contracts/src/codex.js";
import type { DashboardData, StockQuote, CodexUsage } from "./data.js";

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
    // Preserve the wire ID and image URL for existing monitors and devices.
    { id: "codex", title: "AI usage", svg: renderAiUsage(data) },
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
  const stocks = data.stocks.slice(0, 5);
  const columnWidth = 744 / Math.max(1, stocks.length);
  const stockColumns = stocks.map((stock, index) => {
    const x = 28 + index * columnWidth;
    const center = x + columnWidth / 2;
    const formattedPrice = price(stock.price);
    const priceSize = Math.min(30, (columnWidth - 20) / (formattedPrice.length * 0.66));
    return `${text(center, 129, truncate(stock.symbol, 10), "overview-symbol", "middle")}
      <text x="${center}" y="168" text-anchor="middle" style="font-size:${priceSize}px;font-weight:700">${escapeXml(formattedPrice)}</text>
      ${text(center, 198, signed(stock.changePercent) + "%", "overview-symbol", "middle")}
      ${sparkline(stock, x + 18, 218, columnWidth - 36, 28)}
      ${index < stocks.length - 1 ? line(x + columnWidth, 112, x + columnWidth, 250, light) : ""}`;
  }).join("");
  const usage = providers(data).map(([name, report], index) => {
    const x = 28 + index * 392;
    const windows = ["primary", "secondary"].map((id, i) => {
      const window = report?.windows.find(w => w.id === id);
      const wx = x + i * 192;
      return `${text(wx, 348, i ? "WEEKLY" : "5-HOUR", "label")}
        ${text(wx, 382, window ? remaining(window) + "%" : "—", "overview-usage")}
        ${window ? capacityBar(wx, 394, 160, remaining(window)) : line(wx, 401, wx + 160, 401, light)}
        ${window?.resetsAt ? text(wx, 427, "Resets " + formatReset(window.resetsAt, data.timeZone), "meta") : ""}`;
    }).join("");
    return `${text(x, 318, name, "overview-symbol")}
      ${text(x + 352, 318, report?.windows.length ? usageStatus(report, data.generatedAt) : "No reading yet", "meta", "end")}${windows}`;
  }).join("");
  return documentSvg("At a glance", "overview", data,
    `${text(28, 96, data.stocks.length > 5 ? "WATCHLIST / FIRST 5" : "WATCHLIST", "label")}
     ${text(772, 96, "USD / DAY CHANGE", "label", "end")}
     ${stockColumns || text(28, 198, "No stock quotes yet", "body")}
     ${line(28, 268, 772, 268, ink)}
     ${text(28, 290, "AI CAPACITY / % LEFT", "label")}
     ${line(400, 305, 400, 428, light)}
     ${usage}`,
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

function providers(data: DashboardData): Array<[string, CodexUsage | undefined]> {
  return [["Codex", data.codex], ["Claude", data.claude]];
}

function usageStatus(usage: CodexUsage | undefined, now: string): string {
  if (!usage?.windows.length) return "Awaiting measurement";
  return (usage.collectorOnline ? "Updated " : "Stale / ") + ageLabel(usage.measuredAt, now);
}

function renderAiUsage(data: DashboardData): string {
  const panels = providers(data).map(([name, usage], index) => {
    const x = 28 + index * 392;
    const rows = (["primary", "secondary"] as const).map((id, row) => {
      const window = usage?.windows.find(w => w.id === id);
      const y = 154 + row * 133;
      return `${text(x, y, row ? "WEEKLY" : "5-HOUR", "label")}
        ${text(x + 352, y + 44, window ? remaining(window) + "%" : "—", "ai-number", "end")}
        ${text(x, y + 38, "LEFT", "label")}
        ${capacityBar(x, y + 60, 352, window ? remaining(window) : 0)}
        ${window?.resetsAt ? text(x, y + 96, "Resets " + formatReset(window.resetsAt, data.timeZone), "meta") : ""}
        ${window && remaining(window) <= 10 ? text(x + 352, y + 96, "LOW", "label", "end") : ""}`;
    }).join("");
    return `${text(x, 111, name, "title")}
      ${line(x, 124, x + 352, 124, light)}
      ${rows}
      ${text(x, 425, usageStatus(usage, data.generatedAt), "meta")}`;
  }).join("");
  return documentSvg("AI usage", "codex", data,
    `${panels}${line(400, 96, 400, 426, light)}`,
    "Capacity bars show remaining allowance");
}

function documentSvg(title: string, active: DisplayPageId, data: DashboardData, body: string, footer: string): string {
  const tabs = DISPLAY_PAGE_IDS.map((id, i) => {
    const x = 591 + i * 66;
    return `${id === active ? `<rect x="${x - 8}" y="448" width="60" height="23" fill="${ink}"/>` : ""}
      ${text(x + 22, 464, ["HOME", "STOCKS", "AI USAGE"][i]!, id === active ? "nav selected" : "nav", "middle")}`;
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
      .overview-symbol { font-size: 20px; font-weight: 700; }
      .overview-usage { font-size: 36px; font-weight: 700; letter-spacing: -1px; }
      .ai-number { font-size: 52px; font-weight: 700; letter-spacing: -2px; }
      .footer { font-size: 11px; fill: ${gray}; }
      .nav { font-size: 10px; font-weight: 700; }
      .selected { fill: #ffffff; }
    </style>
    ${text(28, 23, "INKPULSE", "brand")}
    ${text(28, 56, title, "title")}
    ${text(772, 25, formatTimestamp(data.generatedAt, data.timeZone), "label", "end")}
    ${text(772, 51, `${data.stockSource.provider === "mock" ? "SAMPLE DATA / " : "TIME / "}${formatTimeZone(data.generatedAt, data.timeZone)}`, "meta", "end")}
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
  const segments = width <= 120 ? 10 : 20;
  const gap = 4;
  const segment = (width - gap * (segments - 1)) / segments;
  const clamped = Math.max(0, Math.min(100, value));
  return Array.from({ length: segments }, (_, i) => {
    const fill = Math.max(0, Math.min(1, clamped / (100 / segments) - i));
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
function stockStatus(data: DashboardData): string {
  return `${truncate(data.stockSource.provider.toUpperCase(), 16)} / ${data.stockSource.stale ? "STALE" : "FETCHED"} ${formatTimestamp(data.stockSource.fetchedAt, data.timeZone)} ${formatTimeZone(data.stockSource.fetchedAt, data.timeZone)}`;
}
export function formatTimestamp(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(new Date(value)).replace(",", "").toUpperCase();
}
export function formatReset(value: string | null, timeZone: string): string {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(new Date(value));
}
function formatTimeZone(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(new Date(value));
  return (parts.find(part => part.type === "timeZoneName")?.value ?? "GMT").replace("GMT", "UTC");
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
