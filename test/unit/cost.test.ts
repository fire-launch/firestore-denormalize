import { describe, expect, it } from 'vitest'
import { defineAggregate, defineConfig, defineConnection, defineView, validateConfig, writeTriggers, type Connection } from '../../src/index.js'
import { cronRunsPerDay, estimateCost, formatChains } from '../../src/cost.js'

const base = defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  rules: [
    defineConnection({ name: 'post-category', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' }),
    defineConnection({ name: 'user-post-tag', source: 'users/{uid}/tags', target: 'users/{uid}/posts', idField: 'tagId', fields: ['label'], targetField: 'tag', onSourceDelete: 'nothing' }),
    defineAggregate({ name: 'post-likes', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count', targetField: 'likeCount' }),
    defineAggregate({ name: 'customer-total', source: 'order', target: 'customer', idField: 'customerId', aggregate: { sum: 'amount' }, targetField: 'total' }),
    defineView({
      name: 'post-summary',
      target: 'post',
      targetFields: ['summary'],
      sources: {
        comments: { collection: 'post/{postId}/comment', idParam: 'postId', orderBy: [['createdAt', 'desc']], limit: 2 },
        author: { collection: 'user', refField: 'authorId' },
        mentions: { collection: 'mention', idField: 'postId' },
      },
      build: () => ({ summary: 'x' }),
    }),
    defineView({
      name: 'user-badges',
      target: 'user',
      targetFields: ['badges'],
      sources: { badges: { collection: 'badge', idField: 'userId' } },
      build: () => ({ badges: {} }),
      patch: () => undefined,
    }),
  ],
})
const resolved = validateConfig(base)
const rule = (name: string) => [...resolved.connections, ...resolved.aggregates, ...resolved.views].find((r) => r.name === name)!

describe('estimateCost', () => {
  it('connection: fan-out on the source side, two reads on the target side', () => {
    expect(estimateCost(rule('post-category'))).toEqual({
      rule: 'post-category',
      kind: 'connection',
      lines: [
        { trigger: 'category/{id} changed', reads: 'N + 1', writes: '≤ N' },
        { trigger: 'post/{id} created or categoryId changed', reads: '2', writes: '≤ 1' },
      ],
      warnings: [],
    })
    expect(estimateCost(rule('user-post-tag')).lines.map((l) => l.trigger)).toEqual([
      'users/{uid}/tags/{id} changed',
      'users/{uid}/posts/{id} created or tagId changed',
    ])
  })

  it('aggregate: one target per path placeholder, up to two per id field', () => {
    expect(estimateCost(rule('post-likes'))).toEqual({
      rule: 'post-likes',
      kind: 'aggregate',
      lines: [
        { trigger: 'post/{postId}/like/{id} changed', reads: '1 + 1 aggregation', writes: '≤ 1' },
        { trigger: 'post/{id} created', reads: '1 + 1 aggregation', writes: '≤ 1' },
      ],
      warnings: [],
    })
    expect(estimateCost(rule('customer-total')).lines[0]).toEqual({ trigger: 'order/{id} changed', reads: '≤ 2 × (1 + 1 aggregation)', writes: '≤ 2' })
  })

  it('view: per-target cost from the declared sources, fan-out for refField sources', () => {
    const perTarget = '1 target + ≤ 2 comments + 1 author + M mentions (+ reads inside build)'
    expect(estimateCost(rule('post-summary'))).toEqual({
      rule: 'post-summary',
      kind: 'view',
      lines: [
        { trigger: 'post/{postId}/comment/{id} changed', reads: perTarget, writes: '≤ 1' },
        { trigger: 'user/{id} changed', reads: `N + N × (${perTarget})`, writes: '≤ N' },
        { trigger: 'mention/{id} changed', reads: `≤ 2 × (${perTarget})`, writes: '≤ 2' },
        { trigger: 'post/{id} created or authorId changed', reads: perTarget, writes: '≤ 1' },
      ],
      warnings: [
        'source "author" (refField) fans out: one change of a user document rebuilds every post that points at it',
        'source "mentions" has no limit and the view has no patch, so every event reads all mention documents of the target',
      ],
    })
  })

  it('view with patch: two reads on the fast path, build cost on fallback, no unbounded-query warning', () => {
    expect(estimateCost(rule('user-badges'))).toEqual({
      rule: 'user-badges',
      kind: 'view',
      lines: [
        { trigger: 'badge/{id} changed', reads: '≤ 2 × 2 (+ reads inside patch); if patch returns undefined: ≤ 2 × (1 target + M badges (+ reads inside build))', writes: '≤ 2' },
        { trigger: 'user/{id} created', reads: '1 target + M badges (+ reads inside build)', writes: '≤ 1' },
      ],
      warnings: [],
    })
  })

  it('adds the base read and a base trigger line for a view with base', () => {
    const cfg = validateConfig({
      ...base,
      rules: [
        defineView({
          name: 'post-public',
          target: 'postPublic',
          base: 'post',
          targetFields: ['title'],
          sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId', limit: 3 } },
          build: ({ base }) => ({ title: base!.get('title') }),
        }),
      ],
    })
    const cost = estimateCost(cfg.views[0]!)
    expect(cost.lines[0]).toEqual({ trigger: 'post/{id} changed', reads: '1 target + 1 base + ≤ 3 comments (+ reads inside build)', writes: '≤ 1 (create / update / remove the target)' })
    expect(cost.lines[1]).toEqual({ trigger: 'post/{postId}/comment/{id} changed', reads: '1 target + 1 base + ≤ 3 comments (+ reads inside build)', writes: '≤ 1' })
    expect(cost.lines[2]!.trigger).toBe('postPublic/{id} created or deleted')
  })

  it('estimates a scheduled rule per run instead of per event', () => {
    const cfg = validateConfig({ ...base, rules: [defineAggregate({ name: 'daily-likes', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count', targetField: 'likeCount', schedule: '0 3 * * *' })] })
    const cost = estimateCost(cfg.aggregates[0]!)
    expect(cost.lines).toEqual([{ trigger: 'schedule 0 3 * * * (Etc/UTC): every post', reads: 'T × (1 + 1 aggregation) per run, 1 run/day', writes: '≤ T per run' }])
    expect(cost.warnings).toEqual([])
  })

  it('warns when a schedule runs more than once an hour', () => {
    const cfg = validateConfig({ ...base, rules: [defineAggregate({ name: 'often', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count', targetField: 'likeCount', schedule: '* * * * *' })] })
    const cost = estimateCost(cfg.aggregates[0]!)
    expect(cost.lines).toEqual([{ trigger: 'schedule * * * * * (Etc/UTC): every post', reads: 'T × (1 + 1 aggregation) per run, 1440 runs/day', writes: '≤ T per run' }])
    expect(cost.warnings).toEqual([
      'schedule "* * * * *" runs 1440 times a day: every target is read 1440 times a day. Use a less frequent cron, or `defer` for event-driven batching.',
    ])
  })

  it('does not warn for a schedule that runs at most hourly', () => {
    const cfg = validateConfig({ ...base, rules: [defineAggregate({ name: 'twice-daily', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count', targetField: 'likeCount', schedule: '0 */2 * * *' })] })
    const cost = estimateCost(cfg.aggregates[0]!)
    expect(cost.warnings).toEqual([])
  })

  it('warns about a composite index for sum aggregates filtered by idField', () => {
    expect(estimateCost(rule('customer-total')).warnings).toEqual([
      'sum("amount") filtered by customerId needs a composite index on order (customerId, amount); rebuild stops with FAILED_PRECONDITION until it exists',
    ])
  })

  it('does not warn about a composite index for count aggregates with idField', () => {
    const cfg = validateConfig({ ...base, rules: [defineAggregate({ name: 'user-posts', source: 'post', target: 'user', idField: 'authorId', aggregate: 'count', targetField: 'postCount' })] })
    expect(estimateCost(cfg.aggregates[0]!).warnings).toEqual([])
  })

  it('does not warn about a composite index for sum aggregates with idParam', () => {
    const cfg = validateConfig({ ...base, rules: [defineAggregate({ name: 'post-total', source: 'post/{postId}/order', target: 'post', idParam: 'postId', aggregate: { sum: 'amount' }, targetField: 'total' })] })
    expect(estimateCost(cfg.aggregates[0]!).warnings).toEqual([])
  })

  it('a deferred connection: marks cost a task, flushes carry the recompute, a target\'s first value stays immediate', () => {
    const cfg = validateConfig({ ...base, rules: [defineConnection({ name: 'post-category', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull', defer: '10m' })] })
    const cost = estimateCost(cfg.connections[0]!)
    expect(cost.lines).toEqual([
      { trigger: 'category/{id} changed', reads: '0 (+ 1 task)', writes: '0' },
      { trigger: 'flush category/{id} (≤ 1 per 10m)', reads: 'N + 1', writes: '≤ N' },
      { trigger: 'post/{id} created', reads: '2', writes: '≤ 1' },
      { trigger: 'post/{id} categoryId changed', reads: '0 (+ 1 task)', writes: '0' },
      { trigger: 'flush post/{id} (≤ 1 per 10m)', reads: '2', writes: '≤ 1' },
    ])
  })

  it('a deferred aggregate marks up to two targets per source event; creates stay immediate', () => {
    const cfg = validateConfig({ ...base, rules: [defineAggregate({ name: 'user-posts', source: 'post', target: 'user', idField: 'authorId', aggregate: 'count', targetField: 'postCount', defer: '90s' })] })
    const cost = estimateCost(cfg.aggregates[0]!)
    expect(cost.lines).toEqual([
      { trigger: 'post/{id} changed', reads: '0 (+ ≤ 2 tasks)', writes: '0' },
      { trigger: 'user/{id} created', reads: '1 + 1 aggregation', writes: '≤ 1' },
      { trigger: 'flush user/{id} (≤ 1 per 90s)', reads: '1 + 1 aggregation', writes: '≤ 1' },
    ])
  })

  it('a deferred projection: base create/delete immediate, base update and sources marked', () => {
    const cfg = validateConfig({
      ...base,
      rules: [
        defineView({
          name: 'post-public',
          base: 'post',
          target: 'postPublic',
          targetFields: ['title', 'author'],
          sources: { author: { collection: 'user', refField: 'authorId' }, comments: { collection: 'post/{postId}/comment', idParam: 'postId', limit: 3 } },
          build: () => ({}),
          defer: '1h',
        }),
      ],
    })
    const cost = estimateCost(cfg.views[0]!)
    const perTarget = '1 target + 1 base + 1 author + ≤ 3 comments (+ reads inside build)'
    expect(cost.lines).toEqual([
      { trigger: 'post/{id} created or deleted', reads: perTarget, writes: '≤ 1 (create / remove the target)' },
      { trigger: 'post/{id} updated', reads: '0 (+ 1 task)', writes: '0' },
      { trigger: 'user/{id} changed', reads: '0 (+ 1 task)', writes: '0' },
      { trigger: 'flush user/{id} (≤ 1 per 1h)', reads: `N + N × (${perTarget})`, writes: '≤ N' },
      { trigger: 'post/{postId}/comment/{id} changed', reads: '0 (+ 1 task)', writes: '0' },
      { trigger: 'postPublic/{id} created or deleted', reads: perTarget, writes: '≤ 1' },
      { trigger: 'postPublic/{id} authorId changed', reads: '0 (+ 1 task)', writes: '0' },
      { trigger: 'flush postPublic/{id} (≤ 1 per 1h)', reads: perTarget, writes: '≤ 1' },
    ])
  })
})

describe('cronRunsPerDay', () => {
  it('averages matches per day over a 4-week window starting 2026-01-01 UTC', () => {
    expect(cronRunsPerDay('* * * * *')).toBe(1440)
    expect(cronRunsPerDay('0 3 * * *')).toBe(1)
    expect(cronRunsPerDay('*/15 * * * *')).toBe(96)
    expect(cronRunsPerDay('0 9-17 * * 1-5')).toBeCloseTo((9 * 20) / 28, 5)
    expect(cronRunsPerDay('0 0 1 * *')).toBeCloseTo(1 / 28, 10)
    expect(cronRunsPerDay('0 0 L * *')).toBeUndefined()
  })
})

describe('writeTriggers / formatChains', () => {
  it('lists which rule each write triggers and prints maximal chains', () => {
    const c = base.rules[0] as Connection
    const chained = validateConfig({
      ...base,
      rules: [
        { ...c, fields: ['name', 'parent'] }, // category -> post.category
        { ...c, name: 'thread-post', source: 'post', target: 'thread', idField: 'postId', fields: ['category'], targetField: 'post' }, // post.category -> thread.post
        { ...c, name: 'msg-thread', source: 'thread', target: 'message', idField: 'threadId', fields: ['post'], targetField: 'thread' },
        { ...c, name: 'area-category', source: 'area', target: 'category', idField: 'areaId', fields: ['name'], targetField: 'parent' },
        { ...c, name: 'unrelated', source: 'shop', target: 'item', idField: 'shopId', fields: ['name'], targetField: 'shop' },
      ],
    })
    const edges = writeTriggers(chained)
    expect(edges).toEqual([
      { from: 'post-category', field: 'post.category', to: 'thread-post' },
      { from: 'thread-post', field: 'thread.post', to: 'msg-thread' },
      { from: 'area-category', field: 'category.parent', to: 'post-category' },
    ])
    expect(formatChains(edges)).toEqual(['area-category -> post-category -> thread-post -> msg-thread'])
    expect(formatChains([{ from: 'a', field: 'x.f', to: 'b' }, { from: 'a', field: 'x.g', to: 'c' }])).toEqual(['a -> b', 'a -> c'])
    expect(formatChains([])).toEqual([])
  })
})
