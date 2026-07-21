import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { projectsRoot } from "../core/store/state-json.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const api = createApp({ projectsRoot: projectsRoot() });
const web = new Hono();
web.use("/*", serveStatic({ root: "./dist/web" }));
web.get("*", serveStatic({ path: "./dist/web/index.html" }));

serve({
  fetch: (request) => {
    const path = new URL(request.url).pathname;
    return path === "/projects" || path.startsWith("/projects/")
      ? api.fetch(request)
      : web.fetch(request);
  },
  port,
}, (info) => {
  console.log(`NovelGenSuite listening on http://127.0.0.1:${info.port}`);
});
