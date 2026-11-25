/**
 * Text from the documents people send: plain text formats directly, PDF through unpdf,
 * Word (.docx) through mammoth. Scanned PDFs and pictures of text have no text layer, so
 * they come back empty and the caller says so. Long documents are cut, and the cut is marked.
 */
import { readFileSync, statSync } from "node:fs";

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 12_000;

const PLAIN_TYPES = new Set([
  "text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "text/calendar", "text/vcard", "text/x-vcard",
  "application/json", "application/xml", "text/xml", "text/html", "application/x-yaml", "text/yaml",
]);
const PLAIN_EXT = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".ics", ".vcf", ".yaml", ".yml", ".log", ".html", ".htm"]);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type DocumentKind = "plain" | "pdf" | "docx";

export function documentKind(mimeType: string | undefined, name: string | undefined): DocumentKind | undefined {
  const type = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = name?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0]?.toLowerCase() ?? "";
  if (type === "application/pdf" || ext === ".pdf") return "pdf";
  if (type === DOCX || ext === ".docx") return "docx";
  if (PLAIN_TYPES.has(type) || type.startsWith("text/") || PLAIN_EXT.has(ext)) return "plain";
  return undefined;
}

export interface ExtractedText {
  text: string;
  /** True when the document had more text than `maxChars`. */
  truncated: boolean;
  pages?: number;
}

/** The readable text of a document, or undefined when its type is not one we read. Throws on a damaged file or one that is too large. */
export async function extractDocumentText(file: string, mimeType: string | undefined, name: string | undefined, maxChars = DEFAULT_MAX_CHARS): Promise<ExtractedText | undefined> {
  const kind = documentKind(mimeType, name);
  if (!kind) return undefined;
  if (statSync(file).size > MAX_DOCUMENT_BYTES) throw new Error("the document is too large");
  const bytes = readFileSync(file);
  let raw = "";
  let pages: number | undefined;
  if (kind === "plain") {
    raw = bytes.toString("utf8");
    if (/\.html?$/i.test(name ?? "") || (mimeType ?? "").includes("html")) raw = stripHtml(raw);
  } else if (kind === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const out = await extractText(pdf, { mergePages: true });
    raw = Array.isArray(out.text) ? out.text.join("\n") : out.text;
    pages = out.totalPages;
  } else {
    const mammoth = await import("mammoth");
    raw = (await mammoth.extractRawText({ buffer: bytes })).value;
  }
  const text = raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = text.length > maxChars;
  return { text: truncated ? text.slice(0, maxChars).trimEnd() : text, truncated, ...(pages !== undefined ? { pages } : {}) };
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
