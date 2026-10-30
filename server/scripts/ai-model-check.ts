// Checks whether the configured AI provider answers for each model named on the command line.
// Run from server/: npx tsx scripts/ai-model-check.ts <model> [model...]
import { z } from "zod";

const models = process.argv.slice(2);

for (const model of models) {
  process.env.AI_MODEL = model;
  // Imported per model because the client reads its settings once at startup.
  const { createAiClientFor } = await import("../src/ai/client.js");
  const ai = createAiClientFor(model);
  try {
    const reply = await ai.completeJson({
      system: "Reply as JSON.",
      prompt: "Say ok.",
      schema: z.object({ reply: z.string() }),
    });
    console.log(`${model}: works`, reply);
  } catch (err) {
    console.log(`${model}: ${(err as Error).message.slice(0, 110)}`);
  }
}
