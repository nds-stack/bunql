/**
 * Pure JS MD5 (RFC 1321) — for PG md5(password+user) authentication.
 */

const textEncoder = new TextEncoder();

export function md5(str: string): string {
  const bytes = textEncoder.encode(str);
  const n = bytes.length;
  const padded = new Uint8Array((n + 72) & ~63);
  padded.set(bytes);
  padded[n] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, n << 3, true);

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;

  for (let i = 0; i < padded.length; i += 64) {
    const w: number[] = [];
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, true);
    let [A, B, C, D] = [a, b, c, d];

    for (let j = 0; j < 64; j++) {
      const idx = j < 16 ? j : j < 32 ? (5 * j + 1) % 16 : j < 48 ? (3 * j + 5) % 16 : (7 * j) % 16;
      const k = w[idx]!;
      const s = j < 16 ? [7, 12, 17, 22][j % 4]! : j < 32 ? [5, 9, 14, 20][j % 4]! : j < 48 ? [4, 11, 16, 23][j % 4]! : [6, 10, 15, 21][j % 4]!;
      let f: number;
      if (j < 16) f = (b & c) | (~b & d);
      else if (j < 32) f = (d & b) | (~d & c);
      else if (j < 48) f = b ^ c ^ d;
      else f = c ^ (b | ~d);
      const x = (a + f + k + K[j]!) >>> 0;
      const nb = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
      [a, b, c, d] = [d, nb, b, c];
    }

    a = (a + A) >>> 0;
    b = (b + B) >>> 0;
    c = (c + C) >>> 0;
    d = (d + D) >>> 0;
  }

  const bytes_out = new Uint8Array(16);
  const dv_out = new DataView(bytes_out.buffer);
  dv_out.setUint32(0, a, true);
  dv_out.setUint32(4, b, true);
  dv_out.setUint32(8, c, true);
  dv_out.setUint32(12, d, true);

  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += bytes_out[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];
