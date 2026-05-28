/**
 * @module driver/mongodb/crypto-utils
 * @description Cryptographic helpers for SCRAM-SHA-256 authentication.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function base64encode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

export function base64decode(str: string): string {
  const bytes = base64decodeToBytes(str);
  return textDecoder.decode(bytes);
}

export function base64decodeToBytes(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.length);
  new Uint8Array(buf).set(data);
  return buf;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", toArrayBuffer(data));
  return new Uint8Array(hash);
}

export async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, toArrayBuffer(data));
  return new Uint8Array(signature);
}

export function xorBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const len = Math.min(a.length, b.length);
  const result = new Uint8Array(new ArrayBuffer(len));
  for (let i = 0; i < len; i++) {
    result[i] = a[i]! ^ b[i]!;
  }
  return result;
}

export function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function generateNonce(length = 16): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    result += chars[array[i]! % chars.length];
  }
  return result;
}

export function escapeUsername(user: string): string {
  return user.replace(/=/g, "=3D").replace(/,/g, "=2C");
}

export { textEncoder, textDecoder };
export type { };
