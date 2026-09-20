import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  DISPLAY_HEIGHT,
  DISPLAY_PAGE_IDS,
  DISPLAY_WIDTH,
  type DisplayPageId,
} from "../../../packages/contracts/src/display.js";
import type { DashboardData, UsageWindow } from "./data.js";

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

const palette = {
  black: "#000000",
  dark: "#555555",
  light: "#aaaaaa",
  white: "#ffffff",
} as const;

export async function renderPageSet(data: DashboardData): Promise<RenderedPageSet> {
  const definitions: Array<{
    id: DisplayPageId;
    title: string;
    svg: string;
  }> = [
    { id: "overview", title: "Overview", svg: renderOverview(data) },
    { id: "stocks", title: "Stocks", svg: renderStocks(data) },
    { id: "codex", title: "Codex", svg: renderCodex(data) },
  ];

  const rendered = await Promise.all(
    definitions.map(async ({ id, title, svg }) => {
      const png = await sharp(Buffer.from(svg))
        .png({ palette: true, colours: 4, dither: 0 })
        .toBuffer();
      const digest = createHash("sha256").update(png).digest("hex");

      return {
        id,
        title,
        png,
        version: `sha256:${digest}` as const,
        updatedAt: data.generatedAt,
      };
    }),
  );

  const pages = new Map(rendered.map((page) => [page.id, page]));
  for (const id of DISPLAY_PAGE_IDS) {
    if (!pages.has(id)) {
      throw new Error(`Renderer did not produce required page: ${id}`);
    }
  }

  return { generatedAt: data.generatedAt, pages };
}

function renderOverview(data: DashboardData): string {
  const featured = data.stocks.slice(0, 4);
  const stockCards = featured
    .map((stock, index) => {
      const x = 24 + (index % 2) * 238;
      const y = 82 + Math.floor(index / 2) * 154;
      const direction = stock.change >= 0 ? "+" : "";

      return `
        <rect x="${x}" y="${y}" width="222" height="136" rx="10"
          fill="${palette.white}" stroke="${palette.black}" stroke-width="2"/>
        <text x="${x + 14}" y="${y + 31}" class="symbol">${escapeXml(stock.symbol)}</text>
        <text x="${x + 208}" y="${y + 29}" text-anchor="end" class="small">${escapeXml(stock.name)}</text>
        <text x="${x + 14}" y="${y + 78}" class="price">${stock.price.toFixed(2)}</text>
        <rect x="${x + 14}" y="${y + 94}" width="194" height="28" rx="5"
          fill="${stock.change >= 0 ? palette.light : palette.dark}"/>
        <text x="${x + 111}" y="${y + 114}" text-anchor="middle"
          class="change ${stock.change < 0 ? "inverse" : ""}">${direction}${stock.change.toFixed(2)}  ${direction}${stock.changePercent.toFixed(2)}%</text>`;
    })
    .join("");

  const usage = data.codex.windows
    .map((window, index) => usageSummary(window, 510, 112 + index * 126))
    .join("");

  return documentSvg(
    "OVERVIEW",
    formatTimestamp(data.generatedAt),
    `${stockCards}
      <line x1="494" y1="82" x2="494" y2="374" stroke="${palette.black}" stroke-width="2"/>
      <text x="510" y="94" class="section">CODEX USAGE</text>
      ${usage}
      <rect x="510" y="365" width="266" height="34" rx="6" fill="${palette.light}"/>
      <text x="643" y="388" text-anchor="middle" class="status">COLLECTOR ${data.codex.collectorOnline ? "ONLINE" : "OFFLINE"}</text>`,
    "LEFT / RIGHT: PAGES    REFRESH: UPDATE",
  );
}

function renderStocks(data: DashboardData): string {
  const rows = data.stocks
    .map((stock, index) => {
      const y = 78 + index * 58;
      const direction = stock.change >= 0 ? "+" : "";
      const sparkline = sparklinePath(stock.points, 604, y + 9, 166, 34);

      return `
        <rect x="22" y="${y}" width="756" height="50" rx="7"
          fill="${index % 2 === 0 ? palette.white : palette.light}" stroke="${palette.dark}"/>
        <text x="36" y="${y + 31}" class="row-symbol">${escapeXml(stock.symbol)}</text>
        <text x="145" y="${y + 30}" class="row-name">${escapeXml(stock.name)}</text>
        <text x="402" y="${y + 31}" text-anchor="end" class="row-price">${stock.price.toFixed(2)}</text>
        <text x="572" y="${y + 31}" text-anchor="end" class="row-change">${direction}${stock.change.toFixed(2)}  ${direction}${stock.changePercent.toFixed(2)}%</text>
        <path d="${sparkline}" fill="none" stroke="${palette.black}" stroke-width="3"/>`;
    })
    .join("");

  return documentSvg(
    "US STOCKS",
    `${data.stockSource.provider.toUpperCase()} / ${data.stockSource.stale ? "STALE" : "LATEST"}  ${formatTimestamp(data.stockSource.fetchedAt)}`,
    `<text x="36" y="66" class="column">SYMBOL</text>
      <text x="145" y="66" class="column">NAME</text>
      <text x="402" y="66" text-anchor="end" class="column">PRICE</text>
      <text x="572" y="66" text-anchor="end" class="column">DAY</text>
      <text x="686" y="66" text-anchor="middle" class="column">TREND</text>
      ${rows}`,
    `${data.stocks.length} SYMBOLS    LAST SUCCESSFUL UPDATE ${formatTimestamp(data.stockSource.fetchedAt)}`,
  );
}

