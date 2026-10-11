# Reference

[README](../README.md) · [Config](#config) · [Handler](#handler) · [CLI](#cli) · [Processing](#how-a-change-is-processed) · [Logs](#logs) · [Cost estimate](#cost-estimate) · [Limitations](#known-limitations) · [Security](#security) · [Function settings](#recommended-function-settings)

## Config

`functions/src/doc-sync.config.ts` exports `defineConfig({ ... })`. TypeScript or JavaScript, ESM or CJS. Complete example: [examples/functions/doc-sync.config.ts](../examples/functions/doc-sync.config.ts).

| Key | Meaning |
|---|---|
| `name` | Instance name; prefix of trigger names (`[a-z][a-z0-9-]*`) |
| `region` | Eventarc location = Firestore database location (`asia-northeast1`, `nam5`, ...) |
| `database` | Firestore database ID. Default `(default)` |
| `service` | Cloud Run service name of the function (for `onRequest`: the function name, lower-cased) |
| `serviceRegion` | Cloud Run region. Default `region`; required when `region` is a multi-region (`nam5`, `eur3`) |
| `serviceAccount` | Trigger service account; a bare ID becomes `<id>@<project>.iam.gserviceaccount.com` |
| `connections[]` `aggregates[]` `views[]` | Rules, see below |

Collections are paths with placeholders for parent IDs: `users/{uid}/posts`. Fields may be dotted: `address.city`.

### `connections[]`: copy `fields` of `source/{id}` into `target.targetField` where `target.idField == id`

| Key | Meaning |
|---|---|
| `source`, `target` | Collections. Every placeholder of `source` must appear in `target`; extra `target` placeholders mean a collection-group query |
| `idField` | String field on the target holding the source ID |
| `fields` | Source fields to copy (missing ones are omitted) |
| `targetField` | Target field that receives `{ ...fields }` |
| `onSourceDelete` | When the source is missing: `'setNull'`, `'deleteField'` or `'nothing'` |

### `aggregates[]`: keep `target.targetField` = `count()` or `sum(field)` over the sources that belong to the target

| Key | Meaning |
|---|---|
| `source`, `target` | Collections |
| `idField` *or* `idParam` | How a source names its target: a string field on the source, or a placeholder of `source` (`post/{postId}/like` + `idParam: 'postId'`) |
| `aggregate` | `'count'` or `{ sum: '<numeric field>' }` |
| `targetField` | Numeric target field |

### `views[]`: keep `target.targetField` = `build(...)`

| Key | Meaning |
|---|---|
| `target`, `targetField` | Collection and field receiving the value |
| `sources` | Object keyed by the names `build` sees, each a source below |
| `build({ target, sources, firestore })` | Returns the value, or `undefined` to delete the field. Must be deterministic. `sources.<key>` is `QueryDocumentSnapshot[]` |
| `patch?(current, change, { target, firestore })` | Optional fast path from the current value and one changed document; return `undefined` to fall back to `build` |

| Source key | Relation to the target | Extras |
|---|---|---|
| `idField: 'postId'` | Many-to-one: source field holds the target ID | `orderBy`, `limit`, `watch` |
| `idParam: 'postId'` | Many-to-one: sources under the target path | `orderBy`, `limit`, `watch` |
| `refField: 'authorId'` | One-to-one: target field holds the source ID (0 or 1 document) | `watch` |

- `orderBy`: `['createdAt', ['score', 'desc']]`. `limit`: max documents read. `watch`: source fields that trigger a recompute (default: any change); `idField` and `orderBy` fields are always watched.
- `build` / `patch` results: `undefined` map entries are dropped, `undefined` array elements become `null`.
- `change.after` is a fresh read of the changed document, `undefined` if it was deleted or no longer belongs to this target. `change.before` is the event's previous state. `patch` must be idempotent and key items by document ID; `firestore` is for a small extra read (e.g. `limit(1)` to refill a latest-N list).
- Target side: recomputed on create, when a `refField` changes, and when `targetField` was removed. Other target fields `build` reads are not watched.
- `rebuild` / `verify` always use `build`.

### Validation

`validateConfig` (and every CLI command) rejects: duplicate rule names; two rules writing overlapping fields of one collection; a written field used as `idField` / `refField`; unresolvable placeholders; a collection-group aggregate whose target has placeholders; malformed or reserved IDs and field names (`__x__`, `.`, `..`); two patterns matching the same documents (`users/admin/posts` and `users/{uid}/posts`); loops where one rule's write triggers the next back around; colliding trigger names (collection IDs lower-cased, `_` → `-`).

### Typed config

```ts
type Collections = { post: Post; category: Category; 'post/{postId}/comment': Comment }  // type alias, not interface
const { defineConfig, defineView } = typed<Collections>()
```

Checked at compile time: `source` / `target` / `collection` are keys of `Collections`; `fields`, `watch`, `orderBy` are field paths of that document (dotted, up to 5 levels); `idField` / `refField` are string fields; `sum` and aggregate `targetField` are numeric; `idParam` is a placeholder of the source path; a view's `targetField` exists on the target and `build` / `patch` return its type; `sources.<key>` is `QueryDocumentSnapshot<Doc>[]`. Both functions are identities at runtime.

## Handler

```ts
createDocSyncHandler(config, { firestore, logger, maxRetries, pageSize })
```

| Option | Default | Meaning |
|---|---|---|
| `firestore` | `getFirestore()` | Firestore instance |
| `logger` | JSON to stdout | Anything with `info` / `warn` / `error`; `console` works |
| `maxRetries` | 5 | Redos of a target whose conditional write failed |
| `pageSize` | 500 | Target query page size |

The handler is `(req, res) => Promise<void>`: works with `onRequest`, Express or Node's `http`. It does not depend on `firebase-functions`.

## CLI

| Command | Does |
|---|---|
| `validate [--strict]` | Checks the config; prints triggers, cost estimate, write chains, warnings. `--strict` fails on warnings |
| `setup` | Creates the trigger SA, grants `roles/eventarc.eventReceiver` (project) and `roles/run.invoker` (service), enables APIs. Idempotent; the invoker grant is skipped until the service exists, so rerun after the first deploy |
| `deploy [--deploy-function <name>]` | Creates missing triggers, updates drifted ones (service, service region, path pattern, SA), deletes stale ones; only triggers labelled `doc-sync-instance=<name>` in `region`. Optionally runs `firebase deploy` first |
| `rebuild [--dry-run] [--rule]... [--start-after]` | Walks every target and writes what a live event would. Missing sources follow `onSourceDelete` |
| `verify [--fix] [--rule]... [--start-after]` | Walks every target and reports mismatches (actual vs expected); `--fix` repairs them; exits 1 while a mismatch remains |
| `dev --url <handler>` | Bridges the Firestore emulator to the handler as CloudEvents. Emulator only |

- `--config` defaults to `./doc-sync.config.ts`; `--project` to `$GOOGLE_CLOUD_PROJECT`, then gcloud's active project.
- `rebuild` / `verify` / `dev` use Application Default Credentials, or the emulator when `FIRESTORE_EMULATOR_HOST` or `--emulator-host` is set.
- `--start-after` applies to the first rule processed: use it with `--rule`.
- `--dry-run`: `setup` / `deploy` print the `gcloud` commands; `rebuild` reports without writing.
- Changing `region` leaves the old triggers in place; delete them by hand or run `deploy` with the old config first.
- `verify` prints document values to stdout; the library log line carries only path and field.

## How a change is processed

Every rule whose `source` or `target` is the event's collection runs. Source-side work runs in parallel across rules; target-side work on the event's own document runs rule by rule.

| Event | Skipped when | Otherwise |
|---|---|---|
| Connection source changed | none of `fields` changed | query targets (`idField == id`) in pages; per page re-read the source and write differing targets via `BulkWriter` |
| Connection target changed | deleted, or `idField` unchanged and `targetField` still present | re-read target, then its source; empty `idField` deletes `targetField`; missing source follows `onSourceDelete` |
| Aggregate source changed | neither `idField` nor the summed field changed | for the old and new target: re-read, run the aggregation, write if different |
| Aggregate target changed | not a create and `targetField` still present | run the aggregation, write if different |
| View source changed | `watch` fields (or the whole document) unchanged | for each target: re-read it, then `patch` with a fresh read of the changed document, or `build` over fresh reads of all sources |
| View target changed | not a create, no `refField` changed, `targetField` still present | `build` |

- Every write is `update(..., { lastUpdateTime })` with the `updateTime` read before the sources. A failed precondition redoes that target from the read, up to `maxRetries`, then the request fails with 500.
- Values are compared deeply (`Timestamp`, `GeoPoint`, `DocumentReference`, bytes), so the handler's own writes are no-ops and chains like `area → shop.area → post.shop.area` terminate.

| Response | When |
|---|---|
| `204` | Done or nothing to do; also undecodable payload, unknown collection, other database, non-Firestore `ce-type`, body over 16 MiB, nesting over 20 levels (logged, not retried) |
| `500` | Transient failure, retries exhausted, or user code threw; Eventarc redelivers with backoff for up to 24 hours |

## Logs

One JSON line per rule per event: `eventId`, `rule`, `kind`, `source` (view source key), `document`, `role`, `action` (`skip` / `write` / `delete`), `reason`, `targets`, `writes`, `retries`, `reads`, `queries`, `aggregations`, `durationMs` (whole event). A failed rule logs `doc-sync: failed, will be retried by Eventarc` with `error`.

Read counters follow Firestore billing: 1 per document read (missing included), 1 per document a query returned (min 1 per query), aggregations separately. Reads inside `build` / `patch` count when made through the `firestore` in the context.

## Cost estimate

`validate` prints per rule the reads and writes one event causes as formulas over `N` (targets matching the changed source) and `M` (source documents of one target), e.g. `reads N + 1, writes ≤ N`. Reads inside `build` / `patch` show as `(+ reads inside build)`; the handler logs the real counts.

Warnings: a `refField` view source fans out (one change rebuilds every target pointing at it); a many-to-one view source without `limit` and without `patch` reads all `M` documents per event. `--strict` turns warnings into exit code 1.

## Known limitations

- Targets are not deleted when the source is deleted; use `setNull` or `deleteField`.
- A `targetField` overwritten by the application keeps the wrong value until the source changes or `rebuild` / `verify --fix`; a removed one is repaired on the next event.
- Target queries need the single-field index on `idField`; collection-group queries (`validate` lists them) need a collection-group index; `idField` + `orderBy` in a view needs a composite index. Firestore prints the creation link on first use.
- Cost per event: connections `N + 1` reads; aggregates one aggregation per affected target; views one target read plus one read per source document returned (≤ `limit`, else `M`), or 2 reads with `patch`.
- Permanent failures in `build` / `patch` or a missing index return 500 and are redelivered for up to 24 hours; watch the `doc-sync: failed` log line.
- Latency is Eventarc's (typically under a few seconds).

## Security

- The handler does not authenticate. Restrict invocation to the trigger SA: `invoker:` in `onRequest`, or `--no-allow-unauthenticated` + `roles/run.invoker` on Cloud Run. Without it the function is public.
- A forged or replayed request can only force recomputation (reads). Values are re-read from the real sources; `patch` gets a fresh, membership-checked read, never request data.
- Requests must carry a Firestore `ce-type`, stay under 16 MiB and 20 nesting levels; anything else is dropped with 204.
- `setup` grants the trigger SA exactly `roles/eventarc.eventReceiver` on the project and `roles/run.invoker` on the service.
- The function's runtime SA needs Firestore read/write (`roles/datastore.user`) and runs your `build` / `patch`; use a dedicated SA, not the default compute one.
- Fan-out has no per-event cap; control it with `validate` warnings, `maxInstances`, `timeoutSeconds`.
- Two configs with the same `name` in one project and region fight over the same triggers.
- The CLI runs `gcloud` / `firebase` with argument arrays (no shell on POSIX; quoted on Windows) and loads the config with `jiti`, with your credentials.
- `verify` output and `Mismatch` objects contain document values.

## Recommended function settings

| Setting | Value | Why |
|---|---|---|
| `cpu` | 1 | Required for `concurrency > 1`; the work is I/O bound |
| `memory` | 512MiB | Target queries are paged |
| `concurrency` | 80 | Mostly waiting on Firestore |
| `minInstances` | 1 | Avoids cold starts (optional) |
| `maxInstances` | 10 | Caps write bursts |
| `timeoutSeconds` | 300 | Room for fan-outs; below Eventarc's 600 s ack deadline |
| `invoker` | trigger SA email | Required; otherwise public |
