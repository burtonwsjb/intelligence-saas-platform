import { describe, expect, it } from "vitest";
import { MissingRedisUrlError } from "@isp/queue";
import { startWorker } from "./worker.js";

describe("startWorker", () => {
  it("fails clearly when Redis is not configured", () => {
    expect(() => startWorker({ env: { NODE_ENV: "test" } })).toThrow(MissingRedisUrlError);
  });
});
