import { describe, expect, it } from 'vitest'
import { collectionsOf, ConfigError, defineConfig, triggerName, validateConfig } from '../../src/index.js'

const base = defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  connections: [
    {
      name: 'post-category',
      source: 'category',
      target: 'post',
      idField: 'categoryId',
      fields: ['name', 'color'],
      targetField: 'category',
      onSourceDelete: 'setNull',
    },
  ],
})

const problemsOf = (config: Parameters<typeof validateConfig>[0]): string[] => {
  try {
    validateConfig(config)
    return []
  } catch (err) {
    if (err instanceof ConfigError) return err.problems
    throw err
  }
}

describe('validateConfig', () => {
  it('applies defaults', () => {
    const r = validateConfig(base)
    expect(r.database).toBe('(default)')
    expect(r.serviceRegion).toBe('asia-northeast1')
  })

  it('rejects a bad instance name', () => {
    expect(problemsOf({ ...base, name: 'Doc_Sync' })).toContainEqual(expect.stringContaining('`name` must match'))
  })

  it('rejects duplicate connection names', () => {
    const c = base.connections![0]!
    const problems = problemsOf({ ...base, connections: [c, { ...c, target: 'comment' }] })
    expect(problems).toEqual([expect.stringContaining('duplicate name')])
  })

  it('rejects the same (target, targetField) twice', () => {
    const c = base.connections![0]!
    const problems = problemsOf({ ...base, connections: [c, { ...c, name: 'other', source: 'tag', idField: 'tagId' }] })
    expect(problems).toEqual([expect.stringContaining('overlaps "category" written by connection "post-category"')])
  })

  it('rejects idField === targetField', () => {
    const c = base.connections![0]!
    expect(problemsOf({ ...base, connections: [{ ...c, targetField: 'categoryId' }] })).toContainEqual(
      expect.stringContaining('`idField` and `targetField` must not overlap'),
    )
  })

  it('rejects a targetField that is another connection idField on the same target', () => {
    const c = base.connections![0]!
    const problems = problemsOf({
      ...base,
      connections: [c, { ...c, name: 'x', source: 'tag', idField: 'category', targetField: 'tag' }],
    })
    expect(problems).toEqual([expect.stringContaining('used as an `idField`')])
  })

  it('rejects subcollections', () => {
    const c = base.connections![0]!
    expect(problemsOf({ ...base, connections: [{ ...c, source: 'shop/category' }] })).toContainEqual(
      expect.stringContaining('not a collection path'),
    )
  })

  it('accepts dotted field paths but rejects reserved characters and overlaps', () => {
    const c = base.connections![0]!
    expect(() => validateConfig({ ...base, connections: [{ ...c, idField: 'meta.categoryId', fields: ['name', 'address.city'] }] })).not.toThrow()
    expect(problemsOf({ ...base, connections: [{ ...c, idField: 'meta.*' }] })).toContainEqual(expect.stringContaining('`idField` must be a field path'))
    expect(problemsOf({ ...base, connections: [{ ...c, fields: ['name', 'a..b'] }] })).toContainEqual(expect.stringContaining('not a valid field path'))
    expect(problemsOf({ ...base, connections: [{ ...c, fields: ['address', 'address.city'] }] })).toContainEqual(expect.stringContaining('already covered'))
    expect(problemsOf({ ...base, connections: [{ ...c, idField: 'category.id' }] })).toContainEqual(expect.stringContaining('must not overlap'))
  })

  it('validates collection patterns', () => {
    const c = base.connections![0]!
    expect(() => validateConfig({ ...base, connections: [{ ...c, source: 'users/{uid}/categories', target: 'users/{uid}/posts' }] })).not.toThrow()
    expect(() => validateConfig({ ...base, connections: [{ ...c, target: 'users/{uid}/posts' }] })).not.toThrow()
    expect(problemsOf({ ...base, connections: [{ ...c, source: 'users/{uid}/categories' }] })).toContainEqual(
      expect.stringContaining('{uid} of `source` must also appear in `target`'),
    )
    expect(problemsOf({ ...base, connections: [{ ...c, source: 'users/{uid}' }] })).toContainEqual(expect.stringContaining('not a collection path'))
    expect(problemsOf({ ...base, connections: [{ ...c, source: 'users/uid}/x' }] })).toContainEqual(expect.stringContaining('not a valid placeholder'))
    expect(problemsOf({ ...base, connections: [{ ...c, source: 'users/{a}/x/{a}/y' }] })).toContainEqual(expect.stringContaining('appears twice'))
  })

  it('validates aggregates', () => {
    const agg = { name: 'post-likes', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count' as const, targetField: 'likeCount' }
    expect(() => validateConfig({ ...base, connections: [], aggregates: [agg] })).not.toThrow()
    expect(() => validateConfig({ ...base, connections: [], aggregates: [{ ...agg, source: 'like', idParam: undefined, idField: 'postId', aggregate: { sum: 'weight' } }] })).not.toThrow()
    expect(problemsOf({ ...base, connections: [], aggregates: [{ ...agg, idField: 'postId' }] })).toContainEqual(expect.stringContaining('exactly one of'))
    expect(problemsOf({ ...base, connections: [], aggregates: [{ ...agg, idParam: 'nope' }] })).toContainEqual(expect.stringContaining('not a placeholder of `source`'))
    expect(problemsOf({ ...base, connections: [], aggregates: [{ ...agg, aggregate: 'avg' as never }] })).toContainEqual(expect.stringContaining("'count' or { sum"))
    expect(problemsOf({ ...base, connections: [], aggregates: [{ ...agg, target: 'users/{uid}/post' }] })).toContainEqual(
      expect.stringContaining('{uid} of `target` must also appear in `source`'),
    )
    const c = base.connections![0]!
    expect(problemsOf({ ...base, connections: [{ ...c, targetField: 'likeCount' }], aggregates: [{ ...agg }] })).toContainEqual(
      expect.stringContaining('overlaps "likeCount"'),
    )
  })

  it('rejects loops where each write triggers the next rule', () => {
    const c = base.connections![0]!
    const problems = problemsOf({
      ...base,
      connections: [
        { ...c, fields: ['name', 'thread'] },
        { ...c, name: 'a', source: 'post', target: 'thread', idField: 'postId', targetField: 'post', fields: ['category'] },
        { ...c, name: 'b', source: 'thread', target: 'category', idField: 'threadId', targetField: 'thread', fields: ['post'] },
      ],
    })
    expect(problems).toEqual([expect.stringMatching(/form a loop.*post-category -> a -> b -> post-category/)])
  })

  it('allows collection cycles whose writes do not feed the next rule', () => {
    // thread -> message.thread and message -> thread.lastMessage: neither watches the other's written field
    const c = base.connections![0]!
    expect(() =>
      validateConfig({
        ...base,
        connections: [
          { ...c, name: 'message-thread', source: 'thread', target: 'message', idField: 'threadId', fields: ['title'], targetField: 'thread' },
          { ...c, name: 'thread-last', source: 'message', target: 'thread', idField: 'threadId', fields: ['text'], targetField: 'lastMessage' },
        ],
      }),
    ).not.toThrow()
  })

  it('rejects a count whose write feeds a copy that feeds the count', () => {
    const c = base.connections![0]!
    const problems = problemsOf({
      ...base,
      connections: [{ ...c, name: 'like-post', source: 'post', target: 'like', idField: 'postId', fields: ['likeCount'], targetField: 'weight' }],
      aggregates: [{ name: 'post-likes', source: 'like', target: 'post', idField: 'postId', aggregate: { sum: 'weight' }, targetField: 'likeCount' }],
    })
    expect(problems).toEqual([expect.stringContaining('form a loop')])
  })

  it('allows chains without cycles', () => {
    const c = base.connections![0]!
    expect(() =>
      validateConfig({
        ...base,
        connections: [c, { ...c, name: 'a', source: 'post', target: 'thread', idField: 'postId', targetField: 'post' }],
      }),
    ).not.toThrow()
  })

  it('rejects colliding trigger names', () => {
    const c = base.connections![0]!
    const problems = problemsOf({
      ...base,
      connections: [c, { ...c, name: 'x', source: 'user_room', target: 'user-room', idField: 'roomId', targetField: 'room' }],
    })
    expect(problems).toEqual([expect.stringContaining('both map to trigger "doc-sync-user-room"')])
  })

  it('reports several problems at once', () => {
    const problems = problemsOf({ ...base, region: '', connections: [], aggregates: [] })
    expect(problems.length).toBeGreaterThanOrEqual(2)
  })
})

describe('collectionsOf / triggerName', () => {
  it('lists sorted unique collections, ignoring placeholder names', () => {
    const c = base.connections![0]!
    const list = collectionsOf({
      connections: [c, { ...c, name: 'x', source: 'area', target: 'category' }, { ...c, name: 'y', source: 'users/{uid}/a', target: 'users/{u}/a' }],
    })
    expect(list.map((p) => p.raw)).toEqual(['area', 'category', 'post', 'users/{uid}/a'])
  })
  it('replaces underscores and joins subcollection ids', () => {
    expect(triggerName('doc-sync', 'user_room')).toBe('doc-sync-user-room')
    expect(triggerName('doc-sync', 'users/{uid}/payments')).toBe('doc-sync-users-payments')
  })
})
