// Creates a real captured sandbox payment, so the refund tool has something to refund.
// Uses PayPal's documented sandbox test card, and refuses to run outside the sandbox.
// Run from server/: npx tsx scripts/create-test-capture.ts [amount]
import { config } from "../src/config.js";

const BASE_URL = "https://api-m.sandbox.paypal.com";
const value = process.argv[2] ?? "9.50";

const credentials = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString("base64");
const token: any = await fetch(`${BASE_URL}/v1/oauth2/token`, {
  method: "POST",
  headers: { Authorization: `Basic ${credentials}` },
  body: new URLSearchParams({ grant_type: "client_credentials" }),
}).then((res) => res.json());

const res = await fetch(`${BASE_URL}/v2/checkout/orders`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    "PayPal-Request-Id": crypto.randomUUID(),
    Prefer: "return=representation",
  },
  body: JSON.stringify({
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "USD", value }, description: "Leash test customer payment" }],
    payment_source: {
      card: {
        number: "4111111111111111",
        expiry: "2030-12",
        name: "Test Customer",
        security_code: "123",
        billing_address: {
          address_line_1: "2211 N First Street",
          admin_area_2: "San Jose",
          admin_area_1: "CA",
          postal_code: "95131",
          country_code: "US",
        },
      },
    },
  }),
});
const order: any = await res.json();
const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
if (!capture) throw new Error(`No capture created: ${res.status} ${JSON.stringify(order).slice(0, 300)}`);
console.log(capture.id);
