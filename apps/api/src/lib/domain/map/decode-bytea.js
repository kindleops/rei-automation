/** Decode Postgres bytea returned by Supabase RPC (\\x hex or base64). */
export function decodeSupabaseBytea(value) {
  if (!value) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return Uint8Array.from(value);

  const str = String(value);
  if (str.startsWith("\\x")) {
    return Uint8Array.from(Buffer.from(str.slice(2), "hex"));
  }
  try {
    return Uint8Array.from(Buffer.from(str, "base64"));
  } catch {
    return new Uint8Array(0);
  }
}