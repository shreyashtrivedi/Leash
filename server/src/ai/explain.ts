import { z } from "zod";
import type { AiClient } from "./client.js";

// Structured facts only. The agent's memo is deliberately absent: it is written by
// the agent being judged, so it must never be able to steer this text.
export interface DecisionFacts {
  outcome: "blocked" | "held";
  action: "payment" | "refund" | "invoice";
  agent: string;
  amount: string;
  currency: string;
  recipient: string;
  recipientKnown: boolean;
  recipientVerified: boolean;
  spentTodayCents: number;
  dailyBudgetCents: number;
  reasons: string[];
}

export type Explainer = (facts: DecisionFacts) => Promise<string | null>;

const MAX_PER_MINUTE = 8;
const MINUTE = 60_000;

const SYSTEM = `You explain a payment firewall's decision to a busy, non-technical person.
Write one or two plain sentences, under 45 words, saying what happened and why.
Use only the facts given. Do not recommend approving or rejecting. Do not add advice.
The decision is already final and was made by code, so never suggest you made it.`;

const responseSchema = z.object({ explanation: z.string() });

// Free-tier quota is shared, so a looping agent must not be able to use it all.
export function createExplainer(ai: AiClient, now: () => number = Date.now): Explainer {
  let recent: number[] = [];

  return async (facts) => {
    recent = recent.filter((time) => now() - time < MINUTE);
    if (recent.length >= MAX_PER_MINUTE) return null;
    recent.push(now());

    const { explanation } = await ai.completeJson({
      system: SYSTEM,
      prompt: JSON.stringify(facts),
      schema: responseSchema,
    });
    return explanation.trim().slice(0, 400) || null;
  };
}
