import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AiClient } from "./client.js";

const schema = z.object({ reply: z.string() });
const request = { system: "system", prompt: "prompt", schema };

const reply = (content: string) => ({
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
  ok: true,
});

const limited = (message: string) => ({
  status: 429,
  json: async () => ({ error: { message } }),
  ok: false,
});

function stubFetch(responses: unknown[]) {
  const models: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    models.push(JSON.parse(init.body as string).model);
    return responses.shift();
  });
  return models;
}

describe("Groq client", () => {
  let createGroqClient: (apiKey: string, model: string, fallback: string | null) => AiClient;

  beforeAll(async () => {
    vi.stubEnv("PAYPAL_ENV", "sandbox");
    vi.stubEnv("PAYPAL_CLIENT_ID", "test");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "test");
    ({ createGroqClient } = await import("./client.js"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the main model when it can", async () => {
    const models = stubFetch([reply('{"reply":"ok"}')]);
    const result = await createGroqClient("key", "main", "backup").completeJson(request);
    expect(result).toEqual({ reply: "ok" });
    expect(models).toEqual(["main"]);
  });

  it("switches to the backup model when the daily limit is reached", async () => {
    const models = stubFetch([limited("Rate limit reached on tokens per day (TPD)"), reply('{"reply":"ok"}')]);
    const result = await createGroqClient("key", "main", "backup").completeJson(request);
    expect(result).toEqual({ reply: "ok" });
    expect(models).toEqual(["main", "backup"]);
  });

  it("stays on the backup model afterwards", async () => {
    const models = stubFetch([limited("tokens per day (TPD)"), reply('{"reply":"a"}'), reply('{"reply":"b"}')]);
    const ai = createGroqClient("key", "main", "backup");
    await ai.completeJson(request);
    await ai.completeJson(request);
    expect(models).toEqual(["main", "backup", "backup"]);
  });

  it("goes back to the main model after an hour", async () => {
    const models = stubFetch([limited("tokens per day (TPD)"), reply('{"reply":"a"}'), reply('{"reply":"b"}')]);
    const ai = createGroqClient("key", "main", "backup");
    await ai.completeJson(request);
    const later = Date.now() + 61 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await ai.completeJson(request);
    vi.restoreAllMocks();
    expect(models).toEqual(["main", "backup", "main"]);
  });

  it("does not switch for a per-minute limit, which clears by itself", async () => {
    const models = stubFetch([limited("Rate limit reached on tokens per minute (TPM)")]);
    await expect(createGroqClient("key", "main", "backup").completeJson(request)).rejects.toThrow("429");
    expect(models).toEqual(["main"]);
  });

  it("reports the limit when there is no backup", async () => {
    stubFetch([limited("tokens per day (TPD)")]);
    await expect(createGroqClient("key", "main", null).completeJson(request)).rejects.toThrow("429");
  });

  it("rejects output that doesn't match the schema", async () => {
    stubFetch([reply('{"wrong":"shape"}')]);
    await expect(createGroqClient("key", "main", null).completeJson(request)).rejects.toThrow();
  });
});
