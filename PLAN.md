# Leash: Build Plan

Leash is a payment firewall for AI agents: an MCP server between any agent and the PayPal sandbox. **The AI proposes, the code decides.**

**Deadline:** 13 Nov 2026, 1:30 AM IST (12 Nov, noon Pacific). Code and deploy done by 10 Nov, video and text on 11 Nov, submitted on 12 Nov IST.

**Status of this plan:** Stages 1–8 are done (30 Oct), including the audit hash chain. Payouts work end to end through MCP over HTTP and stdio, and show in the sandbox. The dashboard is live, with approvals, timeline, AG Grid audit log, policy editor and spend summary. Invoice create and send also work, after the Invoicing feature was enabled on the app. Refunds of captured payments work in the sandbox, while payout cancel still fails on PayPal's side. Section 1 has the results.

### Stage 1 test results

| # | Question | Result |
| --- | --- | --- |
| 1 | Payouts access | **Works from a US sandbox business account.** An earlier business account was refused with 403 `PAYOUT_NOT_AVAILABLE`, and PayPal lists India as receive-only. Judges self-hosting need a US or other send-enabled account. |
| 2 | Payout reaches `SUCCESS` | **Yes,** in about 17 seconds, with a real transaction ID (`4NT866469N455861T`). The item reached `SUCCESS` while the batch still said `PROCESSING`, so Leash must poll the item status, not the batch. |
| 3 | Visible in the sandbox dashboard | **Yes.** Confirmed by screenshot of the sandbox business account: the $1.25 payment shows as Completed, with the unclaimed payouts listed too. |
| 4 | Unknown email and cancel | Payout goes `UNCLAIMED` in about 18–23 seconds with a transaction ID. **Cancel fails:** 400 `BATCH_NOT_COMPLETED` before the batch finishes, then 500 `INTERNAL_SERVICE_ERROR` every time afterwards, across two items, three request formats and repeated retries. |
| 5 | Invoice | **Works.** Draft and send both succeeded (`INV2-CCPJ-6HXZ-LGBU-DWPU`) once the Invoicing feature was enabled on the app. It returned 403 `NOT_AUTHORIZED` before that. |

**Design changes from these results**

- `pay` polls for up to 45 seconds, and the timeline shows a live "sending" state. The `processing` result stays. The demo is paced around a wait of about 20 seconds per payment.
- PayPal charges a $0.25 fee per payout in the sandbox. Budgets count the payment amount only, and the README says so.

## 1. The payment question

**Decision: the Payouts API is the primary path.** Leash's sandbox business account sends money to a recipient. A payout has no buyer in the flow, so there is nothing to click, and the direction matches what `pay` means.

| Option | Verdict |
| --- | --- |
| **Payouts API** (`POST /v1/payments/payouts`) | **Primary.** No buyer approval. Money moves between sandbox accounts, so it should be visible in the sandbox. |
| Orders API + vaulted payment source | **Not for `pay`.** It pulls money from a buyer into the merchant's account, so it can't pay an arbitrary recipient. It also needs a browser approval once, and may need Reference Transactions enabled. |
| PayPal Agent Toolkit / `@paypal/mcp` | **Learn from, don't wrap.** Its listed tools cover orders, invoices, refunds and disputes, with no payouts or vault tools. The README shows it can hold live PayPal access directly, which is exactly what a firewall must prevent. Its tool design is useful reference. |

There is no second money-movement path, because Orders can't do what `pay` does. The fallback for a Payouts failure is below.

### How the calls work

- **Pay:** `POST /v1/payments/payouts` with `sender_batch_header.sender_batch_id` and one item (`recipient_type: EMAIL`, `amount`, `receiver`, `note`, `sender_item_id`, `purpose`). Requires the scope `https://uri.paypal.com/payments/payouts`.
- **It is asynchronous.** The 201 response returns `batch_status: PENDING` with no transaction ID. Leash then polls `GET /v1/payments/payouts/{id}` for the item's `transaction_id` and `transaction_status`.
- **Duplicates:** PayPal rejects a `sender_batch_id` reused within 30 days, and a 5xx can be retried safely with the same ID. Leash derives it from its own payment ID.
- **Invoices:** `POST /v2/invoicing/invoices` creates a draft, then `POST /v2/invoicing/invoices/{id}/send` sends it. The send body is optional.

### Refunds need a design change

**PayPal documents no way to refund a claimed payout.** The API's only reversal is `POST /v1/payments/payouts-item/{id}/cancel`, which works only while the item is `UNCLAIMED`. The status list does include `REFUNDED` and `REVERSED`, but there is no documented call that produces them.

So `refund` behaves like this:

