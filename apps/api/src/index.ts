import { serve } from "@hono/node-server";
import { app } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);

serve({ fetch: app.fetch, port }, () => {
  console.log(`api: listening on http://127.0.0.1:${port}`);
});
