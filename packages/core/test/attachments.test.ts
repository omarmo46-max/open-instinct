import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES, isInside, loadImageAttachments } from "../src/attachments.js";
import { inbound } from "./helpers.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "att-"));
  const inboundDir = path.join(root, "inbound");
  fs.mkdirSync(inboundDir);
  return { root, inboundDir };
}

describe("loadImageAttachments", () => {
  it("returns images from the inbound folder as base64 and skips everything else", () => {
    const { root, inboundDir } = setup();
    const png = path.join(inboundDir, "a.png");
    fs.writeFileSync(png, Buffer.from([1, 2, 3]));
    const pdf = path.join(inboundDir, "b.pdf");
    fs.writeFileSync(pdf, "x");
    const outside = path.join(root, "secret.png");
    fs.writeFileSync(outside, "secret");
    const link = path.join(inboundDir, "link.png");
    fs.symlinkSync(outside, link);
    const msg = inbound({
      channel: "telegram",
      from: "telegram:1",
      attachments: [
        { path: png, mimeType: "image/png" },
        { path: pdf, mimeType: "application/pdf" },
        { path: outside, mimeType: "image/png" },
        { path: link, mimeType: "image/png" },
        { path: path.join(inboundDir, "missing.png"), mimeType: "image/png" },
        { url: "https://example.com/x.png", mimeType: "image/png" },
      ],
    });
    expect(loadImageAttachments(msg, inboundDir)).toEqual([{ type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" }]);
  });

  it("caps the number and the size of images", () => {
    const { inboundDir } = setup();
    const files = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 2 }, (_, i) => {
      const f = path.join(inboundDir, `${i}.jpg`);
      fs.writeFileSync(f, "x");
      return { path: f, mimeType: "image/jpeg" };
    });
    expect(loadImageAttachments(inbound({ channel: "telegram", from: "telegram:1", attachments: files }), inboundDir)).toHaveLength(MAX_IMAGES_PER_MESSAGE);
    const big = path.join(inboundDir, "big.jpg");
    fs.writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect(loadImageAttachments(inbound({ channel: "telegram", from: "telegram:1", attachments: [{ path: big, mimeType: "image/jpeg" }] }), inboundDir)).toEqual([]);
  });

  it("isInside rejects the folder itself and parents", () => {
    const { root, inboundDir } = setup();
    expect(isInside(inboundDir, inboundDir)).toBe(false);
    expect(isInside(inboundDir, root)).toBe(false);
    expect(isInside(inboundDir, path.join(inboundDir, "nope"))).toBe(false);
  });
});
