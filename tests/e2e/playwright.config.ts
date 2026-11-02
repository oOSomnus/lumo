import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  maxFailures: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  outputDir: "../../test-results",
  use: {
    headless: true,
    viewport: { width: 1440, height: 960 },
    screenshot: "only-on-failure",
    trace: "off",
  },
  projects: [{ name: "source" }, { name: "standalone" }],
});
