# firestore-denormalize

Derived Firestore data, kept correct, with **one Cloud Run function and one Eventarc trigger per collection**.

[日本語版 README](./README.ja.md)

When you copy a few fields of `category/{id}` into `post.category`, or keep `post.likeCount` equal to the number of likes, something has to update the derived value whenever its inputs change. This package does that for any number of such rules, defined in a single TypeScript file:

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
  aggregates: [
    {
      name: 'post-likes',
      source: 'post/{postId}/like', // count documents of this subcollection
      target: 'post',               // into the parent post
      idParam: 'postId',            // the placeholder that names the post
      aggregate: 'count',           // or { sum: 'amount' }
      targetField: 'likeCount',
    },
  ],
})
```

## Why

- Replaces one `firestore-connect-document`-style extension (two functions) per rule with a single function.
- Correct under Eventarc's at-least-once, unordered delivery. Event payloads only decide *whether* to act; the values written are always **re-read from Firestore** (copies) or **recomputed with an aggregation query** (counts and sums), and every write is **conditional on the target's `updateTime`**. Late or duplicate events can never overwrite newer data, and counters never drift because nothing is ever `increment()`ed.
- Triggers are created and removed by one command from the same config file. `rebuild` backfills existing data, and `dev` runs the same handler against the Emulator Suite.

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
| `connections[]` | Copy rules (below) |
| `aggregates[]` | Count / sum rules (below) |

**Collections** are paths. A subcollection uses placeholders for the parent IDs: `users/{uid}/posts`. **Fields** may be dotted paths: `address.city`.

**`connections[]`** copy `fields` of `source/{id}` into `target.targetField` wherever `target.idField == id`. Every placeholder of `source` must also appear in `target` so the source of a target can be found; `target` may have extra placeholders (`category` → `users/{uid}/posts`), in which case targets are found with a collection-group query.

**`aggregates[]`** keep `target.targetField` equal to `count()` or `{ sum: 'field' }` over the source documents belonging to the target. The target is named either by a field on the source (`idField: 'postId'`) or by a placeholder of the source path (`idParam: 'postId'` for `post/{postId}/like`).

Validation rejects duplicate names, two rules writing overlapping fields of the same collection, unresolvable placeholders, malformed paths, and loops where one rule's write would trigger the next rule back around to the first.

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

Trigger names are `<name>-<collection ids>` (`users/{uid}/payments` → `<name>-users-payments`, underscores become hyphens). Each trigger filters `google.cloud.firestore.document.v1.written` on the collection's path pattern (`document=users/{uid}/payments/{docId}`) and delivers protobuf payloads.

### 5. Backfill existing data

```sh
npx doc-sync rebuild --project <project> --dry-run      # report what would change
npx doc-sync rebuild --project <project>                 # apply
npx doc-sync rebuild --project <project> --rule post-category --start-after post/abc   # one rule, resumed
```

`rebuild` walks every target of each rule in pages and brings it in line with its current source, using the same compute-and-conditionally-write code as the handler. Missing sources get the rule's `onSourceDelete` treatment. Progress lines include the last processed path so an interrupted run can be resumed with `--start-after`. It uses Application Default Credentials (`gcloud auth application-default login`), or the emulator when `FIRESTORE_EMULATOR_HOST` is set.

## Try it in one command

```sh
git clone https://github.com/fire-launch/firestore-denormalize && cd firestore-denormalize
npm install
npm run demo
```

This starts the Firestore emulator with its UI, runs the handler and the `dev` bridge in the same process, seeds a few documents for the rules in `examples/doc-sync.config.ts`, and prints the Emulator UI URL plus a list of edits to try. Every processed event is printed as it happens. Needs `firebase-tools` on your PATH and Java for the emulator.

## Local development with the Emulator Suite

The emulators have no Eventarc for Firestore, so `doc-sync dev` bridges the gap without a second runtime path: it listens to the configured collections in the Firestore emulator with `onSnapshot`, encodes each change exactly like Eventarc does (protobuf `DocumentEventData`), and POSTs it to your function running in the Functions emulator.

```sh
firebase emulators:start --only firestore,functions
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx doc-sync dev --project demo-app \
  --url http://127.0.0.1:5001/demo-app/asia-northeast1/docSync
```

Documents that already exist when the bridge starts are cached silently; changes from then on are delivered. The bridge refuses to run without `FIRESTORE_EMULATOR_HOST` (or `--emulator-host`), so it cannot be pointed at production by accident.

## CLI

```
doc-sync validate [--config <path>]
doc-sync setup    [--config <path>] [--project <id>] [--dry-run]
doc-sync deploy   [--config <path>] [--project <id>] [--dry-run] [--deploy-function <name>]
doc-sync rebuild  [--config <path>] [--project <id>] [--dry-run] [--rule <name>]... [--start-after <path>] [--page-size <n>]
doc-sync dev      [--config <path>] [--project <id>] --url <handler url> [--emulator-host <host:port>]
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

**Counts and sums** (`post/p1/like/u1` created or deleted, or a watched field changed)

1. Skip if it is an update and neither `idField` nor the summed field changed.
2. For each target the document belonged to before and after (at most two), `get()` the target, run the aggregation query, and write the number if it differs, conditional on the target's `updateTime`. A newly created target gets its initial value the same way.

**Conflicts.** If a conditional write fails because someone else wrote the target in between, that target is redone from step 2 (up to `maxRetries` times, then the request fails with 500 and Eventarc redelivers it). If the source changed after it was read, the event for that change takes care of it. Values are compared deeply (`Timestamp`, `GeoPoint`, `DocumentReference` and bytes included), so the handler's own writes come back as no-ops and multi-step chains such as `area -> shop.area -> post.shop.area` terminate.

**Responses.** `204` for done or nothing to do, and also for unrecoverable input (undecodable payload, unknown collection, other database) which is logged at `error`/`warn` level and not retried. `500` for transient failures, which Eventarc retries with backoff for up to 24 hours. Processing is idempotent.

**Logs.** One structured line per rule per event: `rule`, `kind`, `document`, `role`, `action` (`skip` / `write` / `delete`), `reason`, `targets`, `writes`, `retries`, `durationMs`.

## Known limitations

- Targets are not deleted when the source is deleted; use `setNull` or `deleteField`.
- If an application writes `targetField` directly, the value stays until the source changes again (or until `rebuild`).
- The target query needs the default single-field index on `idField`. Rules that need a collection-group query (`validate` lists them) need a collection-group scope index on that field; Firestore prints the creation link on first use.
- Counts and sums cost one aggregation read per affected target per event.
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
