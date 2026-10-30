import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Agent } from "../db.js";
import type { PaymentService } from "../payments.js";
import { formatUsd } from "../policy/money.js";

const respond = (result: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  structuredContent: result,
});

// One server per agent identity, so a tool can only ever act as that agent.
export function createMcpServer(agent: Agent, payments: PaymentService): McpServer {
  const server = new McpServer({ name: "leash", version: "0.1.0" });

  server.registerTool(
    "pay",
    {
      title: "Send a payment",
      description:
        "Send a payment through Leash. A human-defined policy decides the result. Returns status " +
        '"executed" (sent, with a PayPal transaction id), "blocked" (refused, with the rule that blocked it), ' +
        '"pending_approval" (waiting for a human, with an approval_id), "processing" (still being sent), or ' +
        '"failed". Read the reason and adapt. Do not retry a blocked payment unchanged.',
      inputSchema: {
        recipient: z.string().email().describe("The recipient's PayPal email address"),
        amount: z.union([z.string(), z.number()]).describe('Amount with at most 2 decimals, for example "19.99"'),
        currency: z.string().describe("ISO currency code, for example USD"),
        category: z.string().describe("What the payment is for, for example software"),
        memo: z.string().max(500).optional().describe("Note shown to the recipient"),
        idempotency_key: z
          .string()
          .max(100)
          .optional()
          .describe("Reuse the same key when retrying, so one payment cannot be sent twice"),
      },
    },
    async ({ recipient, amount, currency, category, memo, idempotency_key }) =>
      respond(await payments.pay(agent, { recipient, amount, currency, category, memo, idempotencyKey: idempotency_key })),
  );

  server.registerTool(
    "check_approval",
    {
      title: "Check an approval or payment",
      description: "Get the current status of an approval_id or payment_id returned by pay.",
      inputSchema: { approval_id: z.string().describe("The approval_id or payment_id") },
    },
    async ({ approval_id }) =>
      respond(
        (await payments.check(agent, approval_id)) ?? {
          status: "not_found",
          reason: `No payment or approval ${approval_id} exists for this agent.`,
        },
      ),
  );

  server.registerTool(
    "get_spend_summary",
    {
      title: "Get spend summary",
      description: "See remaining budget, spend today and the active policy, so you can plan within your limits.",
      inputSchema: {},
    },
    async () => {
      const spend = payments.spendSummary(agent);
      const { policy } = agent;
      return respond({
        status: "ok",
        spent_today: formatUsd(spend.spentTodayCents),
        remaining_today: formatUsd(spend.remainingTodayCents),
        remaining_total: formatUsd(spend.remainingTotalCents),
        payments_last_hour: spend.paymentsLastHour,
        policy: {
          per_transaction_cap: formatUsd(policy.perTransactionCapCents),
          auto_approve_limit: formatUsd(policy.autoApproveLimitCents),
          daily_budget: formatUsd(policy.dailyBudgetCents),
          total_budget: formatUsd(policy.totalBudgetCents),
          max_payments_per_hour: policy.maxPaymentsPerHour,
          allowed_currencies: policy.allowedCurrencies,
          blocked_categories: policy.blockedCategories,
          verified_recipients_only: policy.requireVerifiedRecipient,
        },
      });
    },
  );

  return server;
}
