const baseUrl = parseBaseUrl(requiredEnvironmentVariable("INKPULSE_PUBLIC_BASE_URL"));
// GitHub masks the full secret URL only; also mask the bare hostname that DNS/TLS errors print.
if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${baseUrl.hostname}`);
const deviceToken = requiredEnvironmentVariable("INKPULSE_MONITOR_DEVICE_TOKEN");
const maximumAgeSeconds = parsePositiveInteger(
  process.env.INKPULSE_MONITOR_MAX_AGE_SECONDS ?? "900",
  "INKPULSE_MONITOR_MAX_AGE_SECONDS",
);
const expectedRefreshSeconds = parsePositiveInteger(
  process.env.INKPULSE_MONITOR_EXPECTED_REFRESH_SECONDS ?? "60",
  "INKPULSE_MONITOR_EXPECTED_REFRESH_SECONDS",
);
const expectedPageIds = ["overview", "stocks"];

const healthResponse = await request(new URL("/health", baseUrl));
assertStatus(healthResponse, 200, "health endpoint");
const health = await readJson(healthResponse, "health endpoint");
if (health?.status !== "ok" || health?.pages !== expectedPageIds.length) {
  throw new Error("Health endpoint returned an unexpected service state");
}

const unauthorizedResponse = await request(
  new URL("/api/v1/display/manifest", baseUrl),
);
assertStatus(unauthorizedResponse, 401, "unauthenticated manifest request");

const manifestResponse = await request(
  new URL("/api/v1/display/manifest", baseUrl),
  authorizationHeaders(),
);
assertStatus(manifestResponse, 200, "authenticated manifest request");
const manifest = await readJson(manifestResponse, "display manifest");
validateManifest(manifest);

for (const page of manifest.pages) {
  const pageUrl = new URL(page.imageUrl, baseUrl);
  if (pageUrl.origin !== baseUrl.origin) {
    throw new Error(`Page ${page.id} points outside the configured origin`);
  }

  const pageResponse = await request(pageUrl, authorizationHeaders());
  assertStatus(pageResponse, 200, `page ${page.id}`);
  if (pageResponse.headers.get("content-type") !== "image/png") {
    throw new Error(`Page ${page.id} did not return image/png`);
  }
  if (pageResponse.headers.get("etag") !== `"${page.version}"`) {
    throw new Error(`Page ${page.id} returned an unexpected ETag`);
  }

  const image = Buffer.from(await pageResponse.arrayBuffer());
  if (image.length === 0 || image.length > 256 * 1024 || !isPng(image)) {
    throw new Error(`Page ${page.id} returned an invalid PNG payload`);
  }
}

const firstPage = manifest.pages[0];
const revalidationResponse = await request(
  new URL(firstPage.imageUrl, baseUrl),
  {
    ...authorizationHeaders(),
    "If-None-Match": `"${firstPage.version}"`,
  },
);
assertStatus(revalidationResponse, 304, "page cache revalidation");

console.log(
  `InkPulse production is healthy: ${manifest.pages.length} pages, generated ${manifest.generatedAt}`,
);

function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Display manifest root is invalid");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("Display manifest schema version is unsupported");
  }
  if (value.refreshAfterSeconds !== expectedRefreshSeconds) {
    throw new Error(
      `Display refresh is ${value.refreshAfterSeconds}, expected ${expectedRefreshSeconds}`,
    );
  }

  const generatedAt = Date.parse(value.generatedAt);
  const ageMilliseconds = Date.now() - generatedAt;
  if (
    !Number.isFinite(generatedAt) ||
    ageMilliseconds < -5 * 60_000 ||
    ageMilliseconds > maximumAgeSeconds * 1_000
  ) {
    throw new Error("Display manifest is stale or has an invalid generatedAt value");
  }

  if (!Array.isArray(value.pages)) {
    throw new Error("Display manifest pages are missing");
  }
  const pageIds = value.pages.map((page) => page?.id);
  if (JSON.stringify(pageIds) !== JSON.stringify(expectedPageIds)) {
    throw new Error("Display manifest page order is invalid");
  }
  for (const page of value.pages) {
    if (
      page.width !== 800 ||
      page.height !== 480 ||
      page.format !== "png" ||
      typeof page.imageUrl !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(page.version)
    ) {
      throw new Error(`Display manifest page ${page.id} is invalid`);
    }
  }
}

async function request(url, headers = {}) {
  return await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
}

function authorizationHeaders() {
  return { Authorization: `Bearer ${deviceToken}` };
}

async function readJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label} returned HTTP ${response.status}, expected ${expected}`);
  }
}

function isPng(value) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((byte, index) => value[index] === byte);
}

function parseBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("INKPULSE_PUBLIC_BASE_URL must use HTTPS");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("INKPULSE_PUBLIC_BASE_URL must contain only an origin");
  }
  return url;
}

function requiredEnvironmentVariable(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePositiveInteger(value, name) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}
