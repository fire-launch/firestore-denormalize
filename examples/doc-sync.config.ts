import { defineConfig } from 'firestore-denormalize'

export default defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  database: '(default)',
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
    {
      name: 'post-author',
      source: 'user',
      target: 'post',
      idField: 'authorId',
      fields: ['displayName', 'photoUrl'],
      targetField: 'author',
      onSourceDelete: 'deleteField',
    },
    {
      // Subcollections: every placeholder of `source` must also appear in `target`.
      name: 'user-post-tag',
      source: 'users/{uid}/tags',
      target: 'users/{uid}/posts',
      idField: 'tagId',
      fields: ['label'],
      targetField: 'tag',
      onSourceDelete: 'setNull',
    },
  ],

  aggregates: [
    {
      // post.likeCount = number of documents in post/{postId}/like
      name: 'post-likes',
      source: 'post/{postId}/like',
      target: 'post',
      idParam: 'postId',
      aggregate: 'count',
      targetField: 'likeCount',
    },
    {
      // customer.total = sum of order.amount where order.customerId == customer id
      name: 'customer-total',
      source: 'order',
      target: 'customer',
      idField: 'customerId',
      aggregate: { sum: 'amount' },
      targetField: 'total',
    },
  ],
})
