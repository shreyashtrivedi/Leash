// Stage 1: proves Leash can move real sandbox money with no buyer click.
// Run: node --env-file=.env --experimental-strip-types server/scripts/paypal-smoke.ts <recipient-email>

const BASE_URL = "https://api-m.sandbox.paypal.com";

if (process.env.PAYPAL_ENV !== "sandbox") {
  console.error("Refusing to run: PAYPAL_ENV must be sandbox.");
  process.exit(1);
}

const recipient = process.argv[2];
if (!recipient) {
  console.error("Usage: paypal-smoke.ts <recipient-email>");
  process.exit(1);
}

type ApiResult = { status: number; body: any };

async function getToken(): Promise<{ token: string; scope: string }> {
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
  ).toString("base64");
  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}` },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${body.error}`);
  return { token: body.access_token, scope: body.scope };
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function sendPayout(token: string, receiver: string, value: string) {
  const sentAt = Date.now();
  const created = await api(token, "POST", "/v1/payments/payouts", {
    sender_batch_header: {
      sender_batch_id: `leash-smoke-${crypto.randomUUID()}`,
      email_subject: "Leash sandbox test payment",
    },
    items: [
      {
        recipient_type: "EMAIL",
        amount: { value, currency: "USD" },
        receiver,
        note: "Leash Stage 1 smoke test",
        sender_item_id: "smoke-item-1",
        purpose: "SERVICES",
      },
    ],
  });
  console.log(`  create: HTTP ${created.status}`, created.body.batch_header?.batch_status ?? JSON.stringify(created.body));
  if (created.status !== 201) return null;

  const batchId = created.body.batch_header.payout_batch_id;
  for (let attempt = 0; attempt < 30; attempt++) {
    const batch = await api(token, "GET", `/v1/payments/payouts/${batchId}`);
    const item = batch.body.items?.[0];
    const status = item?.transaction_status;
    if (status && status !== "PENDING") {
      console.log(`  final after ${Date.now() - sentAt}ms:`, {
        batch_id: batchId,
        batch_status: batch.body.batch_header?.batch_status,
        item_id: item.payout_item_id,
        transaction_id: item.transaction_id ?? null,
        transaction_status: status,
        errors: item.errors ?? null,
      });
      return item;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log("  still PENDING after 30s");
  return null;
}

async function main() {
  const { token, scope } = await getToken();
  console.log("Q0 token ok. payouts scope:", scope.includes("payments/payouts"), "| invoicing scope:", scope.includes("invoicing"));

  console.log("Q1-3 payout to sandbox account");
  await sendPayout(token, recipient, "1.25");

  console.log("Q4 payout to an email with no sandbox account");
  const unclaimed = await sendPayout(token, `leash-unclaimed-${Date.now()}@example.com`, "1.50");
  if (unclaimed?.transaction_status === "UNCLAIMED") {
    const cancel = await api(token, "POST", `/v1/payments/payouts-item/${unclaimed.payout_item_id}/cancel`);
    console.log(`  cancel: HTTP ${cancel.status}`, cancel.body.transaction_status ?? JSON.stringify(cancel.body));
  }

  console.log("Q5 invoice");
  const draft = await api(token, "POST", "/v2/invoicing/invoices", {
    detail: { currency_code: "USD", note: "Leash Stage 1 smoke test" },
    primary_recipients: [{ billing_info: { email_address: recipient } }],
    items: [{ name: "Smoke test", quantity: "1", unit_amount: { currency_code: "USD", value: "2.00" } }],
  });
  console.log(`  draft: HTTP ${draft.status}`, draft.status >= 400 ? JSON.stringify(draft.body) : "");
  const invoiceId = draft.body.id ?? String(draft.body.href ?? "").split("/").pop();
  if (invoiceId) {
    const sent = await api(token, "POST", `/v2/invoicing/invoices/${invoiceId}/send`, { send_to_recipient: true });
    console.log(`  send: HTTP ${sent.status}`, invoiceId, sent.status >= 400 ? JSON.stringify(sent.body) : "");
  }
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
