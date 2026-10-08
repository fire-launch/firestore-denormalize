import { describe, expect, it } from 'vitest'
import { collectionGroupQueries, collectionsOf, ConfigError, defineConfig, defineView, needsCollectionGroupQuery, triggerName, validateConfig, type ViewRule } from '../../src/index.js'

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

  describe('views', () => {
    const view: ViewRule = {
      name: 'post-latest-comments',
      target: 'post',
      targetField: 'latestComments',
      sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId', orderBy: [['createdAt', 'desc']], limit: 3 } },
      build: ({ sources }) => sources.comments!.map((c) => c.id),
    }
    const only = (v: Partial<ViewRule>) => ({ ...base, connections: [], views: [{ ...view, ...v }] })

    it('resolves sources, patterns and ordering', () => {
      const r = validateConfig({
        ...base,
        views: [
          {
            ...view,
            sources: {
              comments: view.sources.comments!,
              author: { collection: 'user', refField: 'authorId' },
              tags: { collection: 'tag', idField: 'postId', orderBy: ['label'], watch: ['label'] },
            },
          },
        ],
      })
      expect(r.views).toHaveLength(1)
      const v = r.views[0]!
      expect(v.kind).toBe('view')
      expect(v.targetPattern.raw).toBe('post')
      expect(v.sources.map((s) => s.key)).toEqual(['comments', 'author', 'tags'])
      expect(v.sources[0]).toMatchObject({ idParam: 'postId', limit: 3, orderBy: [{ field: 'createdAt', direction: 'desc' }], watch: undefined })
      expect(v.sources[0]!.pattern.params).toEqual(['postId'])
      expect(v.sources[1]).toMatchObject({ refField: 'authorId', orderBy: [] })
      // `watch` always includes idField and the orderBy fields: they decide membership and order
      expect(v.sources[2]).toMatchObject({ idField: 'postId', orderBy: [{ field: 'label', direction: 'asc' }], watch: ['label', 'postId'] })
      const r2 = validateConfig(only({ sources: { c: { collection: 'comment', idField: 'postId', orderBy: [['createdAt', 'desc']], watch: ['body', 'postId'] } } }))
      expect(r2.views[0]!.sources[0]!.watch).toEqual(['body', 'postId', 'createdAt'])
      expect(typeof v.build).toBe('function')
      expect(v.patch).toBeUndefined()
      expect(r.resolved).toBe(true)
    })

    it('requires name, target, targetField, a non-empty sources map and a build function', () => {
      expect(problemsOf(only({ name: '' }))).toContainEqual(expect.stringContaining('`name` is required'))
      expect(problemsOf(only({ target: '' }))).toContainEqual(expect.stringContaining('`target` is required'))
      expect(problemsOf(only({ targetField: 'a/b' }))).toContainEqual(expect.stringContaining('`targetField` must be a field path'))
      expect(problemsOf(only({ sources: {} }))).toContainEqual(expect.stringContaining('`sources` must have at least one entry'))
      expect(problemsOf(only({ sources: [] as never }))).toContainEqual(expect.stringContaining('`sources` must be an object'))
      expect(problemsOf(only({ build: undefined as never }))).toContainEqual(expect.stringContaining('`build` must be a function'))
      expect(problemsOf(only({ patch: 'x' as never }))).toContainEqual(expect.stringContaining('`patch` must be a function'))
    })

    it('rejects a view name shared with a connection or aggregate', () => {
      expect(problemsOf({ ...base, views: [{ ...view, name: 'post-category' }] })).toContainEqual(expect.stringContaining('duplicate name'))
    })

    it('requires exactly one of idField, idParam, refField per source', () => {
      const src = (s: object) => only({ sources: { s: { collection: 'post/{postId}/comment', ...s } as never } })
      expect(problemsOf(src({}))).toContainEqual(expect.stringContaining('source "s": exactly one of `idField`, `idParam` or `refField`'))
      expect(problemsOf(src({ idParam: 'postId', idField: 'postId' }))).toContainEqual(expect.stringContaining('exactly one of'))
      expect(problemsOf(src({ idParam: 'nope' }))).toContainEqual(expect.stringContaining('{nope} is not a placeholder of `collection`'))
      expect(problemsOf(src({ idField: 'a/b' }))).toContainEqual(expect.stringContaining('`idField` must be a field path'))
      expect(problemsOf(src({ idParam: 'postId', collection: '' }))).toContainEqual(expect.stringContaining('`collection` is required'))
      expect(problemsOf(src({ idParam: 'postId', collection: 'post/{postId}' }))).toContainEqual(expect.stringContaining('not a collection path'))
    })

    it('validates orderBy, limit and watch', () => {
      const src = (s: object) => only({ sources: { s: { collection: 'comment', idField: 'postId', ...s } as never } })
      expect(problemsOf(src({ orderBy: 'createdAt' }))).toContainEqual(expect.stringContaining('`orderBy` must be an array'))
      expect(problemsOf(src({ orderBy: [['createdAt', 'down']] }))).toContainEqual(expect.stringContaining("'asc' | 'desc'"))
      expect(problemsOf(src({ orderBy: ['a/b'] }))).toContainEqual(expect.stringContaining('`orderBy` entry "a/b" is not a valid field path'))
      expect(problemsOf(src({ limit: 0 }))).toContainEqual(expect.stringContaining('`limit` must be a positive integer'))
      expect(problemsOf(src({ limit: 2.5 }))).toContainEqual(expect.stringContaining('`limit` must be a positive integer'))
      expect(problemsOf(src({ watch: [] }))).toContainEqual(expect.stringContaining('`watch` must be a non-empty array of field paths'))
      expect(problemsOf(src({ watch: ['a/b'] }))).toContainEqual(expect.stringContaining('`watch` must be a non-empty array of field paths'))
      const ref = (s: object) => only({ sources: { s: { collection: 'user', refField: 'authorId', ...s } as never } })
      expect(problemsOf(ref({ orderBy: ['name'] }))).toContainEqual(expect.stringContaining('`orderBy` does not apply to a `refField` source'))
      expect(problemsOf(ref({ limit: 1 }))).toContainEqual(expect.stringContaining('`limit` does not apply to a `refField` source'))
    })

    it('checks placeholders between target and sources', () => {
      // idParam: the param holds the target id, so it must not be in `target`; the other source params must be in `target`
      expect(problemsOf(only({ target: 'post/{postId}/meta' }))).toContainEqual(expect.stringContaining('{postId} must not appear in `target`'))
      expect(
        problemsOf(only({ sources: { c: { collection: 'users/{uid}/post/{postId}/comment', idParam: 'postId' } } })),
      ).toContainEqual(expect.stringContaining('{uid} of source "c" must appear in `target`'))
      expect(
        problemsOf(only({ target: 'users/{uid}/feed', sources: { c: { collection: 'post/{postId}/comment', idParam: 'postId' } } })),
      ).toContainEqual(expect.stringContaining('{uid} of `target` must also appear in source "c"'))
      // idField: every target placeholder must be bound by the source path
      expect(
        problemsOf(only({ target: 'users/{uid}/post', sources: { c: { collection: 'comment', idField: 'postId' } } })),
      ).toContainEqual(expect.stringContaining('{uid} of `target` must also appear in source "c"'))
      // refField: every source placeholder must be bound by the target path
      expect(
        problemsOf(only({ sources: { a: { collection: 'users/{uid}/profile', refField: 'authorId' } } })),
      ).toContainEqual(expect.stringContaining('{uid} of source "a" must also appear in `target`'))
      // source and target must differ
      expect(problemsOf(only({ sources: { p: { collection: 'post', idField: 'parentId' } } }))).toContainEqual(
        expect.stringContaining('source "p" and `target` must be different collections'),
      )
    })

    it('keeps targetField apart from other rules and from refFields', () => {
      const c = base.connections![0]!
      expect(problemsOf({ ...base, views: [{ ...view, targetField: 'category' }] })).toContainEqual(expect.stringContaining('overlaps "category"'))
      expect(problemsOf({ ...base, views: [{ ...view, targetField: 'categoryId' }] })).toContainEqual(expect.stringContaining('used as an `idField`'))
      expect(
        problemsOf({
          ...base,
          connections: [{ ...c, targetField: 'authorId' }],
          views: [{ ...view, sources: { author: { collection: 'user', refField: 'authorId' } } }],
        }),
      ).toContainEqual(expect.stringContaining('used as an `idField`'))
      expect(
        problemsOf(only({ sources: { author: { collection: 'user', refField: 'latestComments' } } })),
      ).toContainEqual(expect.stringContaining('`refField` "latestComments" and `targetField` must not overlap'))
    })

    it('treats a view without `watch` as watching every field in loop detection', () => {
      const c = base.connections![0]!
      // post-category writes post.category; the view reads post (any field) and writes category.summary, which post-category copies
      const problems = problemsOf({
        ...base,
        connections: [{ ...c, fields: ['summary'] }],
        views: [{ ...view, name: 'category-summary', target: 'category', targetField: 'summary', sources: { posts: { collection: 'post', idField: 'categoryId' } } }],
      })
      expect(problems).toEqual([expect.stringMatching(/form a loop.*post-category -> category-summary -> post-category/)])
      // with `watch` restricted to a field post-category does not write, there is no loop
      expect(() =>
        validateConfig({
          ...base,
          connections: [{ ...c, fields: ['summary'] }],
          views: [
            { ...view, name: 'category-summary', target: 'category', targetField: 'summary', sources: { posts: { collection: 'post', idField: 'categoryId', watch: ['title'] } } },
          ],
        }),
      ).not.toThrow()
    })

    it('accepts a config with only views', () => {
      expect(() => validateConfig({ ...base, connections: undefined, views: [view] })).not.toThrow()
    })

    it('reports collection-group queries per source', () => {
      const r = validateConfig({
        ...base,
        connections: [],
        views: [
          {
            ...view,
            target: 'users/{uid}/post',
            sources: {
              comments: { collection: 'users/{uid}/post/{postId}/comment', idParam: 'postId' },
              likes: { collection: 'users/{uid}/like', idField: 'postId' },
              author: { collection: 'users/{uid}/profile', refField: 'authorId' },
            },
          },
        ],
      })
      expect(needsCollectionGroupQuery(r.views[0]!)).toBe(false)
      const r2 = validateConfig({
        ...base,
        connections: [],
        views: [{ ...view, target: 'post', sources: { c: { collection: 'users/{uid}/comment', idField: 'postId' }, a: { collection: 'user', refField: 'authorId' } } }],
      })
      expect(collectionGroupQueries(r2.views[0]!)).toEqual([{ collection: 'users/{uid}/comment', field: 'postId' }])
      const r3 = validateConfig({
        ...base,
        connections: [],
        views: [{ ...view, target: 'users/{uid}/post', sources: { a: { collection: 'user', refField: 'authorId' } } }],
      })
      expect(collectionGroupQueries(r3.views[0]!)).toEqual([{ collection: 'users/{uid}/post', field: 'authorId' }])
    })

    it('defineView types build from the sources keys', () => {
      const v = defineView({
        name: 'x',
        target: 'post',
        targetField: 'x',
        sources: { comments: { collection: 'comment', idField: 'postId' } },
        build: ({ sources }) => sources.comments.length,
        patch: (current, change) => (change.after ? (current ?? 0) + 1 : undefined),
      })
      expect(() => validateConfig({ ...base, views: [v] })).not.toThrow()
    })
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
  it('includes view targets and sources', () => {
    const list = collectionsOf({
      views: [{ target: 'post', sources: { c: { collection: 'post/{postId}/comment' }, a: { collection: 'user' } } }],
    })
    expect(list.map((p) => p.raw)).toEqual(['post', 'post/{postId}/comment', 'user'])
    const resolved = validateConfig({
      ...base,
      connections: [],
      views: [{ name: 'v', target: 'post', targetField: 'v', sources: { a: { collection: 'user', refField: 'authorId' } }, build: () => 1 }],
    })
    expect(collectionsOf(resolved).map((p) => p.raw)).toEqual(['post', 'user'])
  })
  it('replaces underscores and joins subcollection ids', () => {
    expect(triggerName('doc-sync', 'user_room')).toBe('doc-sync-user-room')
    expect(triggerName('doc-sync', 'users/{uid}/payments')).toBe('doc-sync-users-payments')
  })
})
