/**
 * date-diff skill — calculates the difference between two dates.
 *
 * Accepts ISO dates, natural language keywords ("today", "tomorrow",
 * "yesterday"), and also named future dates like "Christmas 2026".
 */
import type { Tool } from "../tools";

function parseDate(raw: string): Date {
  const s = raw.trim().toLowerCase();
  const now = new Date();
  if (s === "today")     { const d = new Date(); d.setHours(0,0,0,0); return d; }
  if (s === "tomorrow")  { const d = new Date(); d.setDate(d.getDate()+1); d.setHours(0,0,0,0); return d; }
  if (s === "yesterday") { const d = new Date(); d.setDate(d.getDate()-1); d.setHours(0,0,0,0); return d; }
  if (s === "new year" || s === "new year's" || s === "new year's day") {
    return new Date(`${now.getFullYear() + (now.getMonth() >= 11 && now.getDate() > 25 ? 1 : 0)}-01-01`);
  }
  if (s === "christmas" || s === "xmas") {
    const y = now.getFullYear() + (now.getMonth() >= 11 && now.getDate() > 25 ? 1 : 0);
    return new Date(`${y}-12-25`);
  }
  const d = new Date(raw.trim());
  if (isNaN(d.getTime())) throw new Error(`Cannot parse date: "${raw}"`);
  return d;
}

function pluralise(n: number, unit: string): string {
  return `${n} ${unit}${n !== 1 ? "s" : ""}`;
}

export const dateDiffTool: Tool = {
  id: "date_diff",
  name: "Date Difference",
  description:
    'Calculates the difference between two dates. Accepts ISO dates (YYYY-MM-DD), ' +
    '"today", "tomorrow", "yesterday", or "Christmas" / "New Year". ' +
    'If "to" is omitted, today is used — useful for "days until X" or "days since Y".',
  requiresNetwork: false,
  params: [
    { name: "from", type: "string", description: 'Start date. E.g. "2025-01-01", "today", "Christmas"', required: true },
    { name: "to",   type: "string", description: 'End date (default: today)',                            required: false },
  ],
  async run({ from, to }) {
    if (!from) return "Error: from date is required";
    try {
      const d1 = parseDate(String(from));
      const d2 = to ? parseDate(String(to)) : (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
      d1.setHours(0,0,0,0);

      const MS_DAY = 86_400_000;
      const diffMs   = d2.getTime() - d1.getTime();
      const diffDays = Math.round(diffMs / MS_DAY);
      const absDays  = Math.abs(diffDays);

      const direction = diffDays === 0 ? "same day" : diffDays > 0 ? "in the future" : "in the past";

      // Calendar months / years (approximate)
      const sign = diffDays < 0 ? -1 : 1;
      let months = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
      if (sign * months < 0) months = 0;
      const years  = Math.floor(Math.abs(months) / 12);
      const remMon = Math.abs(months) % 12;

      const fmtOpts: Intl.DateTimeFormatOptions = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
      return [
        `From: ${d1.toLocaleDateString(undefined, fmtOpts)}`,
        `To:   ${d2.toLocaleDateString(undefined, fmtOpts)}`,
        ``,
        `Difference (${direction}):`,
        `  ${pluralise(absDays, "day")}`,
        `  ${(absDays / 7).toFixed(2)} weeks`,
        `  ≈ ${pluralise(years, "year")}${remMon > 0 ? `, ${pluralise(remMon, "month")}` : ""}`,
        `  ≈ ${(absDays / 365.25).toFixed(3)} decimal years`,
      ].join("\n");
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  },
};
