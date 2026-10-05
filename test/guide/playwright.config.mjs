// Regenerates the screenshots in public/guide/ that start.html uses:
//   npx playwright test -c test/guide
// Real app pages, served by the real worker, with Neon faked. Not part of CI.
import { defineConfig, devices } from "@playwright/test";
import base from "../smoke/playwright.config.mjs";

export default defineConfig({
  ...base,
  testDir: ".",
  reporter: "list",
  use: { ...base.use, ...devices["Pixel 7"], deviceScaleFactor: 2,
         geolocation: base.use.geolocation, permissions: ["geolocation"] },
});
