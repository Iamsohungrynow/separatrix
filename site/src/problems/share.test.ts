import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare } from "./share";

describe("share links", () => {
  it("round-trip arbitrary JSON values", async () => {
    const values: unknown[] = [
      { problem: "maxcut", params: { nodes: 30, graph: "geometric", degree: 4, weighted: true }, seed: 7 },
      { text: 'Q = {(0, 0): -1, ("x", "y"): 0.5}\n# ünïcødé ✓ 量子', format: "auto" },
      [1, 2.5, -3e-9, null, true, "x"],
      "plain string",
      0,
    ];
    for (const v of values) {
      const s = await encodeShare(v);
      expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(await decodeShare(s)).toEqual(v);
    }
  });

  it("compresses repetitive payloads", async () => {
    const big = { terms: Array.from({ length: 2000 }, (_, i) => [i % 50, (i * 7) % 50, 1]) };
    const s = await encodeShare(big);
    expect(s.length).toBeLessThan(JSON.stringify(big).length / 3);
    expect(await decodeShare(s)).toEqual(big);
  });

  it("rejects malformed, corrupted, foreign and future links with readable errors", async () => {
    await expect(decodeShare("not base64!")).rejects.toThrow(/malformed/);
    await expect(decodeShare("")).rejects.toThrow(/empty/);
    await expect(decodeShare("AAAAAAAA")).rejects.toThrow(/corrupted/);
    const future = await encodeRaw({ v: 99, d: 1 });
    await expect(decodeShare(future)).rejects.toThrow(/newer version/);
    const foreign = await encodeRaw({ hello: "world" });
    await expect(decodeShare(foreign)).rejects.toThrow(/not from Separatrix Studio/);
  });
});

/** Encode a raw envelope (bypassing the version wrapper) to simulate other writers. */
async function encodeRaw(obj: unknown): Promise<string> {
  const s = await encodeShare(obj);
  const inner = await decodeShare<unknown>(s);
  expect(inner).toEqual(obj);
  // Re-encode without the envelope by compressing the bare JSON.
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
