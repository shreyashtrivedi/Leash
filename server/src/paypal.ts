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

export interface PayPalClient {
  createPayout(input: PayoutInput): Promise<string>;
  getPayoutItem(batchId: string): Promise<PayoutItem | null>;
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

  async function request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        "Content-Type": "application/json",
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
  };
}
