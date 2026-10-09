#pragma once

// Copy to secrets.h (ignored by Git). E1001 Wi-Fi is 2.4 GHz only.
#define INKPULSE_WIFI_SSID "your-2.4-ghz-wifi"
#define INKPULSE_WIFI_PASSWORD "your-wifi-password"

// HTTPS is required. A trailing slash is accepted.
#define INKPULSE_BASE_URL "https://ink.example.com"

// Use the server's read-only display token, never a collector ingest token.
#define INKPULSE_DEVICE_TOKEN "replace-with-display-token"
