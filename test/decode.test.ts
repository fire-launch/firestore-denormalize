import { beforeAll, describe, expect, it } from 'vitest'
import { GeoPoint, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { decodeDocumentEventData, DecodeError } from '../src/index.js'
import { change, clearFirestore, encodeEvent, firestore, resourceName } from './helpers.js'

let db: Firestore

beforeAll(async () => {
  db = firestore()
  await clearFirestore()
})

describe('decodeDocumentEventData', () => {
  it('round-trips every value type through protobuf', async () => {
    const ref = db.collection('any').doc('v')
    const data = {
      s: 'text',
      i: 42,
      d: 1.5,
      b: true,
      n: null,
      t: new Timestamp(1700000000, 123456789),
      g: new GeoPoint(35.6, 139.7),
      r: db.doc('other/x'),
      bytes: Buffer.from([1, 2, 3]),
      arr: [1, 'two', { three: 3 }],
      map: { nested: { deep: 'yes' } },
    }
    const { before, after } = await change(ref, () => ref.set(data))
    const ev = decodeDocumentEventData(encodeEvent(before, after), 'application/protobuf', db)

    expect(ev.before).toBeUndefined()
    expect(ev.database).toBe('(default)')
    expect(ev.after?.path).toBe('any/v')
    const out = ev.after!.data
    expect(out.s).toBe('text')
    expect(out.i).toBe(42)
    expect(out.d).toBe(1.5)
    expect(out.b).toBe(true)
    expect(out.n).toBeNull()
    // The emulator stores microsecond precision, so compare with what Firestore actually holds.
    expect((out.t as Timestamp).isEqual(after.get('t'))).toBe(true)
    expect((out.g as GeoPoint).isEqual(data.g)).toBe(true)
    expect(out.r.path).toBe('other/x')
    expect(Buffer.from(out.bytes).equals(data.bytes)).toBe(true)
    expect(out.arr).toEqual([1, 'two', { three: 3 }])
    expect(out.map).toEqual({ nested: { deep: 'yes' } })
  })

  it('decodes a delete (no after) and an update (both)', async () => {
    const ref = db.collection('any').doc('d')
    await ref.set({ a: 1 })
    const upd = await change(ref, () => ref.update({ a: 2 }))
    const ev1 = decodeDocumentEventData(encodeEvent(upd.before, upd.after), 'application/protobuf', db)
    expect(ev1.before?.data).toEqual({ a: 1 })
    expect(ev1.after?.data).toEqual({ a: 2 })

    const del = await change(ref, () => ref.delete())
    const ev2 = decodeDocumentEventData(encodeEvent(del.before, del.after), 'application/protobuf', db)
    expect(ev2.before?.data).toEqual({ a: 2 })
    expect(ev2.after).toBeUndefined()
  })

  it('decodes the JSON representation', () => {
    const json = {
      oldValue: {},
      value: {
        name: resourceName('post/p1'),
        fields: {
          title: { stringValue: 'hi' },
          count: { integerValue: '7' },
          when: { timestampValue: '2024-01-02T03:04:05.123456789Z' },
          flag: { booleanValue: false },
          none: { nullValue: null },
          ref: { referenceValue: resourceName('user/u1') },
          geo: { geoPointValue: { latitude: 1, longitude: 2 } },
          raw: { bytesValue: Buffer.from('xyz').toString('base64') },
          tags: { arrayValue: { values: [{ stringValue: 'a' }] } },
          meta: { mapValue: { fields: { k: { doubleValue: 0.5 } } } },
        },
        createTime: '2024-01-02T03:04:05Z',
        updateTime: '2024-01-02T03:04:05Z',
      },
      updateMask: { fieldPaths: [] },
    }
    const ev = decodeDocumentEventData(json, 'application/json', db)
    expect(ev.before).toBeUndefined()
    const d = ev.after!.data
    expect(d.title).toBe('hi')
    expect(d.count).toBe(7)
    expect((d.when as Timestamp).seconds).toBe(Date.parse('2024-01-02T03:04:05Z') / 1000)
    expect((d.when as Timestamp).nanoseconds).toBe(123456789)
    expect(d.flag).toBe(false)
    expect(d.none).toBeNull()
    expect(d.ref.path).toBe('user/u1')
    expect((d.geo as GeoPoint).latitude).toBe(1)
    expect(Buffer.from(d.raw).toString()).toBe('xyz')
    expect(d.tags).toEqual(['a'])
    expect(d.meta).toEqual({ k: 0.5 })

    // Same thing as a JSON string body
    const ev2 = decodeDocumentEventData(JSON.stringify(json), 'application/json; charset=utf-8', db)
    expect(ev2.after?.data.title).toBe('hi')
  })

  it('keeps integers beyond 2^53 exact so changes are not masked', () => {
    const doc = (n: string) => ({
      value: { name: resourceName('x/1'), fields: { big: { integerValue: n } } },
    })
    const a = decodeDocumentEventData(doc('9007199254740993'), 'application/json', db).after!.data.big
    const b = decodeDocumentEventData(doc('9007199254740992'), 'application/json', db).after!.data.big
    expect(a).not.toEqual(b)
    expect(decodeDocumentEventData(doc('42'), 'application/json', db).after!.data.big).toBe(42)
  })

  it('throws DecodeError on garbage', () => {
    expect(() => decodeDocumentEventData(Buffer.from([0xff, 0xff, 0xff]), 'application/protobuf', db)).toThrow(DecodeError)
    expect(() => decodeDocumentEventData('{not json', 'application/json', db)).toThrow(DecodeError)
    expect(() => decodeDocumentEventData(undefined, 'application/protobuf', db)).toThrow(DecodeError)
  })
})
