/**
 * Compile-time tests for `typed<Collections>()`. Checked by `npm run typecheck`; every
 * `@ts-expect-error` line must fail to compile, every other line must compile.
 */
import { Timestamp } from 'firebase-admin/firestore'
import { typed, type FieldPath, type FieldPathOf, type Get, type Params } from '../../src/index.js'

interface Post {
  title: string
  categoryId: string
  authorId?: string
  likeCount: number
  category?: { name: string; color: string }
  meta: { createdAt: Timestamp; tags: string[]; by: { uid: string } }
  latest?: { id: string; body: string }[]
}
interface Category {
  name: string
  color: string
  postCount: number
}
interface Comment {
  body: string
  createdAt: Timestamp
  postId: string
}
interface UserPost {
  tagId: string
  tag?: { label: string }
}
interface Tag {
  label: string
}
interface PostPublic {
  title: string
  likeCount?: number
  stats?: { commentCount: number; likeCount?: number }
}
interface User {
  displayName: string
  email: string
}
interface UserPublic {
  displayName: string
}

type Collections = {
  post: Post
  category: Category
  comment: Comment
  'post/{postId}/comment': Comment
  'users/{uid}/posts': UserPost
  'users/{uid}/tags': Tag
  postPublic: PostPublic
  user: User
  userPublic: UserPublic
}

const { defineConfig, defineConnection, defineAggregate, defineView, defineProjection } = typed<Collections>()

// ---------------------------------------------------------------- helpers

type Assert<T extends true> = T
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false

export type _paths = Assert<
  Equal<
    FieldPath<Post>,
    | 'title'
    | 'categoryId'
    | 'authorId'
    | 'likeCount'
    | 'category'
    | 'category.name'
    | 'category.color'
    | 'meta'
    | 'meta.createdAt'
    | 'meta.tags'
    | 'meta.by'
    | 'meta.by.uid'
    | 'latest'
  >
>
export type _strings = Assert<Equal<FieldPathOf<Post, string>, 'title' | 'categoryId' | 'authorId' | 'category.name' | 'category.color' | 'meta.by.uid'>>
export type _numbers = Assert<Equal<FieldPathOf<Post, number>, 'likeCount'>>
export type _get = Assert<Equal<Get<Post, 'meta.by.uid'>, string>>
export type _getOptional = Assert<Equal<Get<Post, 'category.name'>, string>>
export type _params = Assert<Equal<Params<'users/{uid}/posts/{postId}/x'>, 'uid' | 'postId'>>
export type _noParams = Assert<Equal<Params<'post'>, never>>

// ---------------------------------------------------------------- connections

defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'sa',
  rules: [
    { kind: 'connection', name: 'a', source: 'category', target: 'post', idField: 'categoryId', fields: ['name', 'color'], targetField: 'category', onSourceDelete: 'setNull' },
    { kind: 'connection', name: 'b', source: 'users/{uid}/tags', target: 'users/{uid}/posts', idField: 'tagId', fields: ['label'], targetField: 'tag', onSourceDelete: 'nothing' },
    // @ts-expect-error unknown source collection
    { kind: 'connection', name: 'c', source: 'categories', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' },
    // @ts-expect-error `nam` is not a field of Category
    { kind: 'connection', name: 'd', source: 'category', target: 'post', idField: 'categoryId', fields: ['nam'], targetField: 'category', onSourceDelete: 'setNull' },
    // @ts-expect-error idField must be a string field of the target (likeCount is a number)
    { kind: 'connection', name: 'e', source: 'category', target: 'post', idField: 'likeCount', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' },
    // @ts-expect-error targetField must exist on the target
    { kind: 'connection', name: 'f', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'categry', onSourceDelete: 'setNull' },
  ],
})

// ---------------------------------------------------------------- helpers for rules kept in other files

const standalone = defineConnection({
  name: 'standalone', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull',
})
const standaloneCount = defineAggregate({ name: 'count', source: 'post', target: 'category', idField: 'categoryId', aggregate: 'count', targetField: 'postCount' })
defineConfig({ name: 'doc-sync', region: 'r', service: 's', serviceAccount: 'sa', rules: [standalone, standaloneCount] })