function renderCodex(data: DashboardData): string {
  const cards = data.codex.windows
    .map((window, index) => {
      const y = 92 + index * 146;
      const remaining = Math.max(0, 100 - window.usedPercent);

      return `
        <rect x="34" y="${y}" width="732" height="124" rx="12"
          fill="${palette.white}" stroke="${palette.black}" stroke-width="2"/>
        <text x="54" y="${y + 34}" class="usage-title">${escapeXml(window.label.toUpperCase())}</text>
        <text x="746" y="${y + 34}" text-anchor="end" class="remaining">${remaining}% REMAINING</text>
        ${progressBar(54, y + 52, 692, 28, window.usedPercent)}
        <text x="54" y="${y + 107}" class="usage-meta">USED ${window.usedPercent}%</text>
        <text x="746" y="${y + 107}" text-anchor="end" class="usage-meta">RESETS ${formatReset(window.resetsAt)}</text>`;
    })
    .join("");

  const age = ageLabel(data.codex.measuredAt, data.generatedAt);
  return documentSvg(
    "CODEX",
    "USAGE WINDOWS",
    `${cards}
      <rect x="34" y="394" width="732" height="34" rx="6" fill="${palette.light}"/>
      <text x="52" y="417" class="status">COLLECTOR ${data.codex.collectorOnline ? "ONLINE" : "OFFLINE"}</text>
      <text x="748" y="417" text-anchor="end" class="status">MEASURED ${age}</text>`,
    "WHEN THE PC IS OFF, THE LAST MEASUREMENT REMAINS VISIBLE",
  );
}

function documentSvg(
  title: string,
  subtitle: string,
  body: string,
  footer: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${DISPLAY_WIDTH}" height="${DISPLAY_HEIGHT}" viewBox="0 0 ${DISPLAY_WIDTH} ${DISPLAY_HEIGHT}">
  <rect width="800" height="480" fill="${palette.white}"/>
  <style>
    text { font-family: "DejaVu Sans", Arial, sans-serif; fill: ${palette.black}; }
    .title { font-size: 29px; font-weight: 800; letter-spacing: 2px; }
    .subtitle { font-size: 12px; font-weight: 600; letter-spacing: 1px; }
    .section { font-size: 16px; font-weight: 800; letter-spacing: 1px; }
    .symbol { font-size: 21px; font-weight: 800; }
    .small { font-size: 9px; fill: ${palette.dark}; }
    .price { font-size: 32px; font-weight: 700; }
    .change { font-size: 15px; font-weight: 800; }
    .inverse { fill: ${palette.white}; }
    .status { font-size: 13px; font-weight: 800; letter-spacing: .6px; }
    .column { font-size: 11px; font-weight: 800; letter-spacing: .8px; }
    .row-symbol { font-size: 18px; font-weight: 800; }
    .row-name { font-size: 13px; font-weight: 600; }
    .row-price { font-size: 19px; font-weight: 700; }
    .row-change { font-size: 15px; font-weight: 700; }
    .usage-title { font-size: 19px; font-weight: 800; letter-spacing: 1px; }
    .remaining { font-size: 18px; font-weight: 800; }
    .usage-meta { font-size: 12px; font-weight: 700; }
    .footer { font-size: 10px; font-weight: 700; letter-spacing: .6px; }
  </style>
  <rect x="0" y="0" width="800" height="52" fill="${palette.black}"/>
  <text x="22" y="35" class="title" fill="${palette.white}" style="fill:${palette.white}">INKPULSE / ${escapeXml(title)}</text>
  <text x="778" y="33" text-anchor="end" class="subtitle" fill="${palette.white}" style="fill:${palette.white}">${escapeXml(subtitle)}</text>
  ${body}
  <line x1="0" y1="448" x2="800" y2="448" stroke="${palette.black}" stroke-width="2"/>
  <text x="400" y="469" text-anchor="middle" class="footer">${escapeXml(footer)}</text>
</svg>`;
}

function usageSummary(window: UsageWindow, x: number, y: number): string {
  const remaining = Math.max(0, 100 - window.usedPercent);
  return `<text x="${x}" y="${y + 20}" class="usage-title">${escapeXml(window.label.toUpperCase())}</text>
    <text x="${x + 266}" y="${y + 45}" text-anchor="end" class="remaining">${remaining}% LEFT</text>
    ${progressBar(x, y + 55, 266, 22, window.usedPercent)}
    <text x="${x}" y="${y + 100}" class="usage-meta">RESET ${formatReset(window.resetsAt)}</text>`;
}

function progressBar(
  x: number,
  y: number,
  width: number,
  height: number,
  percent: number,
): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const usedWidth = Math.round((width * clamped) / 100);
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="4" fill="${palette.light}"/>
    <rect x="${x}" y="${y}" width="${usedWidth}" height="${height}" rx="4" fill="${palette.dark}"/>
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="4" fill="none" stroke="${palette.black}" stroke-width="2"/>`;
}

function sparklinePath(
  points: number[],
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  if (points.length < 2) return "";
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;

  return points
    .map((point, index) => {
      const px = x + (index / (points.length - 1)) * width;
      const py = y + height - ((point - min) / range) * height;
      return `${index === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  })
    .format(new Date(value))
    .toUpperCase()
    .replace(",", "");
}

function formatReset(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  })
    .format(new Date(value))
    .toUpperCase();
}

function ageLabel(measuredAt: string, generatedAt: string): string {
  const ageMinutes = Math.max(
    0,
    Math.round(
      (new Date(generatedAt).getTime() - new Date(measuredAt).getTime()) / 60_000,
    ),
  );
  if (ageMinutes < 1) return "JUST NOW";
  if (ageMinutes === 1) return "1 MIN AGO";
  return `${ageMinutes} MINS AGO`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character] ?? character;
  });
}
