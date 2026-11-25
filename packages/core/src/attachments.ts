/**
 * Pictures a person sent, handed to the model as images when it can see them. Only files
 * under the inbound folder are read (the channels put them there), so a path smuggled into
 * a message can never pull another file into the prompt.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { InboundMessage } from "./types.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

/** True when `file` is inside `dir` once symlinks are resolved. */
export function isInside(dir: string, file: string): boolean {
  try {
    const root = realpathSync(dir);
    const real = realpathSync(file);
    const rel = path.relative(root, real);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** The message's image attachments as model input. Skips anything missing, too big, not an image, or outside `inboundDir`. */
export function loadImageAttachments(msg: InboundMessage, inboundDir: string): ImageContent[] {
  const out: ImageContent[] = [];
  for (const a of msg.attachments ?? []) {
    if (out.length >= MAX_IMAGES_PER_MESSAGE) break;
    const mime = IMAGE_TYPES[(a.mimeType ?? "").split(";")[0]!.trim().toLowerCase()];
    if (!mime || !a.path || !isInside(inboundDir, a.path)) continue;
    try {
      if (statSync(a.path).size > MAX_IMAGE_BYTES) continue;
      out.push({ type: "image", data: readFileSync(a.path).toString("base64"), mimeType: mime });
    } catch {
      // A file that vanished or cannot be read is simply not shown to the model.
    }
  }
  return out;
}
