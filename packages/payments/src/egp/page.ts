/** The owner's private card page. The link is the credential: request id plus a one-time random token. */
import type { EgpCardStore } from "./cards.js";
import { fmtEgp } from "./money.js";

export const EGP_PAGE_PREFIX = "/egp/card/";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function shell(body: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>بيانات الكارت</title><style>body{font-family:system-ui,sans-serif;max-width:420px;margin:2rem auto;padding:0 1rem;line-height:1.7}input,button{width:100%;font-size:1.1rem;padding:.7rem;margin:.3rem 0;box-sizing:border-box}button{background:#0a7;color:#fff;border:0;border-radius:8px}.row{display:flex;gap:.5rem}</style></head><body>${body}</body></html>`;
}

export interface PageResult {
  status: number;
  html: string;
}

export function handleEgpCardPage(cards: EgpCardStore, method: string, path: string, body: string): PageResult {
  const m = /^\/egp\/card\/(egp_[a-f0-9]{12})\/([A-Za-z0-9_-]{20,64})$/.exec(path);
  if (!m) return { status: 404, html: shell("<p>الرابط غير صحيح.</p>") };
  const [, id, token] = m as unknown as [string, string, string];
  cards.sweep();
  const r = cards.get(id);
  if (!r || !cards.tokenOk(r, token)) return { status: 404, html: shell("<p>الرابط غير صحيح.</p>") };
  if (r.status !== "awaiting_card") return { status: 410, html: shell("<p>الطلب ده خلص أو انتهى. اطلب من الوكيل طلب جديد.</p>") };

  if (method === "POST") {
    const f = new URLSearchParams(body);
    const err = cards.submit(id, token, {
      number: (f.get("number") ?? "").replace(/\s|-/g, ""),
      expMonth: Number(f.get("month")),
      expYear: Number(f.get("year")),
      cvv: (f.get("cvv") ?? "").trim(),
    });
    if (err) return { status: 400, html: shell(`<p>${esc(err)} ارجع وجرّب تاني.</p>`) };
    return { status: 200, html: shell("<p>تمام، الوكيل استلم الكارت. تقدر تقفل الصفحة.</p>") };
  }
  const form = `<h2>كارت مؤقت</h2><p>المبلغ: <b>${esc(fmtEgp(r.piasters))}</b><br>المتجر: <b>${esc(r.merchant)}</b></p>
<form method="post" autocomplete="off"><input name="number" inputmode="numeric" placeholder="رقم الكارت" required>
<div class="row"><input name="month" inputmode="numeric" placeholder="الشهر" required><input name="year" inputmode="numeric" placeholder="السنة" required></div>
<input name="cvv" inputmode="numeric" placeholder="CVV" required><button>إرسال للوكيل</button></form>`;
  return { status: 200, html: shell(form) };
}
