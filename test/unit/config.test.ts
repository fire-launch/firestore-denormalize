import { describe, expect, it } from 'vitest'
import {
  collectionGroupQueries,
  collectionsOf,
  ConfigError,
  defineAggregate,
  defineConfig,
  defineConnection,
  defineView,
  needsCollectionGroupQuery,
  rulesOf,
  triggerName,
  validateConfig,
  writeTriggers,
  type Connection,
  type ViewRule,
} from '../../src/index.js'

const base = defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  rules: [
    defineConnection({
      name: 'post-category',
      source: 'category',
      target: 'post',
      idField: 'categoryId',
      fields: ['name', 'color'],
      targetField: 'category',
      onSourceDelete: 'setNull',
    }),
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

  it('requires serviceRegion for a multi-region database and a valid service name', () => {
    expect(problemsOf({ ...base, region: 'nam5' })).toContainEqual(expect.stringContaining('`serviceRegion` is required when `region` is a multi-region'))
    expect(() => validateConfig({ ...base, region: 'nam5', serviceRegion: 'us-central1' })).not.toThrow()
    expect(problemsOf({ ...base, service: 'Doc Sync' })).toContainEqual(expect.stringContaining('`service` must be a Cloud Run service name'))
  })

  it('rejects a bad instance name', () => {
    expect(problemsOf({ ...base, name: 'Doc_Sync' })).toContainEqual(expect.stringContaining('`name` must match'))
  })

  it('rejects duplicate connection names', () => {
    const c = base.rules[0] as Connection
    const problems = problemsOf({ ...base, rules: [c, { ...c, target: 'comment' }] })
    expect(problems).toEqual([expect.stringContaining('duplicate name')])
  })

  it('rejects the same (target, targetField) twice', () => {
    const c = base.rules[0] as Connection
    const problems = problemsOf({ ...base, rules: [c, { ...c, name: 'other', source: 'tag', idField: 'tagId' }] })
    expect(problems).toEqual([expect.stringContaining('overlaps "category" written by connection "post-category"')])
  })

  it('rejects idField === targetField', () => {
    const c = base.rules[0] as Connection
    expect(problemsOf({ ...base, rules: [{ ...c, targetField: 'categoryId' }] })).toContainEqual(
      expect.stringContaining('`idField` and `targetField` must not overlap'),
    )
  })

  it('rejects a targetField that is another connection idField on the same target', () => {
    const c = base.rules[0] as Connection
    const problems = problemsOf({
      ...base,
      rules: [c, { ...c, name: 'x', source: 'tag', idField: 'category', targetField: 'tag' }],
    })
    expect(problems).toEqual([expect.stringContaining('used as an `idField`')])
  })

  it('rejects subcollections', () => {
    const c = base.rules[0] as Connection
    expect(problemsOf({ ...base, rules: [{ ...c, source: 'shop/category' }] })).toContainEqual(
      expect.stringContaining('not a collection path'),
    )
  })

  it('accepts dotted field paths but rejects reserved characters and overlaps', () => {
    const c = base.rules[0] as Connection
    expect(() => validateConfig({ ...base, rules: [{ ...c, idField: 'meta.categoryId', fields: ['name', 'address.city'] }] })).not.toThrow()
    expect(problemsOf({ ...base, rules: [{ ...c, idField: 'meta.*' }] })).toContainEqual(expect.stringContaining('`idField` must be a field path'))
    expect(problemsOf({ ...base, rules: [{ ...c, fields: ['name', 'a..b'] }] })).toContainEqual(expect.stringContaining('not a valid field path'))
    expect(problemsOf({ ...base, rules: [{ ...c, fields: ['address', 'address.city'] }] })).toContainEqual(expect.stringContaining('already covered'))
    expect(problemsOf({ ...base, rules: [{ ...c, idField: 'category.id' }] })).toContainEqual(expect.stringContaining('must not overlap'))
  })

  it('validates collection patterns', () => {
    const c = base.rules[0] as Connection
    expect(() => validateConfig({ ...base, rules: [{ ...c, source: 'users/{uid}/categories', target: 'users/{uid}/posts' }] })).not.toThrow()
    expect(() => validateConfig({ ...base, rules: [{ ...c, target: 'users/{uid}/posts' }] })).not.toThrow()
    expect(problemsOf({ ...base, rules: [{ ...c, source: 'users/{uid}/categories' }] })).toContainEqual(
      expect.stringContaining('{uid} of `source` must also appear in `target`'),
    )
    expect(problemsOf({ ...base, rules: [{ ...c, source: 'users/{uid}' }] })).toContainEqual(expect.stringContaining('not a collection path'))
    expect(problemsOf({ ...base, rules: [{ ...c, source: 'users/uid}/x' }] })).toContainEqual(expect.stringContaining('not a valid placeholder'))
    expect(problemsOf({ ...base, rules: [{ ...c, source: 'users/{a}/x/{a}/y' }] })).toContainEqual(expect.stringContaining('appears twice'))
  })

  it('validates aggregates', () => {
    const agg = defineAggregate({ name: 'post-likes', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count' as const, targetField: 'likeCount' })
    expect(() => validateConfig({ ...base, rules: [agg] })).not.toThrow()
    expect(() => validateConfig({ ...base, rules: [{ ...agg, source: 'like', idParam: undefined, idField: 'postId', aggregate: { sum: 'weight' } }] })).not.toThrow()
    expect(problemsOf({ ...base, rules: [{ ...agg, idField: 'postId' }] })).toContainEqual(expect.stringContaining('exactly one of'))
    expect(problemsOf({ ...base, rules: [{ ...agg, idParam: 'nope' }] })).toContainEqual(expect.stringContaining('not a placeholder of `source`'))
    expect(problemsOf({ ...base, rules: [{ ...agg, aggregate: 'avg' as never }] })).toContainEqual(expect.stringContaining("'count' or { sum"))
    expect(problemsOf({ ...base, rules: [{ ...agg, target: 'users/{uid}/post' }] })).toContainEqual(
      expect.stringContaining('{uid} of `target` must also appear in `source`'),
    )
    const c = base.rules[0] as Connection
    expect(problemsOf({ ...base, rules: [{ ...c, targetField: 'likeCount' }, agg] })).toContainEqual(
      expect.stringContaining('overlaps "likeCount"'),
    )
  })

  it('rejects loops where each write triggers the next rule', () => {
    const c = base.rules[0] as Connection
    const problems = problemsOf({
      ...base,
      rules: [
        { ...c, fields: ['name', 'thread'] },
        { ...c, name: 'a', source: 'post', target: 'thread', idField: 'postId', targetField: 'post', fields: ['category'] },
        { ...c, name: 'b', source: 'thread', target: 'category', idField: 'threadId', targetField: 'thread', fields: ['post'] },
      ],
    })
    expect(problems).toEqual([expect.stringMatching(/form a loop.*post-category -> a -> b -> post-category/)])
  })

  it('allows collection cycles whose writes do not feed the next rule', () => {
    // thread -> message.thread and message -> thread.lastMessage: neither watches the other's written field
    const c = base.rules[0] as Connection
    expect(() =>
      validateConfig({
        ...base,
        rules: [
          { ...c, name: 'message-thread', source: 'thread', target: 'message', idField: 'threadId', fields: ['title'], targetField: 'thread' },
          { ...c, name: 'thread-last', source: 'message', target: 'thread', idField: 'threadId', fields: ['text'], targetField: 'lastMessage' },
        ],
      }),
    ).not.toThrow()
  })

  it('rejects a count whose write feeds a copy that feeds the count', () => {
    const c = base.rules[0] as Connection
    const problems = problemsOf({
      ...base,
      rules: [
        { ...c, name: 'like-post', source: 'post', target: 'like', idField: 'postId', fields: ['likeCount'], targetField: 'weight' },
        defineAggregate({ name: 'post-likes', source: 'like', target: 'post', idField: 'postId', aggregate: { sum: 'weight' }, targetField: 'likeCount' }),
      ],
    })
    expect(problems).toEqual([expect.stringContaining('form a loop')])
  })

  it('allows chains without cycles', () => {
    const c = base.rules[0] as Connection
    expect(() =>
      validateConfig({
        ...base,
        rules: [c, { ...c, name: 'a', source: 'post', target: 'thread', idField: 'postId', targetField: 'post' }],
      }),
    ).not.toThrow()
  })

  it('lower-cases camelCase collection ids in trigger names', () => {
    const c = base.rules[0] as Connection
    const r = validateConfig({ ...base, rules: [{ ...c, source: 'chatRooms', target: 'users/{uid}/userPosts', idField: 'roomId', targetField: 'room' }] })
    expect(collectionsOf(r).map((p) => triggerName('doc-sync', p))).toEqual(['doc-sync-chatrooms', 'doc-sync-users-userposts'])
    // a trigger name may not end with a hyphen
    expect(problemsOf({ ...base, rules: [{ ...c, source: 'category_' }] })).toContainEqual(expect.stringContaining('trigger name "doc-sync-category-"'))
  })

  it('rejects patterns that can match the same documents', () => {
    const c = base.rules[0] as Connection
    const problems = problemsOf({
      ...base,
      rules: [c, { ...c, name: 'x', source: 'category', target: 'users/admin/posts', idField: 'categoryId' }, { ...c, name: 'y', source: 'category', target: 'users/{uid}/posts', idField: 'categoryId' }],
    })
    expect(problems).toEqual([expect.stringContaining('"users/admin/posts" and "users/{uid}/posts" can match the same documents')])
  })

  it('rejects reserved ids and field names', () => {
    const c = base.rules[0] as Connection
    expect(problemsOf({ ...base, rules: [{ ...c, source: '__meta__' }] })).toContainEqual(expect.stringContaining('not a valid collection ID'))
    expect(problemsOf({ ...base, rules: [{ ...c, target: 'users/../posts' }] })).toContainEqual(expect.stringContaining('not a valid document ID'))
    expect(problemsOf({ ...base, rules: [{ ...c, fields: ['__name__'] }] })).toContainEqual(expect.stringContaining('not a valid field path'))
  })

  it('rejects an idField aggregate whose collection group would count documents of other target parents', () => {
    const agg = defineAggregate({ name: 'post-likes', source: 'shops/{shopId}/users/{uid}/likes', target: 'shops/{shopId}/posts', idField: 'postId', aggregate: 'count' as const, targetField: 'likeCount' })
    expect(problemsOf({ ...base, rules: [agg] })).toContainEqual(expect.stringContaining('{uid} that `target` lacks'))
    // without placeholders on the target, the collection group is unambiguous
    expect(() => validateConfig({ ...base, rules: [{ ...agg, source: 'users/{uid}/likes', target: 'post' }] })).not.toThrow()
  })

  it('rejects colliding trigger names', () => {
    const c = base.rules[0] as Connection
    const problems = problemsOf({
      ...base,
      rules: [c, { ...c, name: 'x', source: 'user_room', target: 'user-room', idField: 'roomId', targetField: 'room' }],
    })
    expect(problems).toEqual([expect.stringContaining('both map to trigger "doc-sync-user-room"')])
  })

  describe('views', () => {
    const view: ViewRule = defineView({
      name: 'post-latest-comments',
      target: 'post',
      targetFields: ['latestComments'],
      sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId', orderBy: [['createdAt', 'desc']], limit: 3 } },
      build: ({ sources }) => ({ latestComments: sources.comments!.map((c) => c.id) }),
    })
    const only = (v: Partial<ViewRule>) => ({ ...base, rules: [{ ...view, ...v }] })

    it('resolves sources, patterns and ordering', () => {
      const r = validateConfig({
        ...base,
        rules: [
          ...base.rules,
          {
            ...view,
            sources: {
              comments: view.sources!.comments!,
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

    it('requires name, target, non-empty targetFields, a non-empty sources map and a build function', () => {
      expect(problemsOf(only({ name: '' }))).toContainEqual(expect.stringContaining('`name` is required'))
      expect(problemsOf(only({ target: '' }))).toContainEqual(expect.stringContaining('`target` is required'))
      expect(problemsOf(only({ targetFields: [] }))).toContainEqual(expect.stringContaining('`targetFields` must be a non-empty array'))
      expect(problemsOf(only({ targetFields: 'latest' as never }))).toContainEqual(expect.stringContaining('`targetFields` must be a non-empty array'))
      expect(problemsOf(only({ targetFields: ['a/b'] }))).toContainEqual(expect.stringContaining('`targetFields` entry "a/b" is not a valid field path'))
      expect(problemsOf(only({ targetFields: ['stats', 'stats.count'] }))).toContainEqual(expect.stringContaining('`targetFields` "stats" and "stats.count" overlap'))
      expect(problemsOf(only({ sources: {} }))).toContainEqual(expect.stringContaining('`sources` must have at least one entry'))
      expect(problemsOf(only({ sources: [] as never }))).toContainEqual(expect.stringContaining('`sources` must be an object'))
      expect(problemsOf(only({ build: undefined as never }))).toContainEqual(expect.stringContaining('`build` must be a function'))
      expect(problemsOf(only({ patch: 'x' as never }))).toContainEqual(expect.stringContaining('`patch` must be a function'))
    })

    it('resolves targetFields and keeps every path apart from other rules and refFields', () => {
      const r = validateConfig(only({ targetFields: ['latestComments', 'stats.commentCount'] }))
      expect(r.views[0]).toMatchObject({ targetFields: ['latestComments', 'stats.commentCount'], rest: false, reservedRootKeys: [] })
      // `only` drops the other rules, so put the base config's connection (writes post.category, idField categoryId) back
      expect(problemsOf({ ...base, rules: [...base.rules, { ...view, targetFields: ['category.name'] }] })).toContainEqual(
        expect.stringContaining('overlaps "category" written by connection "post-category"'),
      )
      expect(problemsOf({ ...base, rules: [...base.rules, { ...view, targetFields: ['categoryId'] }] })).toContainEqual(expect.stringContaining('is used as an `idField` by another rule'))
      expect(
        problemsOf(only({ targetFields: ['authorId'], sources: { author: { collection: 'user', refField: 'authorId' } } })),
      ).toContainEqual(expect.stringContaining('`refField` "authorId" and `targetFields` must not overlap'))
    })

    it('rejects a view name shared with a connection or aggregate', () => {
      expect(problemsOf({ ...base, rules: [...base.rules, { ...view, name: 'post-category' }] })).toContainEqual(expect.stringContaining('duplicate name'))
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

    it('rejects a connection writing a field a view uses as refField', () => {
      const conn = defineConnection({ name: 'post-author-id', source: 'user', target: 'post', idField: 'userId', fields: ['name'], targetField: 'authorId', onSourceDelete: 'setNull' })
      const withRef = { ...view, sources: { ...view.sources, author: { collection: 'user', refField: 'authorId' } } }
      expect(problemsOf({ ...base, rules: [conn, withRef] })).toContainEqual(expect.stringContaining('is used as an `idField` by another rule'))
    })

    it('accepts base with the same placeholders and rejects mismatches', () => {
      const r = validateConfig(only({ base: 'draft', sources: undefined, targetFields: ['title'], build: ({ base }) => ({ title: base!.get('title') }) }))
      expect(r.views[0]).toMatchObject({ base: 'draft', basePattern: expect.objectContaining({ key: 'draft' }), sources: [] })
      expect(problemsOf(only({ base: 'post' }))).toContainEqual(expect.stringContaining('`base` and `target` must be different collections'))
      expect(problemsOf(only({ base: 'shop/{shopId}/draft' }))).toContainEqual(expect.stringContaining('`base` must have the same placeholders as `target`'))
      expect(problemsOf(only({ sources: undefined }))).toContainEqual(expect.stringContaining('`sources` must have at least one entry (or set `base`)'))
      expect(problemsOf(only({ targetFields: ['latestComments', 'rest'] }))).toContainEqual(expect.stringContaining("'rest' in `targetFields` requires `base`"))
      expect(problemsOf(only({ base: 'draft', targetFields: ['rest', 'rest'] }))).toContainEqual(expect.stringContaining("'rest' may appear once"))
      expect(problemsOf(only({ sources: { base: { collection: 'draft', refField: 'draftId' } } }))).toContainEqual(expect.stringContaining('source key "base" is reserved'))
    })

    it('requires every base view of a target to agree on the base', () => {
      const other = { ...view, name: 'post-other', targetFields: ['other'], base: 'archive' }
      expect(problemsOf({ ...base, rules: [{ ...view, base: 'draft' }, other] })).toContainEqual(
        expect.stringContaining('`base` "archive" differs from "draft" declared by view "post-latest-comments"'),
      )
    })

    it('lists the base collection for triggers and treats a base view as watching every base field', () => {
      expect(collectionsOf(validateConfig(only({ base: 'draft' }))).map((p) => p.raw)).toContain('draft')
      const watcher = defineView({ name: 'post-public', target: 'postPublic', base: 'post', targetFields: ['title'], build: ({ base }) => ({ title: base!.get('title') }) })
      expect(writeTriggers(validateConfig({ ...base, rules: [view, watcher] }))).toContainEqual({ from: 'post-latest-comments', field: 'post.latestComments', to: 'post-public' })
    })

    it('treats a view without `watch` as watching every field in loop detection', () => {
      const c = base.rules[0] as Connection
      // post-category writes post.category; the view reads post (any field) and writes category.summary, which post-category copies
      const problems = problemsOf({
        ...base,
        rules: [
          { ...c, fields: ['summary'] },
          { ...view, name: 'category-summary', target: 'category', targetFields: ['summary'], sources: { posts: { collection: 'post', idField: 'categoryId' } } },
        ],
      })
      expect(problems).toEqual([expect.stringMatching(/form a loop.*post-category -> category-summary -> post-category/)])
      // with `watch` restricted to a field post-category does not write, there is no loop
      expect(() =>
        validateConfig({
          ...base,
          rules: [
            { ...c, fields: ['summary'] },
            { ...view, name: 'category-summary', target: 'category', targetFields: ['summary'], sources: { posts: { collection: 'post', idField: 'categoryId', watch: ['title'] } } },
          ],
        }),
      ).not.toThrow()
    })

    it('accepts a config with only views', () => {
      expect(() => validateConfig({ ...base, rules: [view] })).not.toThrow()
    })

    it('reports collection-group queries per source', () => {
      const r = validateConfig({
        ...base,
        rules: [
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
        rules: [{ ...view, target: 'post', sources: { c: { collection: 'users/{uid}/comment', idField: 'postId' }, a: { collection: 'user', refField: 'authorId' } } }],
      })
      expect(collectionGroupQueries(r2.views[0]!)).toEqual([{ collection: 'users/{uid}/comment', field: 'postId' }])
      const r3 = validateConfig({
        ...base,
        rules: [{ ...view, target: 'users/{uid}/post', sources: { a: { collection: 'user', refField: 'authorId' } } }],
      })
      expect(collectionGroupQueries(r3.views[0]!)).toEqual([{ collection: 'users/{uid}/post', field: 'authorId' }])
    })

    it('defineView types build from the sources keys', () => {
      const v = defineView({
        name: 'x',
        target: 'post',
        targetFields: ['x'],
        sources: { comments: { collection: 'comment', idField: 'postId' } },
        build: ({ sources }) => ({ x: sources.comments.length }),
        patch: (current, change) => (change.after ? { x: ((current.x as number | undefined) ?? 0) + 1 } : undefined),
      })
      expect(() => validateConfig({ ...base, rules: [...base.rules, v] })).not.toThrow()
    })
  })

  it('reports several problems at once', () => {
    const problems = problemsOf({ ...base, region: '', rules: [] })
    expect(problems.length).toBeGreaterThanOrEqual(2)
  })

  it('requires rules with a kind', () => {
    expect(problemsOf({ ...base, rules: [] })).toContainEqual(expect.stringContaining('`rules` must have at least one entry'))
    expect(problemsOf({ ...base, rules: [{ name: 'x' } as never] })).toContainEqual(expect.stringContaining('rules[0]: `kind` must be'))
    expect(problemsOf({ ...base, rules: [{ kind: 'connection', source: 'a', target: 'b' } as never] })).toContainEqual(
      expect.stringContaining('rules[0]: `name` is required'),
    )
  })

  it('accepts plain objects with a kind and groups rules by kind in config order', () => {
    const agg = defineAggregate({ name: 'post-likes', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count' as const, targetField: 'likeCount' })
    const conn = {
      kind: 'connection' as const,
      name: 'post-category',
      source: 'category',
      target: 'post',
      idField: 'categoryId',
      fields: ['name', 'color'],
      targetField: 'category',
      onSourceDelete: 'setNull' as const,
    }
    const view = defineView({
      name: 'post-latest-comments',
      target: 'post',
      targetFields: ['latestComments'],
      sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
      build: () => ({ latestComments: [] as string[] }),
    })
    const resolved = validateConfig({ ...base, rules: [agg, conn, view] })
    expect(resolved.connections).toHaveLength(1)
    expect(resolved.aggregates).toHaveLength(1)
    expect(resolved.views).toHaveLength(1)
    expect(rulesOf(resolved).map((r) => r.name)).toEqual(['post-category', 'post-likes', 'post-latest-comments'])
  })
})

describe('collectionsOf / triggerName', () => {
  it('lists sorted unique collections, ignoring placeholder names', () => {
    const c = base.rules[0] as Connection
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
      rules: [defineView({ name: 'v', target: 'post', targetFields: ['v'], sources: { a: { collection: 'user', refField: 'authorId' } }, build: () => ({ v: 1 }) })],
    })
    expect(collectionsOf(resolved).map((p) => p.raw)).toEqual(['post', 'user'])
  })
  it('replaces underscores and joins subcollection ids', () => {
    expect(triggerName('doc-sync', 'user_room')).toBe('doc-sync-user-room')
    expect(triggerName('doc-sync', 'users/{uid}/payments')).toBe('doc-sync-users-payments')
  })
})