// @ts-expect-error `nam` is not a field of Category
defineConnection({ name: 'x', source: 'category', target: 'post', idField: 'categoryId', fields: ['nam'], targetField: 'category', onSourceDelete: 'setNull' })
// @ts-expect-error sum needs a numeric field of the source
defineAggregate({ name: 'x', source: 'post', target: 'category', idField: 'categoryId', aggregate: { sum: 'title' }, targetField: 'postCount' })

// ---------------------------------------------------------------- aggregates

defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'sa',
  rules: [
    { kind: 'aggregate', name: 'a', source: 'post', target: 'category', idField: 'categoryId', aggregate: 'count', targetField: 'postCount' },
    { kind: 'aggregate', name: 'b', source: 'post/{postId}/comment', target: 'post', idParam: 'postId', aggregate: 'count', targetField: 'likeCount' },
    // @ts-expect-error idParam must be a placeholder of the source
    { kind: 'aggregate', name: 'c', source: 'post/{postId}/comment', target: 'post', idParam: 'commentId', aggregate: 'count', targetField: 'likeCount' },
    // @ts-expect-error sum needs a numeric field of the source
    { kind: 'aggregate', name: 'd', source: 'post', target: 'category', idField: 'categoryId', aggregate: { sum: 'title' }, targetField: 'postCount' },
    // @ts-expect-error targetField must be numeric
    { kind: 'aggregate', name: 'e', source: 'post', target: 'category', idField: 'categoryId', aggregate: 'count', targetField: 'name' },
  ],
})

// ---------------------------------------------------------------- views

const latest = defineView({
  name: 'post-latest',
  target: 'post',
  targetFields: ['latest'],
  sources: {
    comments: { collection: 'post/{postId}/comment', idParam: 'postId', orderBy: [['createdAt', 'desc']], limit: 2, watch: ['body'] },
    cat: { collection: 'category', refField: 'categoryId' },
  },
  build: ({ sources, target }) => {
    const title: string = target.get('title')
    const color: string | undefined = sources.cat[0]?.data().color
    void title
    void color
    // sources.comments is QueryDocumentSnapshot<Comment>[]: data().body is a string
    return { latest: sources.comments.map((c) => ({ id: c.id, body: c.data().body })) }
  },
  patch: (current, change) => {
    if (change.source === 'comments') {
      // change.after is Comment | undefined
      const body: string | undefined = change.after?.body
      void body
    }
    return current
  },
})

defineConfig({ name: 'doc-sync', region: 'r', service: 's', serviceAccount: 'sa', rules: [latest] })

defineView({
  name: 'x',
  target: 'post',
  targetFields: ['latest'],
  // @ts-expect-error unknown collection
  sources: { c: { collection: 'comments', idField: 'postId' } },
  build: () => ({}),
})

defineView({
  name: 'x',
  target: 'post',
  targetFields: ['latest'],
  // @ts-expect-error refField must be a string field of the target
  sources: { c: { collection: 'category', refField: 'likeCount' } },
  build: () => ({}),
})

defineView({
  name: 'x',
  target: 'post',
  targetFields: ['latest'],
  // @ts-expect-error orderBy must name a field of the source
  sources: { c: { collection: 'comment', idField: 'postId', orderBy: ['createdAtt'] } },
  build: () => ({}),
})

defineView({
  name: 'x',
  target: 'post',
  // @ts-expect-error targetField must exist on the target
  targetFields: ['latestt'],
  sources: { c: { collection: 'comment', idField: 'postId' } },
  build: () => ({}),
})

defineView({
  name: 'x',
  target: 'post',
  targetFields: ['likeCount'],
  sources: { c: { collection: 'comment', idField: 'postId' } },
  // @ts-expect-error `bodyy` is not a field of Comment
  build: ({ sources }) => ({ likeCount: sources.c.filter((c) => c.data().bodyy).length }),
})

