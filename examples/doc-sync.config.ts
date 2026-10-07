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
  ],
})
