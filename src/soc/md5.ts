/**
 * MD5, hand-written, because WebCrypto does not implement it.
 *
 * Not for security — MD5 is broken for that and nothing here treats it as a
 * guarantee. It is here because a large part of the malware-lookup world is
 * still keyed on it: MalwareBazaar, a lot of vendor reports, and PhishTool's
 * own attachment model all carry md5 beside sha1 and sha256, and an analyst
 * who has to re-hash a file elsewhere to paste it into a lookup has been given
 * two of the three answers.
 *
 * RFC 1321. Verified against that document's own test vectors in md5.test.ts;
 * a hash that is subtly wrong is worse than no hash at all, because it looks
 * like an answer.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4,
  11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
]

/** K[i] = floor(2^32 × abs(sin(i + 1))), precomputed as RFC 1321 specifies. */
const K = new Uint32Array(64)
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)

const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c))

/** Hex MD5 of the given bytes. */
export function md5(bytes: Uint8Array): string {
  // Padding: the message, a 1 bit, zeroes, then the length in bits as a
  // 64-bit little-endian integer.
  const bitLen = bytes.length * 8
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  // Only the low 32 bits of the length are written as a number; the high word
  // is written separately so a file over 512MB still lengths correctly.
  view.setUint32(padded.length - 8, bitLen >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bytes.length / 536870912) >>> 0, true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  const m = new Uint32Array(16)
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(chunk + i * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const tmp = d
      d = c
      c = b
      b = (b + rotl((a + f + K[i] + m[g]) >>> 0, S[i])) >>> 0
      a = tmp
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, a0, true)
  outView.setUint32(4, b0, true)
  outView.setUint32(8, c0, true)
  outView.setUint32(12, d0, true)
  return [...out].map((b) => b.toString(16).padStart(2, '0')).join('')
}
