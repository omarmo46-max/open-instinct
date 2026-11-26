/**
 * Memory search (B3). Finds notes by meaning when an embedding service is configured, and by
 * words otherwise (BM25 with Arabic and English normalization). The search is local code over
 * memory/MEMORY.md and the journals; only with an embedder do chunk texts leave the machine.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import type { MemoryStore } from "./memory.js";
import type { StateDir } from "./state.js";

const CACHE = "memory/embeddings.json";
const JOURNAL_DAYS = 90;
const BATCH = 64;
const MIN_SEMANTIC = 0.25;
const W_SEMANTIC = 0.7;

export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface MemoryChunk {
  text: string;
  /** "MEMORY.md" or the journal date. */
  source: string;
}

export interface MemoryHit extends MemoryChunk {
  score: number;
}

export interface SearchResult {
  hits: MemoryHit[];
  mode: "semantic" | "lexical";
  /** Set when semantic search was wanted but fell back to words. */
  note?: string;
}

/** Fold Arabic spelling variants and Latin case so "الإيميل" matches "الايميل" and "Hotel" matches "hotel". */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g, "")
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

const STOP = new Set(["the", "a", "an", "of", "to", "and", "is", "in", "on", "for", "my", "me", "at", "في", "من", "علي", "على", "الي", "الى", "ده", "دي", "انا", "مع", "عن"]);

export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeText(s).split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    const t = raw.length > 4 && raw.startsWith("ال") ? raw.slice(2) : raw.length > 5 && /^(وال|بال|كال|فال)/.test(raw) ? raw.slice(3) : raw;
    if (t.length >= 2 && !STOP.has(t)) out.push(t);
  }
  return out;
}

/** One chunk per fact line (with its heading) and per journal bullet. */
export function chunkMemory(durable: string, journals: Array<{ date: string; text: string }>): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  let heading = "";
  for (const line of durable.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (/^#{1,6}\s/.test(t)) {
      heading = t.replace(/^#{1,6}\s*/, "");
      continue;
    }
    const body = t.replace(/^[-*]\s*/, "");
    if (body.length >= 3) chunks.push({ text: heading ? `${heading}: ${body}` : body, source: "MEMORY.md" });
  }
  for (const j of journals) {
    for (const line of j.text.split("\n")) {
      const t = line.trim();
      if (t.startsWith("- ") && t.length > 8) chunks.push({ text: t.slice(2), source: j.date });
    }
  }
  return chunks;
}

function bm25(chunks: MemoryChunk[], query: string): number[] {
  const docs = chunks.map((c) => tokenize(c.text));
  const q = [...new Set(tokenize(query))];
  const n = docs.length;
  const avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, n);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  return docs.map((d) => {
    let score = 0;
    for (const term of q) {
      const f = d.filter((t) => t === term).length;
      if (!f) continue;
      const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      score += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / Math.max(1, avg))));
    }
    return score;
  });
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const hash = (model: string, text: string): string => createHash("sha1").update(`${model}\n${text}`).digest("hex").slice(0, 20);

export class MemorySearch {
  private readonly state: StateDir;
  private readonly memory: MemoryStore;
  private readonly embedder: Embedder | undefined;

  constructor(state: StateDir, memory: MemoryStore, embedder?: Embedder) {
    this.state = state;
    this.memory = memory;
    this.embedder = embedder;
  }

  private chunks(): MemoryChunk[] {
    const dir = this.state.path("memory", "journal");
    const journals: Array<{ date: string; text: string }> = [];
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-JOURNAL_DAYS);
      for (const f of files) journals.push({ date: f.slice(0, 10), text: this.state.readText(`memory/journal/${f}`, "") });
    }
    return chunkMemory(this.memory.readDurable(), journals);
  }

  async search(query: string, limit = 5): Promise<SearchResult> {
    const chunks = this.chunks();
    const k = Math.min(Math.max(1, Math.floor(limit)), 10);
    if (!query.trim() || chunks.length === 0) return { hits: [], mode: "lexical" };
    const lex = bm25(chunks, query);
    const lexMax = Math.max(...lex, 0);
    const lexical = (note?: string): SearchResult => ({
      hits: chunks.map((c, i) => ({ ...c, score: lexMax ? (lex[i] ?? 0) / lexMax : 0 })).filter((h) => h.score > 0).sort((a, b) => b.score - a.score).slice(0, k),
      mode: "lexical",
      ...(note ? { note } : {}),
    });
    if (!this.embedder) return lexical();
    try {
      const vectors = await this.vectors(chunks, query);
      const hits = chunks
        .map((c, i) => {
          const sem = Math.max(0, cosine(vectors.query, vectors.items[i] ?? []));
          return { ...c, score: sem >= MIN_SEMANTIC ? W_SEMANTIC * sem + (1 - W_SEMANTIC) * (lexMax ? (lex[i] ?? 0) / lexMax : 0) : (1 - W_SEMANTIC) * (lexMax ? (lex[i] ?? 0) / lexMax : 0) * 0.5 };
        })
        .filter((h) => h.score > 0.1)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
      return { hits, mode: "semantic" };
    } catch (error) {
      return lexical(`semantic search unavailable (${(error as Error).message.slice(0, 120)}); matched by words`);
    }
  }

  private async vectors(chunks: MemoryChunk[], query: string): Promise<{ query: number[]; items: number[][] }> {
    const embedder = this.embedder!;
    const cache = this.state.readJson<{ model?: string; items?: Record<string, number[]> }>(CACHE, {});
    const items: Record<string, number[]> = cache.model === embedder.model && cache.items ? { ...cache.items } : {};
    const keys = chunks.map((c) => hash(embedder.model, c.text));
    const missing = [...new Set(keys.filter((k) => !items[k]))];
    const textByKey = new Map(chunks.map((c, i) => [keys[i]!, c.text]));
    for (let i = 0; i < missing.length; i += BATCH) {
      const slice = missing.slice(i, i + BATCH);
      const out = await embedder.embed(slice.map((k) => textByKey.get(k)!));
      if (out.length !== slice.length) throw new Error("embedding count mismatch");
      slice.forEach((k, j) => (items[k] = out[j]!));
    }
    const [q] = await embedder.embed([query]);
    if (!q) throw new Error("no query embedding");
    const live = new Set(keys);
    for (const k of Object.keys(items)) if (!live.has(k)) delete items[k]; // drop vectors of deleted notes
    if (missing.length) this.state.writeJson(CACHE, { model: embedder.model, items });
    return { query: q, items: keys.map((k) => items[k] ?? []) };
  }
}

/** An OpenAI-compatible `/embeddings` client. */
export function openAIEmbedder(opts: { apiKey: string; baseUrl?: string; model?: string; fetchImpl?: typeof fetch }): Embedder {
  const base = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = opts.model ?? "text-embedding-3-small";
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    model,
    embed: async (texts) => {
      const res = await doFetch(`${base}/embeddings`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` }, body: JSON.stringify({ model, input: texts }), signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
      const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== texts.length || rows.some((r) => !Array.isArray(r.embedding))) throw new Error("bad embeddings response");
      return rows.map((r) => r.embedding as number[]);
    },
  };
}
