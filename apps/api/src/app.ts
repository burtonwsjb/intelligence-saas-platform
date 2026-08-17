import { Hono } from "hono";
import { healthOk } from "@isp/contracts";
import { isNonEmptyString } from "@isp/shared";

export const app = new Hono();

app.get("/health", (c) => {
  const body = healthOk();
  if (!isNonEmptyString(body.status)) {
    return c.json({ status: "error" }, 500);
  }
  return c.json(body);
});
