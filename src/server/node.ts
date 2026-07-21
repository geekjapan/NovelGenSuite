import { serve } from "@hono/node-server";

import { projectsRoot } from "../core/store/state-json.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: createApp({ projectsRoot: projectsRoot() }).fetch, port }, (info) => {
  console.log(`NovelGenSuite listening on http://127.0.0.1:${info.port}`);
});
