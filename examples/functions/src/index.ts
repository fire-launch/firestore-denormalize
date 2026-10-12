import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import { createDocSyncHandler } from 'firestore-denormalize'
// doc-sync.config.ts sits next to this file, inside functions/src, so it ships with `firebase deploy`.
import config from './doc-sync.config'

initializeApp()

export const docSync = onRequest(
  {
    region: 'asia-northeast1',
    cpu: 1,
    memory: '512MiB',
    concurrency: 80,
    minInstances: 1,
    maxInstances: 10,
    timeoutSeconds: 1800, // the config has a scheduled rule: must exceed schedule.budgetMs (default 20 min)
    // Only the trigger service account may call this function.
    invoker: 'doc-sync-trigger@<project>.iam.gserviceaccount.com',
  },
  createDocSyncHandler(config, { firestore: getFirestore() }),
)
