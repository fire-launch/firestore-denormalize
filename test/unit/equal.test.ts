import { describe, expect, it } from 'vitest'
import { GeoPoint, Timestamp } from 'firebase-admin/firestore'
import { isEqual } from '../../src/index.js'

describe('isEqual', () => {
  it('compares primitives', () => {
    expect(isEqual(1, 1)).toBe(true)
    expect(isEqual(1, '1')).toBe(false)
    expect(isEqual(NaN, NaN)).toBe(true)
    expect(isEqual(null, null)).toBe(true)
    expect(isEqual(null, undefined)).toBe(false)
    expect(isEqual(undefined, undefined)).toBe(true)
    expect(isEqual('a', 'b')).toBe(false)
  })
  it('compares maps structurally', () => {
    expect(isEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true)
    expect(isEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(isEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
  })
  it('compares arrays', () => {
    expect(isEqual([1, 'a'], [1, 'a'])).toBe(true)
    expect(isEqual([1, 2], [2, 1])).toBe(false)
    expect(isEqual([1], { 0: 1 })).toBe(false)
  })
  it('compares Firestore types via isEqual', () => {
    expect(isEqual(new Timestamp(1, 2), new Timestamp(1, 2))).toBe(true)
    expect(isEqual(new Timestamp(1, 2), new Timestamp(1, 3))).toBe(false)
    expect(isEqual(new GeoPoint(1, 2), new GeoPoint(1, 2))).toBe(true)
    expect(isEqual(new GeoPoint(1, 2), { latitude: 1, longitude: 2 })).toBe(false)
    expect(isEqual({ t: new Timestamp(1, 0) }, { t: new Timestamp(1, 0) })).toBe(true)
  })
  it('treats a Date as equal to the Timestamp of the same instant', () => {
    expect(isEqual(new Date(1_700_000_000_123), Timestamp.fromMillis(1_700_000_000_123))).toBe(true)
    expect(isEqual(Timestamp.fromMillis(1_700_000_000_123), new Date(1_700_000_000_123))).toBe(true)
    expect(isEqual(new Date(1_700_000_000_123), Timestamp.fromMillis(1_700_000_000_124))).toBe(false)
    expect(isEqual(new Date(1_700_000_000_000), new Timestamp(1_700_000_000, 1))).toBe(false) // sub-millisecond difference
  })
  it('compares bytes', () => {
    expect(isEqual(Buffer.from([1, 2]), Buffer.from([1, 2]))).toBe(true)
    expect(isEqual(Buffer.from([1, 2]), Buffer.from([1, 3]))).toBe(false)
    expect(isEqual(Buffer.from([1]), [1])).toBe(false)
  })
})
