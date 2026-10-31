import { afterEach, describe, expect, it, vi } from "vitest";
import { createPayPalClient, PayPalError } from "./paypal.js";

const token = () => new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// Answers the login, then each PayPal call in order, recording what was sent.
function stubPayPal(responses: Response[]) {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/v1/oauth2/token")) return token();
    bodies.push(JSON.parse(init.body as string));
    return responses.shift();
  });
  return bodies;
}

const payout = { senderBatchId: "b1", recipient: "v@example.com", value: "1.00", currency: "USD", note: "<script>x</script>" };

describe("PayPal client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resends a payout with a neutral note when PayPal's firewall refuses the text", async () => {
    const bodies = stubPayPal([new Response("", { status: 406 }), json({ batch_header: { payout_batch_id: "B" } }, 201)]);
    const batchId = await createPayPalClient("id", "secret").createPayout(payout);
    expect(batchId).toBe("B");
    expect(bodies[0].items[0].note).toBe("<script>x</script>");
    expect(bodies[1].items[0].note).toBe("Payment from a Leash agent");
  });

  it("treats an empty 403 the same way", async () => {
    const bodies = stubPayPal([new Response("", { status: 403 }), json({ batch_header: { payout_batch_id: "B" } }, 201)]);
    await createPayPalClient("id", "secret").createPayout(payout);
    expect(bodies).toHaveLength(2);
  });

  it("doesn't resend a real permission error", async () => {
    const bodies = stubPayPal([json({ name: "NOT_AUTHORIZED", message: "No" }, 403)]);
    await expect(createPayPalClient("id", "secret").createPayout(payout)).rejects.toMatchObject({ status: 403 });
    expect(bodies).toHaveLength(1);
  });

  it("resends a refund with a neutral note", async () => {
    const bodies = stubPayPal([new Response("", { status: 406 }), json({ id: "R", status: "COMPLETED", amount: { value: "1.00" } })]);
    await createPayPalClient("id", "secret").refundCapture({ captureId: "C", value: "1.00", currency: "USD", note: "' OR 1=1 --", requestId: "r1" });
    expect(bodies[1].note_to_payer).toBe("Refund from a Leash agent");
  });

  it("resends an invoice with a neutral description", async () => {
    const bodies = stubPayPal([new Response("", { status: 406 }), json({ id: "INV" }, 201), json({})]);
    const id = await createPayPalClient("id", "secret").sendInvoice({ requestId: "r1", recipient: "c@example.com", value: "1.00", currency: "USD", description: "javascript:alert(1)" });
    expect(id).toBe("INV");
    expect(bodies[1].items[0].name).toBe("Invoice from a Leash agent");
  });

  it("gives up if the neutral note is refused too", async () => {
    stubPayPal([new Response("", { status: 406 }), new Response("", { status: 406 })]);
    await expect(createPayPalClient("id", "secret").createPayout(payout)).rejects.toMatchObject({ status: 406 });
  });

  it("doesn't resend for any other refusal", async () => {
    const bodies = stubPayPal([json({ name: "VALIDATION_ERROR", message: "Bad" }, 400)]);
    await expect(createPayPalClient("id", "secret").createPayout(payout)).rejects.toBeInstanceOf(PayPalError);
    expect(bodies).toHaveLength(1);
  });

  it("reports a successful status with an unreadable body as an error", async () => {
    stubPayPal([new Response("<html>gateway</html>", { status: 200 })]);
    await expect(createPayPalClient("id", "secret").createPayout(payout)).rejects.toMatchObject({ name: "INVALID_RESPONSE" });
  });

  it("reads an HTML error page as a plain PayPal error", async () => {
    stubPayPal([new Response("<html>bad gateway</html>", { status: 502 })]);
    await expect(createPayPalClient("id", "secret").createPayout(payout)).rejects.toMatchObject({ status: 502 });
  });

  it("uses PayPal's real refunded amount", async () => {
    stubPayPal([json({ id: "R", status: "COMPLETED", amount: { value: "15.00" } })]);
    const refund = await createPayPalClient("id", "secret").refundCapture({ captureId: "C", value: "20.00", currency: "USD", note: "", requestId: "r1" });
    expect(refund.value).toBe("15.00");
  });
});
