import { createHash } from "node:crypto";
import sharp from "sharp";
import { DISPLAY_HEIGHT, DISPLAY_PAGE_IDS, DISPLAY_WIDTH, type DisplayPageId } from "../../../packages/contracts/src/display.js";
import type { CodexUsageWindow } from "../../../packages/contracts/src/codex.js";
import type { DashboardData, StockQuote, CodexUsage } from "./data.js";
import { BATTERY_DEVICE_IDS } from "../../../packages/contracts/src/battery.js";

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

export function renderOverview(data: DashboardData): string {
  const batteryColumns = BATTERY_DEVICE_IDS.map((id, index) => {
    const x = 28 + index * 248;
    const reading = data.battery?.devices.find(device => device.id === id);
    const raw = reading?.percent ?? null;
    const age = reading?.observedAt ? Date.parse(data.generatedAt) - Date.parse(reading.observedAt) : Infinity;
    const recent = age <= 180_000;
    const current = !!data.battery?.collectorOnline && !!reading?.connected && recent;
    const unavailable = raw === null || age >= 48 * 60 * 60_000;
    // Bucket only presentation; preserve the raw cache for threshold decisions.
    // Positive values below 10 must never look like an empty battery.
    const value = unavailable ? null : raw < 10 && raw > 0 ? 10 : Math.round(raw / 10) * 10;
    const low = !unavailable && current && raw <= 20;
    const stale = !unavailable && !current;
    const status = raw === null ? "No reading yet"
      : unavailable ? "Disconnected" : stale ? "Last reading " + formatTimestamp(reading!.observedAt!, data.timeZone) : low ? "LOW BATTERY" : "";
    const number = value === null ? "—" : raw! > 0 && raw! < 10 ? "<10%" : value + "%";
    const center = x + 124;
    const headingX = center - [88, 92, 144][index]! / 2;
    return `<g class="battery-tile${low ? " battery-low" : stale || unavailable ? " battery-muted" : ""}">
      ${low ? `<rect x="${x + 10}" y="106" width="228" height="151" rx="3" fill="${ink}"/>` : ""}
      ${deviceIcon(id, headingX, 115)}
      ${text(headingX + 34, 135, ["Phone", "Watch", "Headphones"][index]!, "device-label")}
      ${text(center, 196, number, "battery-number", "middle")}
      ${value === null ? "" : batteryAccent(x + 26, 218, value)}
      ${status ? text(center, 248, status, low ? "label" : "meta", "middle") : ""}
      </g>
      ${index < 2 ? line(x + 248, 112, x + 248, 253, light) : ""}`;
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
      ${text(x + 352, 318, report?.windows.length ? usageStatus(report, data.timeZone) : "No reading yet", "meta", "end")}${windows}`;
  }).join("");
  return documentSvg("At a glance", "overview", data,
    `${text(28, 96, "DEVICE BATTERIES", "label")}
     ${batteryColumns}
     ${line(28, 268, 772, 268, ink)}
     ${text(28, 290, "AI CAPACITY / % LEFT", "label")}
     ${line(400, 305, 400, 428, light)}
     ${usage}`,
    "Batteries & AI capacity");
}

function deviceIcon(id: typeof BATTERY_DEVICE_IDS[number], x: number, y: number): string {
  const shapes = id === "phone"
    ? '<rect x="5" y="0" width="15" height="24" rx="3"/><path d="M10 4h5M11 20h3"/>'
    : id === "watch"
      ? '<path d="M8 5V0h8v5M8 19v5h8v-5"/><circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/>'
      : '<path d="M3 16v-4a9 9 0 0 1 18 0v4"/><rect x="1" y="13" width="5" height="10" rx="2"/><rect x="18" y="13" width="5" height="10" rx="2"/>';
  return `<g class="device-icon" transform="translate(${x},${y})" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</g>`;
}

function batteryAccent(x: number, y: number, value: number): string {
  return Array.from({ length: 10 }, (_, i) =>
    `<rect class="battery-segment ${i < value / 10 ? "filled" : "empty"}" x="${x + i * 20}" y="${y}" width="16" height="4"/>`).join("");
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

// No relative ages ("5m ago") or refresh clocks: they change the pixels, and so
// the page version, on every render without any new information.
function usageStatus(usage: CodexUsage | undefined, timeZone: string): string {
  if (!usage?.windows.length) return "Awaiting measurement";
  return usage.collectorOnline ? "Live" : "Last reading " + formatTimestamp(usage.measuredAt, timeZone);
}

// The AI values exactly as the pages display them. It changes only when a
// rendered AI number, bar, or reset time changes.
export function aiUsageFingerprint(data: DashboardData): string {
  return JSON.stringify(providers(data).map(([name, usage]) => [name,
    (["primary", "secondary"] as const).map(id => {
      const window = usage?.windows.find(w => w.id === id);
      return window ? [remaining(window), window.resetsAt ? formatReset(window.resetsAt, data.timeZone) : null] : null;
    })]));
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
      ${text(x, 425, usageStatus(usage, data.timeZone), "meta")}`;
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
      .battery-number { font-size: 48px; font-weight: 700; letter-spacing: -2px; }
      .device-label { font-size: 18px; font-weight: 700; }
      .battery-segment.filled { fill: ${ink}; }
      .battery-segment.empty { fill: #dddddd; }
      .battery-muted .battery-number, .battery-muted .battery-segment.filled { fill: ${gray}; }
      .battery-muted .device-icon { stroke: ${gray}; }
      .battery-low text, .battery-low .battery-segment.filled { fill: #ffffff; }
      .battery-low .battery-segment.empty { fill: ${gray}; }
      .battery-low .device-icon { stroke: #ffffff; }
      .footer { font-size: 11px; fill: ${gray}; }
      .nav { font-size: 10px; font-weight: 700; }
      .selected { fill: #ffffff; }
    </style>
    ${text(28, 23, "INKPULSE", "brand")}
    ${text(28, 56, title, "title")}
    ${text(772, 25, formatDate(data.generatedAt, data.timeZone), "label", "end")}
    ${text(772, 51, `${data.stockSource.provider === "mock" ? "SAMPLE DATA / " : "TIMES IN "}${formatTimeZone(data.generatedAt, data.timeZone)}`, "meta", "end")}
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

function capacityBar(x: number, y: number, width: number, value: number, segments = width <= 120 ? 10 : 20): string {
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

// Whole percents: tenths add visible churn without adding useful information.
function percent(value: number): number { return Math.round(Math.max(0, Math.min(100, value))); }
function remaining(window: CodexUsageWindow): number { return percent(100 - window.usedPercent); }
function signed(value: number): string { return (value > 0 ? "+" : value < 0 ? "−" : "") + Math.abs(value).toFixed(2); }
function price(value: number): string { return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function truncate(value: string, max: number): string { return value.length > max ? value.slice(0, max - 1) + "…" : value; }
// Uses the newest market time rather than the fetch time, so a closed market
// renders identical pixels on every refresh.
function stockStatus(data: DashboardData): string {
  const provider = truncate(data.stockSource.provider.toUpperCase(), 16);
  const times = data.stocks.map(stock => Date.parse(stock.updatedAt)).filter(Number.isFinite);
  if (!times.length) return `${provider} / ${data.stockSource.stale ? "STALE" : "NO QUOTES"}`;
  const quotedAt = new Date(Math.max(...times)).toISOString();
  return `${provider} / ${data.stockSource.stale ? "STALE, " : ""}QUOTES AS OF ${formatTimestamp(quotedAt, data.timeZone)} ${formatTimeZone(quotedAt, data.timeZone)}`;
}
export function formatTimestamp(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(new Date(value)).replace(",", "").toUpperCase();
}
export function formatDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "2-digit", timeZone }).format(new Date(value)).replace(/,/g, "").toUpperCase();
}
export function formatReset(value: string | null, timeZone: string): string {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(new Date(value));
}
function formatTimeZone(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(new Date(value));
  return (parts.find(part => part.type === "timeZoneName")?.value ?? "GMT").replace("GMT", "UTC");
}
function escapeXml(value: string): string {
  const entities: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" };
  return value.replace(/[<>&"']/g, character => entities[character] ?? character);
}
