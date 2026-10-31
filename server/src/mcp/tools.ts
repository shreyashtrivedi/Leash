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
        currency: z.string().min(1).max(10).describe("ISO currency code, for example USD"),
        category: z
          .string()
          .regex(/^[\w -]{1,40}$/, "Use a short plain label")
          .describe("What the payment is for, for example software"),
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
    "refund",
    {
      title: "Refund a payment",
      description:
        "Refund money through Leash, subject to policy. Pass capture_id to refund a payment this PayPal account " +
        "received: the money always returns to the original payer, and amount is optional for a full refund. Pass " +
        "payment_id to reverse a payout Leash sent: PayPal allows this only while the payout is unclaimed. Returns " +
        '"executed", "refunded", "blocked", "pending_approval", "processing", "not_refundable", "not_found" or "failed", with a reason.',
      inputSchema: {
        capture_id: z
          .string()
          .regex(/^[A-Za-z0-9-]{1,40}$/, "Use the capture ID exactly as PayPal gave it")
          .optional()
          .describe("The PayPal capture to refund"),
        payment_id: z.string().max(40).optional().describe("The Leash payment_id of a payout to reverse"),
        amount: z.union([z.string(), z.number()]).optional().describe("Part of a capture to refund. Omit for all of it"),
        reason: z.string().max(255).optional().describe("Shown to the payer"),
        idempotency_key: z.string().max(100).optional().describe("Reuse the same key when retrying"),
      },
    },
    async ({ capture_id, payment_id, amount, reason, idempotency_key }) => {
      if (Boolean(capture_id) === Boolean(payment_id)) {
        return respond({ status: "invalid_request", reason: "Pass exactly one of capture_id or payment_id." });
      }
      return respond(
        capture_id
          ? await payments.refundCapture(agent, { captureId: capture_id, amount, reason, idempotencyKey: idempotency_key })
          : await payments.reversePayout(agent, payment_id!),
      );
    },
  );

  server.registerTool(
    "create_invoice",
    {
      title: "Send an invoice",
      description:
        "Create and send a PayPal invoice through Leash, subject to policy. Invoices request money, so they do not " +
        'use budget. Returns "executed" with a PayPal invoice id, or "blocked", "pending_approval", "processing" or "failed", with a reason.',
      inputSchema: {
        recipient: z.string().email().describe("The customer's email address"),
        amount: z.union([z.string(), z.number()]).describe('Amount with at most 2 decimals, for example "19.99"'),
        currency: z.string().min(1).max(10).describe("ISO currency code, for example USD"),
        description: z.string().min(1).max(200).describe("What the invoice is for"),
        category: z
          .string()
          .regex(/^[\w -]{1,40}$/, "Use a short plain label")
          .describe("What kind of work this bills for, for example consulting"),
        idempotency_key: z.string().max(100).optional().describe("Reuse the same key when retrying"),
      },
    },
    async ({ recipient, amount, currency, description, category, idempotency_key }) =>
      respond(
        await payments.createInvoice(agent, {
          recipient,
          amount,
          currency,
          category,
          memo: description,
          idempotencyKey: idempotency_key,
        }),
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
          per_recipient_limit_24h: formatUsd(policy.recipientWindowLimitCents),
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