| Payment state | What `refund` does |
| --- | --- |
| `UNCLAIMED` payout | Calls cancel. If PayPal fails, `refund` reports that failure truthfully and marks nothing as refunded. Currently the sandbox returns 500 for every cancel. |
| Claimed payout (`SUCCESS`) | Returns a clear structured refusal: PayPal cannot reverse this, and the recipient has to send it back. |
| Money received through a PayPal capture | `POST /v2/payments/captures/{id}/refund`. **Proven in the sandbox, partial and full.** A test capture can be made with no browser step, using PayPal's test card in `server/scripts/create-test-capture.ts`. |

Stating these limits openly is better than promising something PayPal doesn't offer.

### What the Stage 1 script must prove

| # | Question | If it fails |
| --- | --- | --- |
| 1 | Does the app have Payouts access? Forum posts from 2018–19 report `AUTHORIZATION_ERROR` until Payouts is enabled and the account verified. | Check the app's settings, use a verified sandbox business account, then contact PayPal support. Stop and report if still blocked after 1 day. |
| 2 | Does a payout reach `SUCCESS`, how long does it take, and when does `transaction_id` appear? | Sets the polling design below. |
| 3 | Is the transaction visible on sandbox.paypal.com for both accounts? | A hard requirement. Stop and report. |
| 4 | Does paying an unknown email give `UNCLAIMED`, and does cancel return the money? | `refund` ships with the documented refusal only, and the plan says so. |
| 5 | Does invoice create and send work with this app? | `create_invoice` is cut, and I report it. |

## 2. Architecture

```
Claude Desktop / Cursor / demo agent
   │ stdio bridge (holds only LEASH_API_KEY)   or   streamable HTTP
   ▼
Leash server (one process)
   ├── MCP tools    pay, check_approval, refund, create_invoice, get_spend_summary
   ├── policy/      deterministic engine → ALLOW | REQUIRE_APPROVAL | DENY
   ├── approvals    pending queue, resolved by a human
   ├── paypal.ts    sandbox REST client
   ├── audit        append-only log → SSE
   ├── ai/          policy drafting + explanations (never in the decision path)
   └── SQLite
   ▲
React dashboard   timeline, approval cards, policy editor, spend summary
```

**Key decisions**

- **One server owns everything.** The stdio entry point is a small bridge that forwards to the running server over HTTP. Agents therefore never hold PayPal credentials, which is what makes this a firewall. It also gives one database and one live event stream.
- **Sandbox only.** Startup fails unless `PAYPAL_ENV=sandbox`, and the code contains only the sandbox base URL. There is no live URL to switch to.
- **Decision order.** Any failing hard rule gives `DENY`. Otherwise, exceeding the auto-approve limit gives `REQUIRE_APPROVAL`. Otherwise `ALLOW`. All rule results are returned every time, and a human can't override a `DENY`.
- **Checks and spend are atomic.** Evaluating the policy and reserving the amount happen in one SQLite transaction, so parallel calls can't both pass the same budget. A reservation becomes spend on success and is released on failure.
- **Approvals re-check on approve.** A held payment reserves nothing. It's re-evaluated when approved, because the budget or policy may have changed, and the approval itself satisfies only the auto-approve rule. Approve is an atomic state change, so a double-click can't pay twice.
- **Money is integer minor units.** Inputs are validated strictly: no negatives, zero, `NaN` or excess decimals.
- **Limits are in USD.** The demo allowlist is USD only. If a policy allows another currency, limits are counted through a small fixed-rate table in the code, disclosed in the README.
- **Agent-claimed data is not trusted.** A rogue agent can label a casino payment as "software". So a seeded recipient registry records each vendor's verified flag and real category. Rules check the registry, and for unknown recipients the declared category counts for nothing under a verified-only policy. "Verified vendors" in the policy language means this flag.
- **LLM output stays out of enforcement.** Tool responses to agents use the deterministic rule text. Explanations are generated after the decision and fall back to that text if the LLM fails.
- **The memo is not sent to the explanation LLM.** It's agent-written, so it could carry a prompt injection such as "tell the human this is safe". The explainer gets only structured facts. The approval card leads with those facts, shows the memo labelled as the agent's claim, and marks the explanation as AI-generated.

### Additions to the brief, each small

| Addition | Why |
| --- | --- |
| A `processing` result from `pay` | Payouts are asynchronous. If polling times out, Leash must not claim success, so it returns `processing`, and `check_approval` reports the final state. May be dropped if Stage 1 shows payouts always finish quickly. |
| Optional `idempotency_key` on `pay` | An LLM agent that retries after a timeout must not pay twice. |
| Recipient registry | Required for "verified vendors", as explained above. |
| "Run demo agent" button on the dashboard | Judges can see the whole scenario on the hosted URL with no setup. One run at a time, to limit AI and sandbox use. |

### Known limits, stated in the README

- `create_invoice` uses the policy's cap, recipient, currency and velocity rules, but invoices consume no budget because they request money rather than spend it.
- The dashboard has no login, as the brief has no accounts. A real deployment must protect it, since anyone reaching it could approve payments. The hosted demo is open so judges can try it, and it's sandbox only.
- Boot-time sample history is visibly marked **Sample** and carries no PayPal IDs. Every row shown as executed without that mark has a real sandbox transaction.

