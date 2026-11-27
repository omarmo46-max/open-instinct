/** Egyptian pound helpers. Amounts are kept in piasters (1 EGP = 100 piasters) so no float drift. */
export const EGP_CURRENCY = "EGP";
/** The Vodafone Cash wallet holds at most 100,000 EGP, so no single purchase can exceed it. */
export const MAX_EGP = 100_000;

export function toPiasters(egp: number): number | undefined {
  if (!Number.isFinite(egp) || egp < 0.01 || egp > MAX_EGP) return undefined;
  return Math.round(egp * 100);
}

export function fmtEgp(piasters: number): string {
  const v = piasters / 100;
  return `${Number.isInteger(v) ? v.toString() : v.toFixed(2)} EGP`;
}

/** The calendar day (YYYY-MM-DD) in Cairo, used for the daily cap. */
export function cairoDay(d: Date, tz = "Africa/Cairo"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
