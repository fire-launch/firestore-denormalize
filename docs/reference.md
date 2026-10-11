# Reference

Everything the [README](../README.md) leaves out. Sections: [Config](#config) · [Handler](#handler) · [CLI](#cli) · [How a change is processed](#how-a-change-is-processed) · [Logs](#logs) · [Cost estimate](#cost-estimate) · [Known limitations](#known-limitations) · [Security](#security) · [Recommended function settings](#recommended-function-settings)

## Config

`doc-sync.config.ts` exports `defineConfig({ ... })`. Keep it under `functions/src/` so `firebase deploy` ships it and `tsc` compiles it next to your function; pass `--config functions/src/doc-sync.config.ts` to the CLI. The config may be TypeScript or JavaScript, ESM or CJS.

| Key | Meaning |
|---|---|
| `name` | Instance name, used for trigger names and labels (`[a-z][a-z0-9-]*`) |
| `region` | Eventarc trigger location. Must match the Firestore database location (`nam5` etc. for multi-region databases) |
| `database` | Firestore database ID. Default `(default)` |
| `service` | Cloud Run service name of the deployed function (for `onRequest`, the function name in lowercase) |
| `serviceRegion` | Region of the Cloud Run service. Default `region`. Required when `region` is a multi-region (`nam5`, `eur3`, ...), since Cloud Run has no such region |
| `serviceAccount` | Service account for the triggers. A bare ID is expanded to `<id>@<project>.iam.gserviceaccount.com` |
| `connections[]` | Copy rules (below) |
| `aggregates[]` | Count / sum rules (below) |
| `views[]` | Rules computed by your own `build` function (below) |

Trigger names are derived from the collections' ids, lower-cased (`chatRooms` → `chatrooms`); validation rejects a config where two of them would collide, and also rejects two collection patterns that can match the same documents, such as `users/admin/posts` next to `users/{uid}/posts`.

**Collections** are paths. A subcollection uses placeholders for the parent IDs: `users/{uid}/posts`. **Fields** may be dotted paths: `address.city`.

**`connections[]`** copy `fields` of `source/{id}` into `target.targetField` wherever `target.idField == id`. Every placeholder of `source` must also appear in `target` so the source of a target can be found; `target` may have extra placeholders (`category` → `users/{uid}/posts`), in which case targets are found with a collection-group query.

**`aggregates[]`** keep `target.targetField` equal to `count()` or `{ sum: 'field' }` over the source documents belonging to the target. The target is named either by a field on the source (`idField: 'postId'`) or by a placeholder of the source path (`idParam: 'postId'` for `post/{postId}/like`).

**`views[]`** keep `target.targetField` equal to whatever `build({ target, sources })` returns, for shapes the other rules cannot express: the latest N items, a map keyed by id, a custom summary. `sources` is an object keyed by the names `build` sees; each source names a collection and how its documents relate to the target:

| Source key | Relation |
|---|---|
| `idField: 'postId'` | Many-to-one: the source documents whose field holds the target ID |
| `idParam: 'postId'` | Many-to-one: the source documents under the target (`post/{postId}/comment`) |
| `refField: 'authorId'` | One-to-one: the document the target's own field points at |

Many-to-one sources accept `orderBy` (`['createdAt', ['score', 'desc']]`) and `limit`. `watch` lists the source fields whose change triggers a recompute; without it, any change does. `watch` always also covers the source's `idField`, when it has one, and its `orderBy` fields, since those decide membership and order. `build` receives every source as an array of `QueryDocumentSnapshot` (zero or one for `refField`), must be deterministic, and returns the value to store, or `undefined` to delete the field; `undefined` is stripped out of whatever is returned before it is written — a map entry holding `undefined` is dropped, an array element holding `undefined` becomes `null`. The optional `patch(current, change, { target, firestore })` is a fast path that derives the new value from the current one and the changed document alone; return `undefined` to fall back to `build`. `change.after` is a fresh read of that document, not the event payload, so a late or duplicate event still converges on the current state; it is `undefined` both when the document was deleted and when it changed but no longer belongs to this target (for example it moved to another parent), so `patch` can treat "`after` is `undefined`" as "remove this item". `patch` must be idempotent and key items by document ID. `firestore` is there for a small extra read when one is needed, such as a `limit(1)` query to refill a "latest N" list after a delete. Only the target's `refField`s are watched on the target side: if `build` reads other target fields, they are picked up on the next source change or `rebuild`. Wrap each view in `defineView(...)` to get `sources` typed inside `build`.

Validation rejects duplicate names, two rules writing overlapping fields of the same collection, unresolvable placeholders, malformed paths, and loops where one rule's write would trigger the next rule back around to the first.

### Typed config

Give `typed<Collections>()` your document types, keyed by collection path, and every field name in the config is checked at compile time. A renamed field then fails `tsc` instead of silently copying `undefined`.

```ts
import { typed } from 'firestore-denormalize'
import type { Post, Category, Comment } from './types'

type Collections = { post: Post; category: Category; 'post/{postId}/comment': Comment }
const { defineConfig, defineView } = typed<Collections>()

export default defineConfig({
  // ...
  connections: [
    // `source` / `target` must be keys of Collections; `fields` are paths of Category,
    // `idField` a string field of Post, `targetField` a field of Post
    { name: 'post-category', source: 'category', target: 'post', idField: 'categoryId', fields: ['name', 'color'], targetField: 'category', onSourceDelete: 'setNull' },
  ],
  views: [
    defineView({
      name: 'post-latest-comments',
      target: 'post',
      targetField: 'latestComments', // must exist on Post; build must return its type
      sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId', orderBy: [['createdAt', 'desc']], limit: 2 } },
      build: ({ sources }) => sources.comments.map((c) => ({ id: c.id, body: c.data().body })), // c is QueryDocumentSnapshot<Comment>
    }),
  ],
})
```

Field paths may be dotted (`'address.city'`), `idField` / `refField` must be string fields, `sum` and aggregate `targetField` numeric fields, `idParam` a placeholder of the source path. `Collections` must be a type alias (not an interface). Both functions are identities at runtime, so `validateConfig` and the CLI see an ordinary config.

## Handler

```ts
// functions/src/index.ts
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import { createDocSyncHandler } from 'firestore-denormalize'
// doc-sync.config.ts sits next to this file, inside functions/src.
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

## CLI

`--config` defaults to `./doc-sync.config.ts`; run from inside `functions/` with `--config src/doc-sync.config.ts`, or from the project root with `--config functions/src/doc-sync.config.ts`. `--project` defaults to `$GOOGLE_CLOUD_PROJECT`, then gcloud's active project. The config may be TypeScript or JavaScript, ESM or CJS.

`--emulator-host` applies to `rebuild`, `verify` and `dev`, not only `dev`: set it (or `FIRESTORE_EMULATOR_HOST`) and any of the three talk to the emulator instead of production. `--start-after` resumes after a document path, but only for the first rule processed, so use it together with `--rule` to resume a specific one.

`deploy`'s drift detection compares the service, its region, the document path pattern and the service account of each existing trigger against the config. It does not compare the Eventarc trigger's own `region`: triggers are listed and created in that location, so changing `region` itself leaves the old triggers behind. Delete them by hand, or run `deploy` with the old config once more before switching to the new one.

In `verify`, the CLI prints each mismatch's actual and expected values to stdout, so they end up in CI logs; the underlying library log line (`doc-sync verify: mismatch`) carries only the document path and field, since the values may hold personal data.

### setup

Creates the service account, grants `roles/eventarc.eventReceiver` on the project and `roles/run.invoker` on the service, and enables the Eventarc and Cloud Run APIs. Idempotent. Add `--dry-run` to print the `gcloud` commands instead.

The Cloud Run service does not exist yet on a first run, so `roles/run.invoker` cannot be granted to it; `setup` prints a note and skips that one step, relying on the `invoker:` option of `onRequest` instead. Run `setup` again after the first `firebase deploy` and it grants the binding then — re-running it is always safe.

### deploy

`deploy` lists existing triggers labelled `doc-sync-instance=<name>`, creates one trigger per collection that appears as a `source` or `target`, updates triggers whose settings drifted from the config (the Cloud Run service and its region, the document path pattern, and the service account), deletes triggers for collections no longer in the config, and leaves the rest untouched. Pass `--deploy-function docSync` to run `firebase deploy` first, or `--dry-run` to only print the commands.

Trigger names are `<name>-<collection ids>` (`users/{uid}/payments` → `<name>-users-payments`, underscores become hyphens). Each trigger filters `google.cloud.firestore.document.v1.written` on the collection's path pattern (`document=users/{uid}/payments/{docId}`) and delivers protobuf payloads.

### rebuild

`rebuild` walks every target of each rule in pages and brings it in line with its current source, using the same compute-and-conditionally-write code as the handler. Missing sources get the rule's `onSourceDelete` treatment. Progress lines include the last processed path so an interrupted run can be resumed with `--start-after`. It uses Application Default Credentials (`gcloud auth application-default login`), or the emulator when `FIRESTORE_EMULATOR_HOST` is set.

### verify

`verify` walks every target the same way `rebuild` does, but compares instead of writing: it recomputes the value from the current sources and reports every document whose `targetField` differs, without touching it. Pass `--fix` to repair mismatches with the same conditional writes the handler uses. The command exits non-zero when a mismatch remains unfixed, so it can run as a CI or scheduled check against production.

### dev

Documents that already exist when the bridge starts are cached silently; changes from then on are delivered. The bridge refuses to run without `FIRESTORE_EMULATOR_HOST` (or `--emulator-host`), so it cannot be pointed at production by accident.

## How a change is processed

For an event on `collection/docId`, every rule (connection, aggregate, view) whose `source` or `target` is that collection runs; source-side work for different rules runs in parallel, target-side work on the event's own document runs one rule after another.

**As a source** (`category/c1` changed)

1. Skip if it is an update and none of `fields` changed.
2. Query `target where idField == docId`, in pages of `pageSize`.
3. For each page, `get()` the current source. If it exists, build `{ ...fields }` (fields missing on the source are omitted). If it is gone, follow `onSourceDelete`: write `null`, delete the field, or stop.
4. For each target whose `targetField` differs from that value, `update()` it with `lastUpdateTime` set to the `updateTime` observed in step 2. Writes go through `BulkWriter`.

**As a target** (`post/p1` changed)

1. Skip if the document was deleted or `idField` did not change.
2. `get()` the current target. If `idField` is empty, delete `targetField` (when present).
3. Otherwise `get()` the referenced source and build the value. If the source does not exist, follow `onSourceDelete` — the same treatment `rebuild` gives a missing source — instead of leaving the target alone.
4. Write only if the value differs, conditional on the `updateTime` from step 2.

An application write that removed `targetField` directly (for example `set()` without merge) is recomputed on the next event for that document, even if the source value itself did not change.

**Counts and sums** (`post/p1/like/u1` created or deleted, or a watched field changed)

1. Skip if it is an update and neither `idField` nor the summed field changed.
2. For each target the document belonged to before and after (at most two), `get()` the target, run the aggregation query, and write the number if it differs, conditional on the target's `updateTime`. A newly created target gets its initial value the same way.

The same recomputation-on-removal rule applies here: if `targetField` was removed by an application write, the next event for that target recomputes it.

**Views.** On a source change (skipped when `watch` fields, or the whole document when `watch` is unset, did not change), every target it belongs to is read, then `patch` (if defined, given a fresh read of the changed document; returning `undefined` falls back) or `build` over fresh reads of every source computes the value, written conditionally if it differs. That fresh read is also where membership is re-checked: if the changed document no longer belongs to this target (for example it moved to another parent), `patch` sees `change.after` as `undefined`, the same as a delete. Targets are recomputed on create and when a `refField` changes, and also when an application write removed `targetField` directly. `rebuild` / `verify` always use `build`.

**Conflicts.** If a conditional write fails because someone else wrote the target in between, that target is redone from step 2 (up to `maxRetries` times, then the request fails with 500 and Eventarc redelivers it). If the source changed after it was read, the event for that change takes care of it. Values are compared deeply (`Timestamp`, `GeoPoint`, `DocumentReference` and bytes included), so the handler's own writes come back as no-ops and multi-step chains such as `area -> shop.area -> post.shop.area` terminate.

**Responses.** `204` for done or nothing to do. Unrecoverable input also gets `204`: an undecodable payload or an unknown collection are logged at `warn`/`error` and not retried; an event for another database is logged at `info` and ignored; a `ce-type` that is not a Firestore document event, a request body over 16 MiB, and a value nested deeper than 20 levels are dropped the same way. `500` for transient failures, which Eventarc retries with backoff for up to 24 hours. Processing is idempotent.

## Logs

One structured line per rule per event: `eventId`, `rule`, `kind`, `source` (the matched view source key; views only), `document`, `role`, `action` (`skip` / `write` / `delete`), `reason`, `targets`, `writes`, `retries`, `reads`, `queries`, `aggregations`, `durationMs`. `durationMs` is the time for the whole event, the same on every line it produces, not just that one rule. The read counters follow Firestore billing: one per document read (missing documents included), one per document a query returned (at least one per query), and aggregations counted separately. Reads a view's `build` / `patch` makes through the `firestore` in its context are included; reads through a Firestore instance obtained elsewhere are not. Summing `reads` by `rule` in Cloud Logging shows which rule costs what. A rule that fails instead logs `doc-sync: failed, will be retried by Eventarc` with `eventId`, `document`, `rule`, `error` and `durationMs`.

## Cost estimate

`doc-sync validate` prints, per rule, the Firestore reads and writes one event causes, as formulas over `N` (the targets matching the changed source) and `M` (the source documents belonging to one target). Reads are billable document reads; aggregation queries (`count()` / `sum()`) are counted separately since they are billed differently. Reads a view's `build` or `patch` performs itself are user code and cannot be counted statically, so they show as "(+ reads inside build)" / "(+ reads inside patch)"; the handler reports the actual counts per event in its logs as `reads` / `queries` / `aggregations` (see [Logs](#logs)), and `rebuild` / `verify` print them per rule.

Two warnings call out shapes that are expensive by construction: a `refField` view source fans out, since one change to the referenced document rebuilds every target that points at it; and a many-to-one source with no `limit` and no `patch` reads every source document of the target on every event, since there is no fast path and no cap on the query. Pass `--strict` to turn either warning into a failing exit code, so it can gate CI before an expensive rule reaches production.

## Known limitations

- Targets are not deleted when the source is deleted; use `setNull` or `deleteField`.
- If an application overwrites `targetField` with another value, it stays until the source changes again (or `rebuild` / `verify --fix`); removing the field is repaired on the next event for that document.
- The target query needs the default single-field index on `idField`. Rules that need a collection-group query (`validate` lists them) need a collection-group scope index on that field; Firestore prints the creation link on first use.
- A view source with `idField` plus `orderBy` on another field needs a composite index (`validate` lists collection-group indexes only; Firestore prints the link for composite ones on first use).
- Counts and sums cost one aggregation read per affected target per event. A view costs one target read plus, per source, one read per document returned (up to `limit`, else all M) per affected target, unless `patch` handles the event (then 2 reads).
- Permanent failures inside user code (`build` / `patch` throwing) or a missing index return 500, which Eventarc redelivers with backoff for up to 24 hours; watch the `doc-sync: failed` log line and consider a dead-letter topic on the trigger.
- Latency is Eventarc's delivery latency (typically under a second to a few seconds).

See [ROADMAP.md](./ROADMAP.md) for what is not planned.

## Security

- The handler does not authenticate requests on its own. Restricting invocation to the trigger service account is required, not optional: pass `invoker: '<trigger-sa>@<project>.iam.gserviceaccount.com'` to `onRequest`, or on a plain Cloud Run deploy use `--no-allow-unauthenticated` plus `roles/run.invoker` for that account. Without it the function is public.
- What a forged or replayed request can do if it gets through anyway: force recomputation, which costs reads, but it can never make the handler write attacker-supplied data. Every value is re-read from its real sources, and a view's `patch` receives a fresh, membership-checked read of the changed document rather than anything from the request body.
- The handler also limits what any request can do: the `ce-type` must identify a Firestore document event, the body is capped at 16 MiB, and values nested deeper than 20 levels are rejected; anything else is dropped with `204` before it reaches your rules.
- `doc-sync setup` grants the trigger service account exactly `roles/eventarc.eventReceiver` on the project and `roles/run.invoker` on the one Cloud Run service — nothing else.
- The function's own runtime service account (what `onRequest` / Cloud Run runs as, separate from the trigger SA) needs Firestore read/write, typically `roles/datastore.user`, and executes your `build` / `patch` code. Use a dedicated service account rather than the default compute one.
- Fan-out has no per-event cap: a single rule can touch an unbounded number of targets. `validate`'s warnings, `maxInstances` and `timeoutSeconds` are the controls; size them for the worst case one event can cause.
- `deploy` only manages triggers labelled `doc-sync-instance=<name>` in `region`; two configs with the same `name` deployed to the same project and region will fight over the same triggers.
- The CLI runs `gcloud` and `firebase` as argument arrays, never through a shell on POSIX (quoted for the shell only on Windows), and loads the config file with `jiti`. The config is your own code and runs with your own credentials, like any other local script.
- `verify` output — on stdout and in the `Mismatch` objects passed to `onMismatch` — contains the actual document field values, which may be personal data; treat it accordingly in CI logs.

## Recommended function settings

| Setting | Value | Why |
|---|---|---|
| `cpu` | 1 | Required for `concurrency > 1`; the work is I/O bound |
| `memory` | 512MiB | Target queries are paged, so memory is bounded |
| `concurrency` | 80 | Mostly waiting on Firestore |
| `minInstances` | 1 | Avoids cold starts (optional) |
| `maxInstances` | 10 | Caps write bursts against Firestore |
| `timeoutSeconds` | 300 | Room for large fan-outs; below Eventarc's 600s ack deadline |
| `invoker` | the trigger SA email | Required; without it the function is public |

Tune after watching Cloud Run CPU, memory, latency and instance count.
