// All limits are enforced in integer US cents. Floats never touch money.

const MAX_AMOUNT_CENTS = 100_000_000_00;

// Fixed demo rates: US cents per 100 minor units. Not live FX.
const USD_RATE_PER_100: Record<string, number> = { USD: 100, EUR: 108, GBP: 127 };

export function isSupportedCurrency(currency: string): boolean {
  return Object.hasOwn(USD_RATE_PER_100, currency);
}

// Returns null for anything that is not a plain positive amount with at most 2 decimals.
export function parseMinorUnits(amount: unknown): number | null {
  if (typeof amount !== "string" && typeof amount !== "number") return null;
  const text = String(amount);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;

  const [whole = "0", fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (cents <= 0 || cents > MAX_AMOUNT_CENTS) return null;
  return cents;
}

// Rounds up, so conversion can never slip a payment under a limit.
export function toUsdCents(minorUnits: number, currency: string): number {
  const rate = USD_RATE_PER_100[currency];
  if (rate === undefined) throw new Error(`Unsupported currency: ${currency}`);
  return Math.ceil((minorUnits * rate) / 100);
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
