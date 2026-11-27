/**
 * C3 grounding checker. Before a reply goes out, compare what it states with what is known:
 * figures, codes, links, emails, phone numbers and dates must appear in what the user said or a
 * tool returned this conversation, and "I booked / sent / paid it" must match a tool that ran.
 * It does not judge truth. It flags what it cannot tie to a source, and says so in the reply.
 */
import type { Capability } from "./types.js";

export type GroundingMode = "off" | "note";

export interface UngroundedClaim {
  kind: "amount" | "code" | "link" | "email" | "phone" | "date" | "action";
  text: string;
}

const MAX_EVIDENCE_CHARS = 200_000;
const MAX_FLAGGED = 4;

/** Digits and separators folded so "1,250.00", "١٢٥٠" and "1250" compare equal. */
export function foldDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

const num = (s: string): string => foldDigits(s).replace(/[^\d.]/g, "").replace(/\.0+$/, "").replace(/^0+(?=\d)/, "");

const AMOUNT = /(?:[$€£]|USD|EUR|GBP|EGP|SAR|AED)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:USD|EUR|GBP|EGP|SAR|AED|dollars?|euros?|جنيه|ج\.م|دولار|يورو|ريال|درهم)/gi;
const LINK = /https?:\/\/[^\s)>\]"']+/gi;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const PHONE = /(?<![\w])\+?\d[\d\s().-]{8,16}\d(?![\w])/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const CODE = /\b(?=[A-Z0-9]{6,10}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,10}\b/g;
const HEDGE = /\b(?:about|around|approximately|roughly|estimate[sd]?|maybe|probably|typically|usually)\b|تقريب|حوالي|نحو|ممكن|غالب/i;

