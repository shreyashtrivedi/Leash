import { z } from "zod";
import { config } from "../config.js";

export interface JsonRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}

export interface AiClient {
  completeJson<T>(request: JsonRequest<T>): Promise<T>;
}

const TIMEOUT_MS = 20_000;
const BACKUP_PERIOD_MS = 60 * 60_000;

// Free daily limits are per model, so a smaller backup keeps the AI working when the main one runs out.
export function createGroqClient(apiKey: string, model: string, backupModel: string | null): AiClient {
  let backupUntil = 0;

  const send = async <T>({ system, prompt, schema }: JsonRequest<T>) => {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: Date.now() < backupUntil && backupModel ? backupModel : model,
        temperature: 0.1,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "leash_response", strict: true, schema: z.toJSONSchema(schema) },
        },
      }),
    });
    const body: any = await res.json();
    return { status: res.status, ok: res.ok, body };
  };

  return {
    async completeJson(request) {
      let { status, ok, body } = await send(request);

      if (status === 429 && backupModel && Date.now() >= backupUntil && body.error?.message?.includes("per day")) {
        backupUntil = Date.now() + BACKUP_PERIOD_MS;
        ({ status, ok, body } = await send(request));
      }

      if (!ok) throw new Error(`Groq returned ${status}: ${body.error?.message ?? "unknown error"}`);
      // The schema shapes the model's output, but its values are still untrusted.
      return request.schema.parse(JSON.parse(body.choices?.[0]?.message?.content ?? ""));
    },
  };
}

// Adding a provider means adding one entry here.
const PROVIDERS: Record<
  string,
  { create: (apiKey: string, model: string, backupModel: string | null) => AiClient; defaultModel: string; backupModel: string }
> = {
  groq: { create: createGroqClient, defaultModel: "openai/gpt-oss-120b", backupModel: "openai/gpt-oss-20b" },
};

// Returns null when no key is set. Leash enforces policy the same way without AI.
export function createAiClient(): AiClient | null {
  if (!config.aiApiKey) return null;
  const provider = PROVIDERS[config.aiProvider];
  if (!provider) throw new Error(`Unsupported AI_PROVIDER: ${config.aiProvider}`);
  // A model chosen on purpose is respected, so it gets no automatic backup.
  return provider.create(config.aiApiKey, config.aiModel || provider.defaultModel, config.aiModel ? null : provider.backupModel);
}
