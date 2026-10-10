/**
 * Compile-time tests for `typed<Collections>()`. Checked by `npm run typecheck`; every
 * `@ts-expect-error` line must fail to compile, every other line must compile.
 */
import type { Timestamp } from 'firebase-admin/firestore'
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

type Collections = {
  post: Post
  category: Category
  comment: Comment
  'post/{postId}/comment': Comment
  'users/{uid}/posts': UserPost
  'users/{uid}/tags': Tag
}

const { defineConfig, defineView } = typed<Collections>()

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
  connections: [
    { name: 'a', source: 'category', target: 'post', idField: 'categoryId', fields: ['name', 'color'], targetField: 'category', onSourceDelete: 'setNull' },
    { name: 'b', source: 'users/{uid}/tags', target: 'users/{uid}/posts', idField: 'tagId', fields: ['label'], targetField: 'tag', onSourceDelete: 'nothing' },
    // @ts-expect-error unknown source collection
    { name: 'c', source: 'categories', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' },
    // @ts-expect-error `nam` is not a field of Category
    { name: 'd', source: 'category', target: 'post', idField: 'categoryId', fields: ['nam'], targetField: 'category', onSourceDelete: 'setNull' },
    // @ts-expect-error idField must be a string field of the target (likeCount is a number)
    { name: 'e', source: 'category', target: 'post', idField: 'likeCount', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' },
    // @ts-expect-error targetField must exist on the target
    { name: 'f', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'categry', onSourceDelete: 'setNull' },
  ],
})

// ---------------------------------------------------------------- aggregates

defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'sa',
  aggregates: [
    { name: 'a', source: 'post', target: 'category', idField: 'categoryId', aggregate: 'count', targetField: 'postCount' },
    { name: 'b', source: 'post/{postId}/comment', target: 'post', idParam: 'postId', aggregate: 'count', targetField: 'likeCount' },
    // @ts-expect-error idParam must be a placeholder of the source
    { name: 'c', source: 'post/{postId}/comment', target: 'post', idParam: 'commentId', aggregate: 'count', targetField: 'likeCount' },
    // @ts-expect-error sum needs a numeric field of the source
    { name: 'd', source: 'post', target: 'category', idField: 'categoryId', aggregate: { sum: 'title' }, targetField: 'postCount' },
    // @ts-expect-error targetField must be numeric
    { name: 'e', source: 'post', target: 'category', idField: 'categoryId', aggregate: 'count', targetField: 'name' },
  ],
})

// ---------------------------------------------------------------- views

const latest = defineView({
  name: 'post-latest',
  target: 'post',
  targetField: 'latest',
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
    return sources.comments.map((c) => ({ id: c.id, body: c.data().body }))
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

defineConfig({ name: 'doc-sync', region: 'r', service: 's', serviceAccount: 'sa', views: [latest] })

defineView({
  name: 'x',
  target: 'post',
  targetField: 'latest',
  // @ts-expect-error unknown collection
  sources: { c: { collection: 'comments', idField: 'postId' } },
  build: () => [],
})

defineView({
  name: 'x',
  target: 'post',
  targetField: 'latest',
  // @ts-expect-error refField must be a string field of the target
  sources: { c: { collection: 'category', refField: 'likeCount' } },
  build: () => [],
})

defineView({
  name: 'x',
  target: 'post',
  targetField: 'latest',
  // @ts-expect-error orderBy must name a field of the source
  sources: { c: { collection: 'comment', idField: 'postId', orderBy: ['createdAtt'] } },
  build: () => [],
})

defineView({
  name: 'x',
  target: 'post',
  // @ts-expect-error targetField must exist on the target
  targetField: 'latestt',
  sources: { c: { collection: 'comment', idField: 'postId' } },
  build: () => [],
})

defineView({
  name: 'x',
  target: 'post',
  targetField: 'likeCount',
  sources: { c: { collection: 'comment', idField: 'postId' } },
  // @ts-expect-error build must return the type of the target field (number)
  build: ({ sources }) => sources.c.map((c) => c.id),
})

defineView({
  name: 'x',
  target: 'post',
  targetField: 'likeCount',
  sources: { c: { collection: 'comment', idField: 'postId' } },
  // @ts-expect-error `bodyy` is not a field of Comment
  build: ({ sources }) => sources.c.filter((c) => c.data().bodyy).length,
})
