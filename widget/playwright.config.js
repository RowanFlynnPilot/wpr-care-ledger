// Smoke tests against the production build — exactly what Pages publishes.
// deploy.yml runs them after `npm run build` and before the upload, so a
// broken page never goes live. Locally: npm run build; npm test.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:4319/",
    // The embed test frames localhost from 127.0.0.1, which Chrome's
    // local-network-access check blocks; the real site (public to public)
    // never meets it.
    launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
  },
  webServer: {
    command: "npx vite preview --port 4319 --strictPort",
    url: "http://localhost:4319/",
    // Never reuse whatever already answers on the port: it may be another
    // project, and the suite would test the wrong site. --strictPort fails
    // loudly instead.
    reuseExistingServer: false,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
