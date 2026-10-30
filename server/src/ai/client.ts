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

function createGroqClient(apiKey: string, model: string): AiClient {
  return {
    async completeJson({ system, prompt, schema }) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          model,
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
      if (!res.ok) throw new Error(`Groq returned ${res.status}: ${body.error?.message ?? "unknown error"}`);
      // The schema shapes the model's output, but its values are still untrusted.
      return schema.parse(JSON.parse(body.choices?.[0]?.message?.content ?? ""));
    },
  };
}

// Adding a provider means adding one entry here.
const PROVIDERS: Record<string, { create: (apiKey: string, model: string) => AiClient; defaultModel: string }> = {
  groq: { create: createGroqClient, defaultModel: "openai/gpt-oss-120b" },
};

// Returns null when no key is set. Leash enforces policy the same way without AI.
export function createAiClient(): AiClient | null {
  if (!config.aiApiKey) return null;
  const provider = PROVIDERS[config.aiProvider];
  if (!provider) throw new Error(`Unsupported AI_PROVIDER: ${config.aiProvider}`);
  return provider.create(config.aiApiKey, config.aiModel || provider.defaultModel);
}
