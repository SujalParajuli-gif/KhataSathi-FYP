import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5179", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  webServer: { command: "pnpm exec react-router dev --host 127.0.0.1 --port 5179", url: "http://127.0.0.1:5179", reuseExistingServer: false, timeout: 60000 },
});
