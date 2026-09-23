/**
 * Share links: any JSON-serialisable value → JSON → deflate-raw
 * (CompressionStream) → base64url, wrapped in a versioned envelope so the
 * format can evolve. Works in browsers and Node ≥ 18.
 */

export const SHARE_VERSION = 1;

/** Refuse to inflate payloads beyond this size (guards against decompression bombs in pasted links). */
const MAX_DECODED_BYTES = 8 * 1024 * 1024;

interface Envelope {
  v: number;
  d: unknown;
}

async function pump(input: Uint8Array, transform: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const writing = (async () => {
    await writer.write(input as Uint8Array<ArrayBuffer>);
    await writer.close();
  })();
  // Errors surface through the reader; keep the writer side from raising an unhandled rejection.
  writing.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Shared data is too large");
    }
    chunks.push(value);
  }
  await writing;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const clean = s.trim();
  if (!/^[A-Za-z0-9_-]*$/.test(clean)) throw new Error("This share link is malformed (unexpected characters)");
  const b64 = clean.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((clean.length + 3) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new Error("This share link is malformed");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode any JSON-serialisable value as a compact URL-safe string. */
export async function encodeShare(obj: unknown): Promise<string> {
  const env: Envelope = { v: SHARE_VERSION, d: obj };
  const json = JSON.stringify(env);
  const bytes = new TextEncoder().encode(json);
  const deflated = await pump(bytes, new CompressionStream("deflate-raw"), Number.MAX_SAFE_INTEGER);
  return toBase64Url(deflated);
}

/**
 * Decode a string produced by `encodeShare`. Throws an Error with a
 * user-readable message on corrupt or incompatible input. The caller is
 * responsible for validating the shape of the returned value.
 */
export async function decodeShare<T>(s: string): Promise<T> {
  const bytes = fromBase64Url(s);
  if (bytes.length === 0) throw new Error("This share link is empty");
  let inflated: Uint8Array;
  try {
    inflated = await pump(bytes, new DecompressionStream("deflate-raw"), MAX_DECODED_BYTES);
  } catch (e) {
    if (e instanceof Error && e.message === "Shared data is too large") throw e;
    throw new Error("This share link is corrupted (could not decompress it)");
  }
  let env: unknown;
  try {
    env = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inflated));
  } catch {
    throw new Error("This share link is corrupted (invalid data)");
  }
  if (typeof env !== "object" || env === null || !("v" in env) || !("d" in env)) {
    throw new Error("This share link is not from Separatrix Studio");
  }
  const { v, d } = env as Envelope;
  if (typeof v !== "number") throw new Error("This share link is not from Separatrix Studio");
  if (v > SHARE_VERSION) throw new Error("This link was made by a newer version of Separatrix Studio; reload the page to update");
  if (v < 1) throw new Error("This share link uses an unknown format");
  return d as T;
}
