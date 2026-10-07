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
    const c = base.connections[0]!
    const problems = problemsOf({ ...base, connections: [c, { ...c, target: 'comment' }] })
    expect(problems).toEqual([expect.stringContaining('duplicate name')])
  })

  it('rejects the same (target, targetField) twice', () => {
    const c = base.connections[0]!
    const problems = problemsOf({ ...base, connections: [c, { ...c, name: 'other', source: 'tag', idField: 'tagId' }] })
    expect(problems).toEqual([expect.stringContaining('already written by connection "post-category"')])
  })

  it('rejects idField === targetField', () => {
    const c = base.connections[0]!
    expect(problemsOf({ ...base, connections: [{ ...c, targetField: 'categoryId' }] })).toContainEqual(
      expect.stringContaining('`idField` and `targetField` must be different'),
    )
  })

  it('rejects a targetField that is another connection idField on the same target', () => {
    const c = base.connections[0]!
    const problems = problemsOf({
      ...base,
      connections: [c, { ...c, name: 'x', source: 'tag', idField: 'category', targetField: 'tag' }],
    })
    expect(problems).toEqual([expect.stringContaining('used as an `idField`')])
  })

  it('rejects subcollections', () => {
    const c = base.connections[0]!
    expect(problemsOf({ ...base, connections: [{ ...c, source: 'shop/x/category' }] })).toContainEqual(
      expect.stringContaining('top-level collection'),
    )
  })

  it('rejects field path syntax in field names', () => {
    const c = base.connections[0]!
    expect(problemsOf({ ...base, connections: [{ ...c, idField: 'meta.categoryId' }] })).toContainEqual(
      expect.stringContaining('`idField` must be a top-level field name'),
    )
    expect(problemsOf({ ...base, connections: [{ ...c, fields: ['name', 'a.b'] }] })).toContainEqual(
      expect.stringContaining('`fields` must be top-level field names'),
    )
  })

  it('rejects cycles', () => {
    const c = base.connections[0]!
    const problems = problemsOf({
      ...base,
      connections: [
        c,
        { ...c, name: 'a', source: 'post', target: 'thread', idField: 'postId', targetField: 'post' },
        { ...c, name: 'b', source: 'thread', target: 'category', idField: 'threadId', targetField: 'thread' },
      ],
    })
    expect(problems).toEqual([expect.stringMatching(/circular dependency.*category -> post -> thread -> category/)])
  })

  it('allows chains without cycles', () => {
    const c = base.connections[0]!
    expect(() =>
      validateConfig({
        ...base,
        connections: [c, { ...c, name: 'a', source: 'post', target: 'thread', idField: 'postId', targetField: 'post' }],
      }),
    ).not.toThrow()
  })

  it('rejects colliding trigger names', () => {
    const c = base.connections[0]!
    const problems = problemsOf({
      ...base,
      connections: [c, { ...c, name: 'x', source: 'user_room', target: 'user-room', idField: 'roomId', targetField: 'room' }],
    })
    expect(problems).toEqual([expect.stringContaining('both map to trigger "doc-sync-user-room"')])
  })

  it('reports several problems at once', () => {
    const problems = problemsOf({ ...base, region: '', connections: [] })
    expect(problems.length).toBeGreaterThanOrEqual(2)
  })
})

describe('collectionsOf / triggerName', () => {
  it('lists sorted unique collections', () => {
    const c = base.connections[0]!
    expect(collectionsOf({ connections: [c, { ...c, name: 'x', source: 'area', target: 'category' }] })).toEqual([
      'area',
      'category',
      'post',
    ])
  })
  it('replaces underscores', () => {
    expect(triggerName('doc-sync', 'user_room')).toBe('doc-sync-user-room')
  })
})
