import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const port = 4173;

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}` },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
  webServer: {
    command: "npm run build && npm start",
    env: {
      OPENAI_API_KEY: "",
      NOVELGEN_PROJECTS_ROOT: join(process.cwd(), "test-results", `projects-${process.pid}`),
      PORT: String(port),
    },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
