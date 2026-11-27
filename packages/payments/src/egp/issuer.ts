/**
 * Card issuers. This is the seam for partners. Today one issuer exists: the owner creates a temporary
 * Vodafone Cash card by hand ("manual"). A partner (Vodafone Cash, Fawry, a bank, a card issuer) plugs in by
 * implementing `AutomaticCardIssuer` and registering it; nothing else in the agent changes.
 */
import type { CardData } from "./cards.js";

export interface IssueRequest {
  requestId: string;
  piasters: number;
  merchant: string;
  /** How long the card must stay valid. */
  ttlMs: number;
  /** Same key on a retry returns the same card; never a second one. */
  idempotencyKey: string;
}

export interface IssuedCard {
  card: CardData;
  validUntil: Date;
}

interface IssuerBase {
  id: string;
  label: string;
}

/** The owner makes the card in their wallet app and types it into the private page. */
export interface ManualCardIssuer extends IssuerBase {
  mode: "manual";
  /** Plain steps for the owner, in the owner's language. */
  ownerSteps(amountText: string, merchant: string, formUrl: string): string;
}

/** A partner API creates the card for the exact amount. Needs the owner's consent set up once. */
export interface AutomaticCardIssuer extends IssuerBase {
  mode: "automatic";
  issue(req: IssueRequest): Promise<IssuedCard>;
}

export type CardIssuer = ManualCardIssuer | AutomaticCardIssuer;

export const vodafoneCashManual: ManualCardIssuer = {
  id: "vodafone-cash-manual",
  label: "Vodafone Cash temporary card (manual)",
  mode: "manual",
  ownerSteps: (amount, merchant, url) =>
    [
      `الوكيل محتاج يدفع ${amount} لـ ${merchant}.`,
      "1) افتح تطبيق أنا فودافون ← فودافون كاش ← كارت الدفع أونلاين، وأنشئ كارت مؤقت.",
      "2) تأكد إن رصيد المحفظة يغطي المبلغ.",
      `3) افتح الرابط ده وأدخل بيانات الكارت (مش في الشات): ${url}`,
      "الرابط يعمل لمدة 30 دقيقة ولمرة واحدة، والكارت بيتمسح بعد الاستخدام.",
    ].join("\n"),
};

export class IssuerRegistry {
  private readonly map = new Map<string, CardIssuer>();
  constructor(issuers: CardIssuer[] = [vodafoneCashManual]) {
    for (const i of issuers) this.register(i);
  }
  register(i: CardIssuer): void {
    this.map.set(i.id, i);
  }
  get(id: string): CardIssuer | undefined {
    return this.map.get(id);
  }
  list(): CardIssuer[] {
    return [...this.map.values()];
  }
}