// ---------------------------------------------------------------- views with base / several paths

const pub = defineView({
  name: 'post-public',
  target: 'postPublic',
  base: 'post',
  targetFields: ['title', 'stats.commentCount'],
  sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
  build: ({ base, sources }) => {
    const title: string = base.data()!.title
    return { title, stats: { commentCount: sources.comments.length } }
  },
  patch: (current, change) => {
    const n: number | undefined = current.stats?.commentCount
    void change
    return { ...current, stats: { commentCount: (n ?? 0) + 1 } }
  },
})

defineConfig({ name: 'doc-sync', region: 'r', service: 's', serviceAccount: 'sa', rules: [latest, pub] })

defineView({
  name: 'x',
  target: 'postPublic',
  base: 'post',
  targetFields: ['title'],
  // @ts-expect-error likeCount is a target key outside the declared roots
  build: () => ({ title: 't', likeCount: 1 }),
})

defineView({
  name: 'x',
  target: 'postPublic',
  base: 'post',
  targetFields: ['title'],
  // @ts-expect-error title must be a string
  build: () => ({ title: 1 }),
})

defineView({
  name: 'x',
  target: 'postPublic',
  targetFields: ['title'],
  sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
  // @ts-expect-error `base` is undefined on a view without `base`
  build: ({ base }) => ({ title: base.data()!.title }),
})

defineView({
  name: 'x',
  target: 'postPublic',
  base: 'post',
  // @ts-expect-error nope is not a field of postPublic
  targetFields: ['nope'],
  build: () => ({}),
})

// `rest` lets build return any part of the target type
defineView({ name: 'x', target: 'postPublic', base: 'post', targetFields: ['rest'], build: ({ base }) => ({ title: base.data()!.title, stats: { commentCount: 0 } }) })

// ---------------------------------------------------------------- projections

const proj = defineProjection({ name: 'user-public', base: 'user', target: 'userPublic', targetFields: ['displayName'] })
defineConfig({ name: 'doc-sync', region: 'r', service: 's', serviceAccount: 'sa', rules: [proj] })

// ---------------------------------------------------------------- schedule

const scheduledCount = defineAggregate({
  name: 'scheduled-count', source: 'post', target: 'category', idField: 'categoryId', aggregate: 'count', targetField: 'postCount', schedule: '0 3 * * *', timeZone: 'Asia/Tokyo',
})
defineConfig({ name: 'doc-sync', region: 'r', service: 's', serviceAccount: 'sa', rules: [scheduledCount] })

const scheduledView = defineView({
  name: 'post-latest-scheduled',
  target: 'post',
  targetFields: ['latest'],
  sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
  build: () => ({ latest: [] }),
  schedule: '*/30 * * * *',
})
defineConfig({ name: 'doc-sync', region: 'r', service: 's', serviceAccount: 'sa', rules: [scheduledView] })

const scheduledCopy = defineConnection({
  name: 'scheduled-copy', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull', schedule: '0 4 * * *', timeZone: 'Asia/Tokyo',
})
const scheduledProjection = defineProjection({ name: 'scheduled-user-public', base: 'user', target: 'userPublic', targetFields: ['displayName'], schedule: '0 5 * * *' })
defineConfig({ name: 'doc-sync', region: 'r', service: 's', serviceAccount: 'sa', rules: [scheduledCopy, scheduledProjection] })

defineProjection({
  name: 'x',
  base: 'user',
  target: 'userPublic',
  // @ts-expect-error email is not a field of userPublic
  targetFields: ['email'],
})

// ---------------------------------------------------------------- DeepPartial stops at Leaf types

defineView({
  name: 'x',
  target: 'post',
  targetFields: ['meta'],
  // @ts-expect-error createdAt must be a Timestamp
  build: () => ({ meta: { createdAt: 'x', tags: [], by: { uid: 'u' } } }),
})

defineView({
  name: 'y',
  target: 'post',
  targetFields: ['meta'],
  build: () => ({ meta: { createdAt: Timestamp.now(), tags: [], by: { uid: 'u' } } }),
})
