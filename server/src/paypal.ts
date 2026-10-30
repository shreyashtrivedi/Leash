// The only PayPal base URL in Leash. There is deliberately no live URL to switch to.
const BASE_URL = "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly name: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PayoutInput {
  senderBatchId: string;
  recipient: string;
  value: string;
  currency: string;
  note: string;
}

export interface PayoutItem {
  status: string;
  transactionId: string | null;
  itemId: string | null;
  error: string | null;
}

export interface RefundInput {
  captureId: string;
  value: string;
  currency: string;
  note: string;
  requestId: string;
}

export interface InvoiceInput {
  requestId: string;
  recipient: string;
  value: string;
  currency: string;
  description: string;
}

export interface PayPalClient {
  createPayout(input: PayoutInput): Promise<string>;
  getPayoutItem(batchId: string): Promise<PayoutItem | null>;
  cancelPayoutItem(itemId: string): Promise<void>;
  getCapture(captureId: string): Promise<{ value: string; currency: string }>;
  refundCapture(input: RefundInput): Promise<{ id: string; status: string }>;
  sendInvoice(input: InvoiceInput): Promise<string>;
}

export function createPayPalClient(clientId: string, clientSecret: string): PayPalClient {
  let cachedToken: { value: string; expiresAt: number } | null = null;

  async function getToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${credentials}` },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    const body: any = await res.json();
    if (!res.ok) throw new PayPalError(res.status, body.error ?? "AUTH_FAILED", "PayPal authentication failed");

    cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return cachedToken.value;
  }

  // A request ID makes PayPal treat a retry as the same call rather than a new one.
  async function request(method: string, path: string, body?: unknown, requestId?: string): Promise<any> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new PayPalError(res.status, parsed.name ?? "PAYPAL_ERROR", parsed.message ?? `PayPal returned ${res.status}`);
    }
    return parsed;
  }

  return {
    async createPayout({ senderBatchId, recipient, value, currency, note }) {
      const body = await request("POST", "/v1/payments/payouts", {
        sender_batch_header: { sender_batch_id: senderBatchId, email_subject: "Payment from a Leash agent" },
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value, currency },
            receiver: recipient,
            note,
            sender_item_id: senderBatchId.slice(0, 63),
            purpose: "SERVICES",
          },
        ],
      });
      return body.batch_header.payout_batch_id;
    },

    // Batch status can lag behind the item, so the item is the source of truth.
    async getPayoutItem(batchId) {
      const body = await request("GET", `/v1/payments/payouts/${batchId}`);
      const item = body.items?.[0];
      if (!item) return null;
      return {
        status: item.transaction_status ?? "PENDING",
        transactionId: item.transaction_id ?? null,
        itemId: item.payout_item_id ?? null,
        error: item.errors?.message ?? null,
      };
    },

    async cancelPayoutItem(itemId) {
      await request("POST", `/v1/payments/payouts-item/${itemId}/cancel`);
    },

    async getCapture(captureId) {
      const body = await request("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`);
      return { value: body.amount.value, currency: body.amount.currency_code };
    },

    async refundCapture({ captureId, value, currency, note, requestId }) {
      const body = await request(
        "POST",
        `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
        { amount: { value, currency_code: currency }, note_to_payer: note || "Refund from a Leash agent" },
        requestId,
      );
      return { id: body.id, status: body.status };
    },

    // PayPal drafts an invoice first, then sends it as a second step.
    async sendInvoice({ requestId, recipient, value, currency, description }) {
      const draft = await request(
        "POST",
        "/v2/invoicing/invoices",
        {
          detail: { currency_code: currency, note: "Sent by a Leash agent" },
          primary_recipients: [{ billing_info: { email_address: recipient } }],
          items: [
            {
              name: (description || "Invoice from a Leash agent").slice(0, 200),
              quantity: "1",
              unit_amount: { currency_code: currency, value },
            },
          ],
        },
        requestId,
      );
      await request("POST", `/v2/invoicing/invoices/${draft.id}/send`, { send_to_recipient: true }, `${requestId}-send`);
      return draft.id;
    },
  };
}
