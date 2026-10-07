# firestore-denormalize

Keep denormalized Firestore data in sync with **one Cloud Run function and one Eventarc trigger per collection**.

[日本語版 README](./README.ja.md)

When you copy a few fields of `category/{id}` into `post.category`, something has to update every `post` whenever the category changes. This package does that for any number of such rules, defined in a single TypeScript file:

```ts
// doc-sync.config.ts
import { defineConfig } from 'firestore-denormalize'

export default defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  connections: [
    {
      name: 'post-category',
      source: 'category',          // copy from category/{id}
      target: 'post',              // into post documents
      idField: 'categoryId',       // where post.categoryId == id
      fields: ['name', 'color'],   // these fields
      targetField: 'category',     // as post.category = { name, color }
      onSourceDelete: 'setNull',   // 'setNull' | 'deleteField' | 'nothing'
    },
  ],
})
```

## Why

- Replaces one `firestore-connect-document`-style extension (two functions) per rule with a single function.
- Correct under Eventarc's at-least-once, unordered delivery. Event payloads only decide *whether* to act; the values written are always **re-read from Firestore**, and every write is **conditional on the target's `updateTime`**. Late or duplicate events can never overwrite newer data.
- Triggers are created and removed by one command from the same config file.

## Requirements

- Node.js 20+, `firebase-admin` 12+ (peer dependency)
- Firestore in Native mode. Triggers run in the database's location (`asia-northeast1`, `nam5`, ...).
- `gcloud` CLI, authenticated, for `doc-sync setup` / `doc-sync deploy`

## Install

```sh
npm install firestore-denormalize
```

## Quick start

### 1. Write the config

Create `doc-sync.config.ts` at the root of your Firebase project (see above). Fields:

| Key | Meaning |
|---|---|
| `name` | Instance name, used for trigger names and labels (`[a-z][a-z0-9-]*`) |
| `region` | Eventarc trigger location. Must match the Firestore database location |
| `database` | Firestore database ID. Default `(default)` |
| `service` | Cloud Run service name of the deployed function (for `onRequest`, the function name in lowercase) |
| `serviceRegion` | Region of the Cloud Run service. Default `region` |
| `serviceAccount` | Service account for the triggers. A bare ID is expanded to `<id>@<project>.iam.gserviceaccount.com` |
| `connections[]` | The rules. `source` / `target` are top-level collections, `fields` are top-level field names |

Validation rejects duplicate names, two rules writing the same `target.targetField`, cycles between collections, subcollections, and field names containing path syntax such as `.`.

### 2. Expose the handler as an HTTP function

```ts
// functions/src/index.ts
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import { createDocSyncHandler } from 'firestore-denormalize'
import config from '../../doc-sync.config'

initializeApp()

export const docSync = onRequest(
  {
    region: 'asia-northeast1',
    cpu: 1,
    memory: '512MiB',
    concurrency: 80,
    minInstances: 1,
    maxInstances: 10,
    timeoutSeconds: 300,
    invoker: 'doc-sync-trigger@<project>.iam.gserviceaccount.com',
  },
  createDocSyncHandler(config, {
    firestore: getFirestore(), // default: getFirestore()
    logger: console,           // default: structured JSON logger
    maxRetries: 5,             // redo a target this many times when its conditional write fails
    pageSize: 500,             // target query page size
  }),
)
```

The handler is a plain `(req, res) => Promise<void>`, so it also works with Express or Node's `http` server. It does not depend on `firebase-functions`.

### 3. Create the trigger service account (once)

```sh
npx doc-sync setup --project <project>
```

Creates the service account, grants `roles/eventarc.eventReceiver` on the project and `roles/run.invoker` on the service, and enables the Eventarc and Cloud Run APIs. Idempotent. Add `--dry-run` to print the `gcloud` commands instead.

### 4. Deploy the function, then the triggers

```sh
firebase deploy --only functions:docSync
npx doc-sync deploy --project <project>
```

`deploy` lists existing triggers labelled `doc-sync-instance=<name>`, creates one trigger per collection that appears as a `source` or `target`, updates triggers whose settings drifted from the config (service, region, database, service account), deletes triggers for collections no longer in the config, and leaves the rest untouched. Pass `--deploy-function docSync` to run `firebase deploy` first, or `--dry-run` to only print the commands.

