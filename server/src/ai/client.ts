import { GoogleGenAI } from "@google/genai";
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

function createGeminiClient(apiKey: string, model: string): AiClient {
  const ai = new GoogleGenAI({ apiKey });

  return {
    async completeJson({ system, prompt, schema }) {
      const interaction = await ai.interactions.create(
        {
          model,
          input: prompt,
          system_instruction: system,
          response_format: { type: "text", mime_type: "application/json", schema: z.toJSONSchema(schema) },
          store: false,
        },
        { timeout: TIMEOUT_MS },
      );
      // The schema shapes the model's output, but its values are still untrusted.
      return schema.parse(JSON.parse(interaction.output_text ?? ""));
    },
  };
}

function createGroqClient(apiKey: string, model: string): AiClient {
  return {
    async completeJson({ system, prompt, schema }) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          model,
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
      return schema.parse(JSON.parse(body.choices?.[0]?.message?.content ?? ""));
    },
  };
}

const PROVIDERS: Record<string, { create: (apiKey: string, model: string) => AiClient; defaultModel: string }> = {
  gemini: { create: createGeminiClient, defaultModel: "gemini-3.5-flash-lite" },
  groq: { create: createGroqClient, defaultModel: "openai/gpt-oss-20b" },
};

export function createAiClientFor(model?: string): AiClient {
  const provider = PROVIDERS[config.aiProvider];
  if (!provider) throw new Error(`Unsupported AI_PROVIDER: ${config.aiProvider}`);
  return provider.create(config.aiApiKey, model || provider.defaultModel);
}

// Returns null when no key is set. Leash enforces policy the same way without AI.
export function createAiClient(): AiClient | null {
  return config.aiApiKey ? createAiClientFor(config.aiModel) : null;
}
