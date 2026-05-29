/**
 * exchange-rates skill — live FX rates + conversion via the Frankfurter API.
 *
 * Frankfurter (https://www.frankfurter.app) is a free, open-source ECB rates
 * service.  No registration or API key required.
 *
 * Supported currencies: ~30 major currencies tracked by the European Central Bank.
 */
import type { Tool } from "../tools";
import { skillFetch } from "./shared";

interface FrankfurterResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

// Well-known currency symbols for nicer output
const SYMBOLS: Record<string, string> = {
  USD:"$", EUR:"€", GBP:"£", JPY:"¥", CHF:"Fr", CAD:"C$", AUD:"A$",
  NZD:"NZ$", CNY:"¥", HKD:"HK$", SGD:"S$", KRW:"₩", INR:"₹",
  BRL:"R$", MXN:"$", SEK:"kr", NOK:"kr", DKK:"kr", PLN:"zł",
  CZK:"Kč", HUF:"Ft", RON:"lei", BGN:"лв", HRK:"kn", TRY:"₺",
  ZAR:"R", ILS:"₪", AED:"د.إ", THB:"฿", MYR:"RM", IDR:"Rp",
};

export const exchangeRatesTool: Tool = {
  id: "exchange_rates",
  name: "Exchange Rates",
  description:
    "Gets live currency exchange rates and converts amounts. No API key required (Frankfurter / ECB data). " +
    'Supports ~30 major currencies. Examples: "USD to EUR", "100 GBP to JPY".',
  requiresNetwork: true,
  params: [
    { name: "from",   type: "string", description: "Source currency code, e.g. USD, EUR, GBP",                                   required: true  },
    { name: "to",     type: "string", description: "Target currency code(s), comma-separated (e.g. \"EUR,GBP,JPY\"). Omit for top 10.", required: false },
    { name: "amount", type: "number", description: "Amount to convert (default 1)",                                                required: false },
  ],
  async run({ from, to, amount }, signal) {
    if (!from) return "Error: from currency code is required (e.g. USD)";
    const base = String(from).toUpperCase().trim();
    const amt  = typeof amount === "number" && amount > 0 ? amount : 1;

    const toParam  = to ? `&to=${String(to).toUpperCase().replace(/\s/g, "")}` : "";
    const url      = `https://api.frankfurter.app/latest?from=${base}${toParam}&amount=${amt}`;

    try {
      const body = await skillFetch(url, signal);
      const data = JSON.parse(body) as FrankfurterResponse;
      if (!data.rates || Object.keys(data.rates).length === 0) {
        return (
          `No rates found. "${base}" may not be supported. ` +
          "Common codes: USD EUR GBP JPY CHF CAD AUD SEK NOK DKK PLN CZK HUF INR."
        );
      }
      const sym   = SYMBOLS[base] ?? "";
      const lines = [
        `Exchange rates — ${sym}${amt} ${base}  (ECB, ${data.date})`,
        "",
      ];
      // Sort by currency code for readability
      const entries = Object.entries(data.rates).sort(([a], [b]) => a.localeCompare(b));
      for (const [cur, rate] of entries) {
        const s = SYMBOLS[cur] ?? "";
        lines.push(`  ${cur}  ${s}${+rate.toFixed(4)}`);
      }
      return lines.join("\n");
    } catch (e) {
      return `Exchange rate error: ${String(e)}`;
    }
  },
};
