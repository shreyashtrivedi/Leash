// Runs the demo agent repeatedly against a running server, approving held payments,
// and scores each run on the scenario from the demo. Sends real sandbox payments.
// Run from server/: npx tsx scripts/demo-reliability.ts [runs]
const BASE = process.env.LEASH_BASE ?? "http://localhost:3000";
const runs = Number(process.argv[2] ?? 3);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const getState = async (): Promise<any> => (await fetch(`${BASE}/api/state`)).json();

let passed = 0;
for (let run = 1; run <= runs; run++) {
  const startId = Math.max(0, ...(await getState()).events.map((event: any) => event.id));
  const started = Date.now();
  await fetch(`${BASE}/api/demo/run`, { method: "POST" });

  let state = await getState();
  while (state.demo.running && Date.now() - started < 300_000) {
    for (const approval of state.approvals) await fetch(`${BASE}/api/approvals/${approval.id}/approve`, { method: "POST" });
    await sleep(2000);
    state = await getState();
  }

  const events = state.events.filter((event: any) => event.id > startId).reverse();
  const amount = (type: string, value: string) =>
    events.filter((event: any) => event.type === type && event.summary.startsWith(value)).length;
  const sent = (value: string) =>
    events.filter((event: any) => event.type === "payment.executed" && event.summary.startsWith(`Sent ${value}`)).length;

  const checks = {
    paid12: sent("12.00") === 1,
    blocked120: amount("decision.deny", "120.00") === 1,
    paid20: sent("20.00") === 1,
    held30: amount("decision.require_approval", "30.00") === 1,
    paid30: sent("30.00") === 1,
    noExtraPayments: events.filter((event: any) => event.type === "payment.executed").length === 3,
    reported: Boolean(state.demo.report) && !state.demo.error,
  };
  const ok = Object.values(checks).every(Boolean);
  if (ok) passed++;
  const failed = Object.entries(checks).filter(([, value]) => !value).map(([name]) => name);
  console.log(`run ${run}: ${ok ? "PASS" : `FAIL (${failed.join(", ")})`} in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`  report: ${state.demo.report ?? state.demo.error}`);
  if (!ok) console.log(`  events: ${events.map((event: any) => event.type).join(", ")}`);
  await sleep(5000);
}
console.log(`${passed} of ${runs} runs matched the scenario`);
const final = await getState();
console.log("spent cents:", final.agents[0].spend.spentTodayCents, "| chain:", JSON.stringify(final.auditChain));
process.exit(0);
