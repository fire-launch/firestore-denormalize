import { describe, expect, it } from 'vitest'
import { eventarcPathPattern, isValidDocumentId, matchDocumentPath, parseCollectionPattern, patternsIntersect, resolveCollectionPath } from '../../src/paths.js'
import { fieldPathsOverlap, getField, setField } from '../../src/fields.js'

describe('collection patterns', () => {
  it('parses top-level and nested patterns', () => {
    const p = parseCollectionPattern('users/{uid}/posts/{postId}/comments')
    expect(p.params).toEqual(['uid', 'postId'])
    expect(p.key).toBe('users/{}/posts/{}/comments')
    expect(p.collectionId).toBe('comments')
    expect(parseCollectionPattern('config/main/items').params).toEqual([])
  })

  it('matches document paths and binds params', () => {
    const p = parseCollectionPattern('users/{uid}/posts')
    expect(matchDocumentPath(p, 'users/u1/posts/p1')).toEqual({ id: 'p1', params: { uid: 'u1' }, path: 'users/u1/posts/p1' })
    expect(matchDocumentPath(p, 'users/u1/comments/p1')).toBeUndefined()
    expect(matchDocumentPath(p, 'users/u1/posts/p1/x/y')).toBeUndefined()
    expect(matchDocumentPath(parseCollectionPattern('config/main/items'), 'config/other/items/i')).toBeUndefined()
  })

  it('resolves concrete collections', () => {
    const p = parseCollectionPattern('users/{uid}/posts')
    expect(resolveCollectionPath(p, { uid: 'u1' })).toBe('users/u1/posts')
    expect(resolveCollectionPath(p, {})).toBeUndefined()
    expect(eventarcPathPattern(p)).toBe('users/{uid}/posts/{docId}')
    expect(eventarcPathPattern(parseCollectionPattern('a/{docId}/b'))).toBe('a/{docId}/b/{docId2}')
  })
})

describe('document ids and pattern overlap', () => {
  it('validates document ids like Firestore does', () => {
    expect(['a', 'a-b', 'ünï', '_x', 'x__', '__x'].every(isValidDocumentId)).toBe(true)
    expect(['', '.', '..', 'a/b', '__x__', 'a'.repeat(1501)].some(isValidDocumentId)).toBe(false)
  })
  it('detects patterns that can match the same documents', () => {
    const p = (s: string) => parseCollectionPattern(s)
    expect(patternsIntersect(p('users/admin/posts'), p('users/{uid}/posts'))).toBe(true)
    expect(patternsIntersect(p('users/{a}/posts'), p('users/{b}/posts'))).toBe(true)
    expect(patternsIntersect(p('users/admin/posts'), p('users/guest/posts'))).toBe(false)
    expect(patternsIntersect(p('users/{uid}/posts'), p('users/{uid}/likes'))).toBe(false)
    expect(patternsIntersect(p('post'), p('users/{uid}/post'))).toBe(false)
  })
  it('picks an unused name for the document placeholder', () => {
    expect(eventarcPathPattern(parseCollectionPattern('a/{docId}/b/{docId2}/c'))).toBe('a/{docId}/b/{docId2}/c/{docId3}')
  })
})

describe('field paths', () => {
  it('reads and writes dotted paths', () => {
    expect(getField({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1)
    expect(getField({ a: 'x' }, 'a.b')).toBeUndefined()
    expect(getField(undefined, 'a')).toBeUndefined()
    const out = {}
    setField(out, 'a.b', 1)
    setField(out, 'a.c', 2)
    expect(out).toEqual({ a: { b: 1, c: 2 } })
  })
  it('detects overlapping paths', () => {
    expect(fieldPathsOverlap('a', 'a')).toBe(true)
    expect(fieldPathsOverlap('a', 'a.b')).toBe(true)
    expect(fieldPathsOverlap('a.b', 'a')).toBe(true)
    expect(fieldPathsOverlap('a', 'ab')).toBe(false)
  })
})
