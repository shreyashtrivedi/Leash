import { describe, expect, it } from "vitest";
import type { AiClient } from "../ai/client.js";
import { createDemoRunner, runAgentLoop } from "./agent.js";
import type { Tools } from "./agent.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function scriptedAi(steps: unknown[]) {
  const prompts: string[] = [];
  const ai: AiClient = {
    async completeJson(request) {
      prompts.push(request.prompt);
      const step = steps.shift();
      if (step instanceof Error) throw step;
      return request.schema.parse(step);
    },
  };
  return { ai, prompts };
}

function fakeTools(results: Record<string, unknown>[]) {
  const calls: [string, Record<string, unknown>][] = [];
  const tools: Tools = {
    names: ["pay", "check_approval"],
    describe: "pay: send money",
    async call(name, args) {
      calls.push([name, args]);
      return results.shift() ?? { status: "executed" };
    },
    close: async () => {},
  };
  return { tools, calls };
}

const pay = { thought: "Paying.", action: "pay", arguments_json: '{"amount":"12.00"}' };
const finish = { thought: "Done.", action: "finish", arguments_json: '{"report":"All done."}' };
const options = { vendors: ["vendor@example.com"], onThought: () => {}, pollMs: 1, retryMs: 1 };

describe("agent loop", () => {
  it("runs actions in order and returns the report", async () => {
    const { ai } = scriptedAi([pay, finish, finish]);
    const { tools, calls } = fakeTools([{ status: "executed" }]);
    expect(await runAgentLoop({ ...options, ai, tools })).toBe("All done.");
    expect(calls).toEqual([["pay", { amount: "12.00" }]]);
  });

  it("does not accept a report before any action has happened", async () => {
    const { ai, prompts } = scriptedAi([finish, pay, finish, finish]);
    const { tools, calls } = fakeTools([{ status: "executed" }]);
    const thoughts: string[] = [];
    const report = await runAgentLoop({ ...options, ai, tools, onThought: (thought) => thoughts.push(thought) });
    expect(report).toBe("All done.");
    expect(calls).toHaveLength(1);
    expect(prompts[1]).toContain("you have not taken any action yet");
    expect(thoughts).toEqual(["Paying.", "Done."]);
  });

  it("gives up instead of reporting success if the model never acts", async () => {
    const { ai } = scriptedAi(Array.from({ length: 20 }, () => finish));
    const { tools, calls } = fakeTools([]);
    expect(await runAgentLoop({ ...options, ai, tools })).toContain("stopped before finishing");
    expect(calls).toHaveLength(0);
  });

  it("makes the model review the task once before finishing", async () => {
    const { ai, prompts } = scriptedAi([pay, finish, pay, finish]);
    const { tools, calls } = fakeTools([{ status: "executed" }, { status: "executed" }]);
    await runAgentLoop({ ...options, ai, tools });
    expect(prompts[2]).toContain("compare each numbered purchase");
    expect(calls).toHaveLength(2);
  });

  it("waits for a held payment without spending AI calls", async () => {
    const { ai, prompts } = scriptedAi([pay, finish, finish]);
    const { tools, calls } = fakeTools([
      { status: "pending_approval", approval_id: "A1" },
      { status: "pending_approval", approval_id: "A1" },
      { status: "executed" },
    ]);
    await runAgentLoop({ ...options, ai, tools });
    expect(calls.map(([name]) => name)).toEqual(["pay", "check_approval", "check_approval"]);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('"status":"executed"');
  });

  it("feeds a refusal back so the model can adapt", async () => {
    const { ai, prompts } = scriptedAi([pay, finish, finish]);
    const { tools } = fakeTools([{ status: "blocked", reason: "blocked: over cap" }]);
    await runAgentLoop({ ...options, ai, tools });
    expect(prompts[1]).toContain("blocked: over cap");
  });

  it("retries a failed AI call", async () => {
    const { ai } = scriptedAi([new Error("Groq returned 400"), pay, finish, finish]);
    const { tools, calls } = fakeTools([{ status: "executed" }]);
    await runAgentLoop({ ...options, ai, tools });
    expect(calls).toHaveLength(1);
  });

  it("survives invalid arguments", async () => {
    const { ai, prompts } = scriptedAi([{ ...pay, arguments_json: "not json" }, pay, finish, finish]);
    const { tools, calls } = fakeTools([{ status: "executed" }]);
    await runAgentLoop({ ...options, ai, tools });
    expect(calls).toHaveLength(1);
    expect(prompts[1]).toContain("not valid JSON");
  });
});

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
