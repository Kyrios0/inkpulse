#pragma once

#if __has_include("secrets.h")
#include "secrets.h"
#endif

// Empty fallbacks keep CI builds secret-free; such a device shows a configuration message instead.
#ifndef INKPULSE_WIFI_SSID
#define INKPULSE_WIFI_SSID ""
#endif

#ifndef INKPULSE_WIFI_PASSWORD
#define INKPULSE_WIFI_PASSWORD ""
#endif

#ifndef INKPULSE_BASE_URL
#define INKPULSE_BASE_URL ""
#endif

#ifndef INKPULSE_DEVICE_TOKEN
#define INKPULSE_DEVICE_TOKEN ""
#endif

#ifndef INKPULSE_FIRMWARE_VERSION
#define INKPULSE_FIRMWARE_VERSION "dev"
#endif

