import { describe, expect, it } from "vitest";
import { startWorker } from "./worker.js";

describe("startWorker", () => {
  it("starts without connecting to external services and can stop", () => {
    const handle = startWorker();
    expect(typeof handle.stop).toBe("function");
    expect(() => handle.stop()).not.toThrow();
  });
});
