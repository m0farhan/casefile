import { describe, expect, it } from 'vitest'
import { md5 } from './md5'

const of = (s: string): string => md5(new TextEncoder().encode(s))

describe('md5 against RFC 1321 appendix A.5', () => {
  // A hash that is subtly wrong looks like an answer, so these are the
  // document's own vectors, not values this implementation produced.
  it('matches every published vector', () => {
    expect(of('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(of('a')).toBe('0cc175b9c0f1b6a831c399e269772661')
    expect(of('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(of('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0')
    expect(of('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b')
    expect(of('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')).toBe(
      'd174ab98d277d9f5a5611c2c9f419d9f'
    )
    expect(of('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe(
      '57edf4a22be3c955ac49da2e2107b67a'
    )
  })

  it('handles the block boundaries, where padding goes wrong', () => {
    // 55 fits with the length; 56 forces a second block; 64 is exactly one.
    expect(of('a'.repeat(55))).toBe('ef1772b6dff9a122358552954ad0df65')
    expect(of('a'.repeat(56))).toBe('3b0c8ac703f828b04c6c197006d17218')
    expect(of('a'.repeat(64))).toBe('014842d480b571495a4a0363793f7367')
  })

  it('hashes bytes, not text', () => {
    expect(md5(Uint8Array.from([0x00, 0xff, 0x10]))).toMatch(/^[0-9a-f]{32}$/)
    expect(md5(new Uint8Array(0))).toBe('d41d8cd98f00b204e9800998ecf8427e')
  })

  it('matches an independent MD5 on a large buffer and on a view into the middle of one', () => {
    // The expected values were computed over these same bytes by Node's
    // crypto.createHash('md5') and by macOS md5(1), not by this file. A seeded
    // generator makes the bytes the same on every run.
    const big = new Uint8Array(3_000_001)
    let seed = 0x2545f491
    for (let i = 0; i < big.length; i++) {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      big[i] = seed & 0xff
    }
    expect(md5(big)).toBe('c3de7e5216bdd583051064a105c21ca3')
    // A subarray whose bytes start mid-buffer: every read must count from the
    // view, not from the start of the buffer beneath it.
    expect(md5(big.subarray(12_345, 12_345 + 1_000_003))).toBe('696a83ec9563f46c36ed2bf01e8ca137')
    // Short views either side of the one- and two-block tails.
    const at = (n: number): string => md5(big.subarray(7, 7 + n))
    expect(at(63)).toBe('4f33e8cdb80277315671a8115d887248')
    expect(at(65)).toBe('70bcf2037d56d5150ab3fcdbae0c4b3b')
    expect(at(119)).toBe('a154cb6a983a29c7b55c61cab6d89d81')
    expect(at(120)).toBe('6e5a77464ce8dc5f942a2ad2f2bda738')
    expect(at(128)).toBe('e2bac00203f114d7a2a4040c654c650d')
  })
})