/** Past-tense claims that something was done, with the tool capabilities that would make it true. */
const ACTION_CLAIMS: ReadonlyArray<{ re: RegExp; label: string; any: readonly Capability[] }> = [
  // JavaScript's \b only knows Latin letters, so the Arabic alternatives carry no word boundary.
  { re: /\b(?:i(?:'ve| have)?|just)\s+(?:sent|emailed|messaged|forwarded)\b|\bit(?:'s| has been) sent\b|(?:تم|خلاص)\s+(?:ال)?(?:ارسال|إرسال)|(?:ارسلت|أرسلت|بعتّ|بعت)(?:ه|ها|لك)?/i, label: "sent", any: ["email.send", "owner.relay", "network.ask", "phone.call", "apps.use", "computer.use", "plans.propose"] },
  { re: /\b(?:i(?:'ve| have)?|just)\s+(?:booked|reserved)\b|(?:تم|خلاص)\s+(?:ال)?حجز|(?:حجزت|حجزتلك)/i, label: "booked", any: ["travel.book", "apps.use", "computer.use", "purchase", "plans.commit"] },
  { re: /\b(?:i(?:'ve| have)?|just)\s+(?:paid|purchased|bought|ordered)\b|(?:تم|خلاص)\s+(?:ال)?(?:دفع|شراء)|(?:دفعت|اشتريت)/i, label: "paid", any: ["purchase", "apps.use", "computer.use", "travel.book"] },
  { re: /\b(?:i(?:'ve| have)?|just)\s+(?:cancell?ed)\b|(?:تم|خلاص)\s+(?:ال)?الغاء|(?:الغيت|ألغيت)/i, label: "cancelled", any: ["travel.book", "apps.use", "computer.use", "calendar.write", "plans.commit"] },
  { re: /\b(?:i(?:'ve| have)?|just)\s+(?:added|scheduled|put)\b[^.\n]{0,30}\b(?:calendar|reminder|schedule)\b|تم\s+(?:ال)?(?:اضافة|إضافة)[^.\n]{0,20}(?:التقويم|تذكير)|(?:ضفت|اضفت|أضفت)[^.\n]{0,20}(?:التقويم|تذكير)/i, label: "scheduled", any: ["calendar.write", "schedule.manage", "apps.use", "plans.commit"] },
  { re: /\b(?:i(?:'ve| have)?|just)\s+(?:saved|remembered|noted)\b|(?:حفظت|سجلت|سجّلت)/i, label: "saved", any: ["memory.write"] },
];

export const GROUNDING_NOTE = {
  en: "Note: I could not tie {list} to anything you told me or anything I looked up, so please double-check {them}.",
  ar: "تنبيه: ماقدرتش أربط {list} بحاجة إنت قلتهالي أو بحاجة دورت عليها، فاتأكد منها بنفسك.",
};

export class GroundingChecker {
  private readonly evidence = new Map<string, string[]>();
  private readonly ran = new Map<string, Array<{ tool: string; capabilities: readonly Capability[]; ok: boolean }>>();

  /** What the conversation has legitimately seen. Newest last, bounded. */
  add(conversationKey: string, text: string): void {
    if (!text) return;
    const list = this.evidence.get(conversationKey) ?? [];
    list.push(text.slice(0, 50_000));
    let total = list.reduce((a, s) => a + s.length, 0);
    while (total > MAX_EVIDENCE_CHARS && list.length > 1) total -= list.shift()!.length;
    this.evidence.set(conversationKey, list);
  }

  startTurn(conversationKey: string): void {
    this.ran.set(conversationKey, []);
  }

  toolRan(conversationKey: string, tool: string, capabilities: readonly Capability[], ok: boolean): void {
    const list = this.ran.get(conversationKey) ?? [];
    list.push({ tool, capabilities, ok });
    this.ran.set(conversationKey, list);
  }

  reset(conversationKey: string): void {
    this.evidence.delete(conversationKey);
    this.ran.delete(conversationKey);
  }

  /** Claims in `reply` that nothing known supports. */
  check(conversationKey: string, reply: string, extraEvidence: string[] = []): UngroundedClaim[] {
    const hay = foldDigits([...(this.evidence.get(conversationKey) ?? []), ...extraEvidence].join("\n")).toLowerCase();
    const hayNum = hay.replace(/[,\s]/g, "");
    const out: UngroundedClaim[] = [];
    const seen = new Set<string>();
    const push = (kind: UngroundedClaim["kind"], text: string): void => {
      const k = `${kind}:${text.toLowerCase()}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ kind, text });
      }
    };
    for (const line of reply.split("\n")) {
      if (HEDGE.test(line)) continue; // an estimate is not a claim of fact
      for (const m of line.matchAll(AMOUNT)) {
        const n = num(m[1] ?? m[2] ?? "");
        if (n && Number(n) >= 1 && !hayNum.includes(n.replace(/\.0*$/, ""))) push("amount", m[0].trim());
      }
      for (const m of line.matchAll(LINK)) if (!hay.includes(m[0].replace(/[.,;:!?]+$/, "").toLowerCase())) push("link", m[0].replace(/[.,;:!?]+$/, ""));
      for (const m of line.matchAll(EMAIL)) if (!hay.includes(m[0].toLowerCase())) push("email", m[0]);
      for (const m of line.matchAll(PHONE)) {
        const digits = foldDigits(m[0]).replace(/\D/g, "");
        if (digits.length >= 9 && !hayNum.includes(digits)) push("phone", m[0].trim());
      }
      for (const m of line.matchAll(ISO_DATE)) if (!hay.includes(m[0])) push("date", m[0]);
      for (const m of line.matchAll(CODE)) if (!hay.includes(m[0].toLowerCase())) push("code", m[0]);
    }
    const ran = (this.ran.get(conversationKey) ?? []).filter((r) => r.ok);
    for (const claim of ACTION_CLAIMS) {
      if (!claim.re.test(reply)) continue;
      if (!ran.some((r) => r.capabilities.some((c) => claim.any.includes(c)))) push("action", `I ${claim.label} it`);
    }
    return out;
  }

  /** The reply with a plain note appended when something could not be tied to a source. */
  apply(conversationKey: string, reply: string, mode: GroundingMode, extraEvidence: string[] = []): { text: string; claims: UngroundedClaim[] } {
    if (mode === "off" || !reply.trim()) return { text: reply, claims: [] };
    const claims = this.check(conversationKey, reply, extraEvidence);
    if (claims.length === 0) return { text: reply, claims };
    const arabic = /[\u0600-\u06FF]/.test(reply);
    const shown = claims.slice(0, MAX_FLAGGED).map((c) => (c.kind === "action" ? (arabic ? "إني نفّذت الحاجة دي" : c.text) : c.text));
    const list = shown.join(arabic ? "، " : ", ") + (claims.length > MAX_FLAGGED ? (arabic ? " وغيرها" : " and more") : "");
    const note = arabic ? GROUNDING_NOTE.ar.replace("{list}", list) : GROUNDING_NOTE.en.replace("{list}", list).replace("{them}", claims.length > 1 ? "them" : "it");
    return { text: `${reply}\n\n${note}`, claims };
  }
}
