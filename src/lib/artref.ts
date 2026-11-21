// Artwork arrives from the backend as `data:` URLs — the whole image as one long base64
// string, often hundreds of KB. Kept as-is, every cache keyed by the image (sizes, colours,
// blurs, …) would hold its own copy, and each media update would parse yet another one.
// Instead each distinct image becomes a short `blob:` URL once: the bytes live in a single
// Blob, everything downstream keys on a ~60-character string, and the same picture always
// maps to the same URL (so nothing re-decodes or flickers). Old ones are released.

const LIMIT = 48; // distinct images kept; the ones on screen are always recently used
const urls = new Map<string, string>(); // fingerprint → blob: URL, oldest first

function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

export function toBlobUrl(src: string): string | null {
  try {
    const comma = src.indexOf(",");
    if (comma < 0) return null;
    const meta = src.slice(5, comma);
    const isB64 = meta.endsWith(";base64");
    const mime = (isB64 ? meta.slice(0, -7) : meta) || "application/octet-stream";
    const body = src.slice(comma + 1);
    let bytes: Uint8Array;
    if (isB64) {
      const bin = atob(body);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  } catch {
    return null;
  }
}

/** A short, stable URL for this artwork (`data:` URLs become shared `blob:` URLs). */
export function artRef<T extends string | null | undefined>(src: T): T {
  if (!src || !src.startsWith("data:")) return src;
  const key = fingerprint(src);
  const hit = urls.get(key);
  if (hit) {
    urls.delete(key); // mark as recently used
    urls.set(key, hit);
    return hit as T;
  }
  const url = toBlobUrl(src);
  if (!url) return src;
  urls.set(key, url);
  while (urls.size > LIMIT) {
    const [k, v] = urls.entries().next().value!;
    urls.delete(k);
    URL.revokeObjectURL(v);
  }
  return url as T;
}
