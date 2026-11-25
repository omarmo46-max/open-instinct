/**
 * Languages. The model answers in the language the person writes in (the prompt says so);
 * this file covers the few sentences the runtime itself writes: acknowledgements, "new
 * conversation", the claim welcome, and so on. Arabic is first class: the owner can pin
 * a language and a dialect in config (`owner.language`, `owner.locale`), or leave it on
 * auto and each message is read for its script.
 */
export type Lang = "en" | "ar";

/** Share of letters that must be Arabic for a text to count as Arabic. Mixed text (a link, a brand name) still passes. */
const ARABIC_SHARE = 0.4;

/** The language of `text` by script: Arabic when enough of its letters are Arabic, else English. Undefined without letters. */
export function detectLanguage(text: string): Lang | undefined {
  let arabic = 0;
  let latin = 0;
  // Links and addresses are Latin whatever language the sentence around them is in.
  const prose = text.replace(/https?:\/\/\S+|www\.\S+|[^\s@]+@[^\s@]+\.[^\s@]+/gi, " ");
  for (const ch of prose) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) arabic++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  const letters = arabic + latin;
  if (letters === 0) return undefined;
  return arabic / letters >= ARABIC_SHARE ? "ar" : "en";
}

/** Arabic dialect hints the prompt understands. The agent mirrors what the person writes; this only sets the default. */
export const ARABIC_LOCALES: Readonly<Record<string, string>> = {
  "ar-EG": "Egyptian Arabic (عامية مصرية)",
  "ar-SA": "Gulf / Saudi Arabic (خليجي)",
  "ar-AE": "Gulf / Emirati Arabic (خليجي)",
  "ar-LB": "Levantine Arabic (شامي)",
  "ar-MA": "Moroccan Arabic (دارجة)",
  "ar": "Modern Standard Arabic (فصحى مبسطة)",
};

export interface LangPrefs {
  /** "auto" (default) reads each message; "ar" or "en" pins the language for runtime-written text. */
  language?: string;
  locale?: string;
}

/** Pick the language for a reply: a pinned preference wins, then the script of the person's own message, then English. */
export function pickLanguage(prefs: LangPrefs | undefined, text?: string): Lang {
  const pinned = prefs?.language?.toLowerCase();
  if (pinned === "ar" || pinned === "en") return pinned;
  const seen = text ? detectLanguage(text) : undefined;
  if (seen) return seen;
  if (prefs?.locale?.toLowerCase().startsWith("ar")) return "ar";
  return "en";
}

const STRINGS = {
  en: {
    ackDefault: "On it. I will text you when it is done.",
    ackEmail: "Got it. I am on it and will reply by email when done.",
    ackChat: "On it. This is taking a moment; send another message in a bit and I will have the answer here.",
    ackA2a: "Working on it.",
    newConversation: "Fresh start. I cleared this conversation. What I remember about you is still saved.",
    newConversationStranger: "Fresh start.",
    claimWelcome: "[I just texted my one-time sign-up code, so I am your owner now. Say hello.]",
    groupPending: "Someone addressed me in the group “{title}” ({key}), but I stay silent in groups until you allow it. Tell me “allow group {title}” if you want me to answer there. In a group I only use public web search and the group's own notes, never your private data.",
  },
  ar: {
    ackDefault: "تمام، شغال عليها. هبعتلك رسالة أول ما أخلّص.",
    ackEmail: "وصلتني. شغال عليها وهرد عليك بالإيميل أول ما أخلّص.",
    ackChat: "شغال عليها. الموضوع واخد وقت شوية؛ ابعتلي رسالة بعد شوية وهلاقي الإجابة جاهزة هنا.",
    ackA2a: "شغال عليها.",
    newConversation: "بدأنا من جديد. مسحت المحادثة دي، والحاجات اللي فاكرها عنك لسه محفوظة.",
    newConversationStranger: "بدأنا من جديد.",
    claimWelcome: "[لسه باعت كود التسجيل لمرة واحدة، يعني أنا بقيت المالك بتاعك دلوقتي. رحّب بيا.]",
    groupPending: "حد نادى عليا في الجروب «{title}» ({key})، بس أنا ساكت في الجروبات لحد ما تسمحلي. قولّي «اسمح بجروب {title}» لو عايزني أرد هناك. في الجروب بستخدم البحث على النت والملاحظات بتاعت الجروب نفسه بس، ومش بقرب من بياناتك الخاصة.",
  },
} as const;

export type StringKey = keyof (typeof STRINGS)["en"];

export function t(lang: Lang, key: StringKey): string {
  return STRINGS[lang][key];
}

/** Commands that start a fresh conversation, in any of the supported languages. Exact match after trimming. */
const NEW_COMMANDS: ReadonlySet<string> = new Set(["/new", "/reset", "/جديد", "محادثة جديدة", "ابدأ من جديد", "ابدا من جديد", "نبدأ من جديد"]);

export function isNewConversationCommand(text: string): boolean {
  const t = text.trim().replace(/@\w+$/, "").replace(/[.!؟?]+$/, "").trim().toLowerCase();
  return NEW_COMMANDS.has(t);
}