Trigger names are `<name>-<collection>` (underscores become hyphens). Each trigger filters `google.cloud.firestore.document.v1.written` on `document=<collection>/{docId}` and delivers protobuf payloads.

## CLI

```
doc-sync validate [--config <path>]
doc-sync setup    [--config <path>] [--project <id>] [--dry-run]
doc-sync deploy   [--config <path>] [--project <id>] [--dry-run] [--deploy-function <name>]
```

`--config` defaults to `./doc-sync.config.ts`. `--project` defaults to `$GOOGLE_CLOUD_PROJECT`, then gcloud's active project. The config may be TypeScript or JavaScript, ESM or CJS.

## How a change is processed

For an event on `collection/docId`, every connection whose `source` or `target` is that collection runs independently.

**As a source** (`category/c1` changed)

1. Skip if it is an update and none of `fields` changed.
2. Query `target where idField == docId`, in pages of `pageSize`.
3. For each page, `get()` the current source. If it exists, build `{ ...fields }` (fields missing on the source are omitted). If it is gone, follow `onSourceDelete`: write `null`, delete the field, or stop.
4. For each target whose `targetField` differs from that value, `update()` it with `lastUpdateTime` set to the `updateTime` observed in step 2. Writes go through `BulkWriter`.

**As a target** (`post/p1` changed)

1. Skip if the document was deleted or `idField` did not change.
2. `get()` the current target. If `idField` is empty, delete `targetField` (when present).
3. Otherwise `get()` the referenced source and build the value. If the source does not exist, do nothing.
4. Write only if the value differs, conditional on the `updateTime` from step 2.

**Conflicts.** If a conditional write fails because someone else wrote the target in between, that target is redone from step 2 (up to `maxRetries` times, then the request fails with 500 and Eventarc redelivers it). If the source changed after it was read, the event for that change takes care of it. Values are compared deeply (`Timestamp`, `GeoPoint`, `DocumentReference` and bytes included), so the handler's own writes come back as no-ops and multi-step chains such as `area -> shop.area -> post.shop.area` terminate.

**Responses.** `204` for done or nothing to do, and also for unrecoverable input (undecodable payload, unknown collection, other database) which is logged at `error`/`warn` level and not retried. `500` for transient failures, which Eventarc retries with backoff for up to 24 hours. Processing is idempotent.

**Logs.** One structured line per connection per event: `connection`, `document`, `role`, `action` (`skip` / `write` / `delete`), `reason`, `targets`, `writes`, `retries`, `durationMs`.

## Known limitations

- Top-level collections and top-level field names only.
- Targets are not deleted when the source is deleted; use `setNull` or `deleteField`.
- No backfill. Existing targets are updated the next time their source or their `idField` changes.
- If an application writes `targetField` directly, the value stays until the source changes again.
- The target query needs the default single-field index on `idField`. If you have exempted that field, add the index back.
- Latency is Eventarc's delivery latency (typically under a second to a few seconds).

See [ROADMAP.md](./ROADMAP.md) for what is planned, including backfill, subcollections and emulator support.

## Recommended function settings

| Setting | Value | Why |
|---|---|---|
| `cpu` | 1 | Required for `concurrency > 1`; the work is I/O bound |
| `memory` | 512MiB | Target queries are paged, so memory is bounded |
| `concurrency` | 80 | Mostly waiting on Firestore |
| `minInstances` | 1 | Avoids cold starts (optional) |
| `maxInstances` | 10 | Caps write bursts against Firestore |
| `timeoutSeconds` | 300 | Room for large fan-outs; below Eventarc's 600s ack deadline |

Tune after watching Cloud Run CPU, memory, latency and instance count.

## Development

```sh
npm install
npm run typecheck
npm test          # unit + integration tests against the Firestore emulator (needs firebase-tools and Java)
npm run build     # ESM + CJS + .d.ts into dist/
```

`npm run protos:build` regenerates `src/proto/firestore-events.json` from the `.proto` files under `protos/`.

## License

MIT
