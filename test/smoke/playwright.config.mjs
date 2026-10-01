import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 20000,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:8788",
    ...devices["Pixel 7"],
    geolocation: { latitude: 3.139, longitude: 101.6869 }, // Kuala Lumpur
    permissions: ["geolocation"],
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node serve.mjs",
    cwd: new URL(".", import.meta.url).pathname,
    url: "http://localhost:8788/config.js",
    reuseExistingServer: !process.env.CI,
  },
});
