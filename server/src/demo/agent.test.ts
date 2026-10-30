import { describe, expect, it } from "vitest";
import { createDemoRunner } from "./agent.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("demo runner", () => {
  it("runs one at a time and keeps the report", async () => {
    let finish = (_report: string) => {};
    const demo = createDemoRunner(() => new Promise<string>((resolve) => (finish = resolve)), () => {});

    expect(demo.start()).toBe(true);
    expect(demo.status().running).toBe(true);
    expect(demo.start()).toBe(false);

    finish("All paid.");
    await flush();
    expect(demo.status()).toMatchObject({ running: false, report: "All paid.", error: null });
    expect(demo.start()).toBe(true);
  });

  it("reports a friendly error and can run again", async () => {
    const demo = createDemoRunner(async () => {
      throw new Error("quota");
    }, () => {});
    demo.start();
    await flush();
    await flush();
    expect(demo.status().running).toBe(false);
    expect(demo.status().error).toContain("could not finish");
  });

  it("is unavailable without an AI key", () => {
    const demo = createDemoRunner(null, () => {});
    expect(demo.status().available).toBe(false);
    expect(demo.start()).toBe(false);
  });
});
