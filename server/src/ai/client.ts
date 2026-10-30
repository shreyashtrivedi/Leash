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

// Returns null when no key is set. Leash enforces policy the same way without AI.
export function createAiClient(): AiClient | null {
  if (!config.aiApiKey) return null;
  if (config.aiProvider !== "gemini") throw new Error(`Unsupported AI_PROVIDER: ${config.aiProvider}`);
  return createGeminiClient(config.aiApiKey, config.aiModel);
}