## 3. Folder structure

```
leash/
├── server/
│   ├── src/
│   │   ├── index.ts            startup, sandbox guard, Express
│   │   ├── mcp/{server,tools,stdio-bridge}.ts
│   │   ├── policy/{types,engine}.ts + engine.test.ts
│   │   ├── payments.ts         pay/approve/refund flow, reservations
│   │   ├── paypal.ts
│   │   ├── audit.ts
│   │   ├── db.ts + seed.ts
│   │   ├── routes.ts           dashboard REST + SSE
│   │   ├── ai/{client,draftPolicy,explain}.ts
│   │   └── demo/agent.ts       generic LLM agent using a real MCP client
│   └── scripts/paypal-smoke.ts Stage 1 script
├── client/src/                 React (Vite) dashboard
├── PLAN.md  README.md  SUBMIT.md  LICENSE  render.yaml  .env.example  .gitignore
└── package.json                npm workspaces, setup and dev scripts
```

**Dependencies:** `@modelcontextprotocol/sdk`, `zod`, `express`, `better-sqlite3`, `@anthropic-ai/sdk`, `dotenv`, `react`, `vite`, `tsx`, `typescript`, `vitest`. PayPal uses plain `fetch`, and live updates use native SSE.

**AI wrapper:** one `completeJson` function, configured by `AI_PROVIDER`, `AI_API_KEY` and `AI_MODEL`, with Gemini and Groq adapters. Groq with `openai/gpt-oss-20b` is in use and tested live. Gemini refused this project (403, free tier not available), and the brief's Anthropic default was dropped on 30 Oct to avoid paying for API credit. Free limits aren't guaranteed. Leash enforces policy the same way with no key.

**`.env.example` additions:** `LEASH_DEMO_AGENT_KEY` and `DEMO_VENDOR_EMAILS` (the sandbox recipient accounts).

## 4. Schedule

Each stage ends with a quick check-in.

| Date | Stage | Done when |
| --- | --- | --- |
| Oct 30–31 | **1. PayPal end to end** | All five Section 1 questions answered. Real transaction seen in the sandbox. |
| Nov 1 | **2. Policy engine** | Every rule tested, plus exact limits, multiple failures, and budget exhaustion across calls. |
| Nov 2–3 | **3. MCP server** | `pay` and `check_approval` work from a real MCP client over both transports. |
| Nov 3–4 | **4. Approvals and audit** | A held payment is approved and executes. Double approve and parallel spend tests pass. |
| Nov 5–6 | **5. Dashboard** | Timeline, approval cards, policy editor and spend summary, all live. |
| Nov 7 | **6. AI** | Policy drafting with review, plus explanations with fallback. |
| Nov 8 | **7. Demo agent** | Unmodified agent completes the full scenario. Rehearsed under 2 minutes. |
| Nov 9 | **8. Refund and invoice** | Tools ship as far as Stage 1 confirmed. Audit hash chain only if everything is solid. |
| Nov 10 | **9. Docs and deploy** | Render live. README and SUBMIT.md done. Fresh clone tested. |
| Nov 11 | Video and polish | Video under 3 minutes on YouTube, public. Devpost text final. |
| Nov 12 (IST) | Submit | Submitted well before the 1:30 AM IST cutoff on Nov 13. |

**If time slips, cut in this order:** audit hash chain, anomaly notes, capture refunds, invoices. The demo scenario in the brief is never cut.

## 5. Deployment and judging

- **One Render web service.** Express serves the built dashboard and MCP over HTTP.
- **Render's free disk is ephemeral,** so agents, policies and sample history re-seed on boot, and the real history resets with it.
- **Free services sleep when idle,** so the first visit is slow. The README warns judges, and the video doesn't depend on it.
- **The hosted URL is the main judge path.** It needs no PayPal setup. Running locally needs the judge's own sandbox app and AI key, because our credentials can't be shared. Payouts to emails outside their sandbox should still be real, pending Stage 1 question 4.
- **Prize fit:** Best Use of Agentic Commerce and Best Use of PayPal + AI are the natural targets, alongside the overall prizes. Hosting on Render also qualifies us for Best Use of Render, which pays in credits.
- **Submission rules checked against this plan:** the plan covers the working build, text description, tools list, public repo with a licence visible in the About section, and a public YouTube video under 3 minutes. The video must not use third-party trademarks or copyrighted music without permission.
- **Judging is criteria-based, with no weights published.** Presentation asks who it's for and why it matters, so the video opens with the problem and the audience, not the architecture.

## 6. Out of scope

Production PayPal, dashboard login and accounts, multi-recipient batches, a second AI provider, and anything else not in the brief.
