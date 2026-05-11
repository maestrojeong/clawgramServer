// Stealth init script — injected before any page script loads.
// Hides Playwright/automation signals from bot detection.

// 1. navigator.webdriver — the most common detection signal
Object.defineProperty(navigator, "webdriver", { get: () => undefined });

// 2. Ensure window.chrome exists (Chromium doesn't always have it)
if (!window.chrome) {
  window.chrome = { runtime: {} };
}

// 3. Hide automation-related properties
delete navigator.__proto__.webdriver;
