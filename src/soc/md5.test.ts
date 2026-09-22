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
})
