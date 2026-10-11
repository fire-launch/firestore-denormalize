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
- `change.after` is a fresh read of the changed document (`undefined` if it was deleted or no longer belongs to this target). `patch` must be idempotent and key items by document ID.
- Target side: recomputed on create, when a `refField` changes, and when `targetField` was removed. Other target fields `build` reads are not watched.
- `rebuild` / `verify` always use `build`.

### Validation

`validateConfig` (run by every CLI command) rejects duplicate names, overlapping writes to one collection, unresolvable placeholders, patterns that match the same documents, and rule loops.

### Typed config

```ts
type Collections = { post: Post; category: Category; 'post/{postId}/comment': Comment }  // type alias, not interface
const { defineConfig, defineView } = typed<Collections>()
```

Collection names, field paths, `idParam` and the `build` return type are checked against your document types at compile time. Both functions are identities at runtime.

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

The handler is `(req, res) => Promise<void>` and also works with Express or Node's `http`.

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
- Changing `region` leaves the old triggers in place; delete them by hand or run `deploy` with the old config first.

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

| Response | When |
|---|---|
| `204` | Done or nothing to do; also undecodable payload, unknown collection, other database, non-Firestore `ce-type`, body over 16 MiB, nesting over 20 levels (logged, not retried) |
| `500` | Transient failure, retries exhausted, or user code threw; Eventarc redelivers with backoff for up to 24 hours |

## Logs

One JSON line per rule per event: `eventId`, `rule`, `kind`, `source` (view source key), `document`, `role`, `action` (`skip` / `write` / `delete`), `reason`, `targets`, `writes`, `retries`, `reads`, `queries`, `aggregations`, `durationMs` (whole event). A failed rule logs `doc-sync: failed, will be retried by Eventarc` with `error`.

## Cost estimate

`validate` prints per rule the reads and writes one event causes, as formulas over `N` (matching targets) and `M` (source documents per target), and warns about `refField` view sources (fan-out) and many-to-one view sources with neither `limit` nor `patch`. `--strict` turns warnings into exit code 1.

## Known limitations

- Targets are not deleted when the source is deleted; use `setNull` or `deleteField`.
- A `targetField` overwritten by the application keeps the wrong value until the source changes or `rebuild` / `verify --fix`; a removed one is repaired on the next event.
- Target queries need the single-field index on `idField`; collection-group queries (`validate` lists them) need a collection-group index; `idField` + `orderBy` in a view needs a composite index. Firestore prints the creation link on first use.
- Permanent failures in `build` / `patch` or a missing index return 500 and are redelivered for up to 24 hours; watch the `doc-sync: failed` log line.

## Security

- The handler does not authenticate. Restrict invocation to the trigger SA: `invoker:` in `onRequest`, or `--no-allow-unauthenticated` + `roles/run.invoker` on Cloud Run. Without it the function is public.
- A forged or replayed request can only force recomputation (reads). Values are re-read from the real sources; `patch` gets a fresh, membership-checked read, never request data.
- `setup` grants the trigger SA exactly `roles/eventarc.eventReceiver` on the project and `roles/run.invoker` on the service.
- The function's runtime SA needs Firestore read/write (`roles/datastore.user`) and runs your `build` / `patch`; use a dedicated SA, not the default compute one.
- Fan-out has no per-event cap; control it with `validate` warnings, `maxInstances`, `timeoutSeconds`.
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
