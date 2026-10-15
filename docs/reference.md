# Reference

[README](../README.md) · [Config](#config) · [Handler](#handler) · [CLI](#cli) · [Processing](#how-a-change-is-processed) · [Logs](#logs) · [Cost estimate](#cost-estimate) · [Limitations](#known-limitations) · [Security](#security) · [Function settings](#recommended-function-settings)

## Config

The config file (e.g. `functions/src/doc-sync.config.ts`; any name, passed with `--config`) exports `defineConfig({ ... })`. TypeScript or JavaScript, ESM or CJS. Complete example: [examples/functions/src/doc-sync.config.ts](../examples/functions/src/doc-sync.config.ts).

| Key | Meaning |
|---|---|
| `name` | Instance name (`[a-z][a-z0-9-]*`). Unique per project and region. |
| `region` | Eventarc location = Firestore database location (`asia-northeast1`, `nam5`, ...) |
| `database` | Firestore database ID. Default `(default)` |
| `service` | Cloud Run service name of the function (for `onRequest`: the function name, lower-cased) |
| `serviceRegion` | Cloud Run region. Default `region`; required when `region` is a multi-region (`nam5`, `eur3`) |
| `serviceAccount` | Trigger service account; a bare ID becomes `<id>@<project>.iam.gserviceaccount.com` |
| `rules[]` | The rules, in any order: `defineConnection(...)`, `defineAggregate(...)`, `defineView(...)`, `defineProjection(...)` (or objects with a `kind`) |

### Resource names

| Resource | Name |
|---|---|
| Eventarc trigger | `<instance>-<collection>-<hash>` |
| Cloud Scheduler job | `<instance>-<rule>-<hash>` |
| Cloud Tasks queue | `<instance>-schedule` |

`<hash>` is 8 characters derived from the instance and the collection or rule. It keeps names unique across instances and within the 63-character limit. Long names are shortened before the hash. `deploy` finds its own resources by an ownership marker, not by name, so you never type these names.

```ts
export default defineConfig({
  name: 'doc-sync', region: 'asia-northeast1', service: 'docsync', serviceAccount: 'doc-sync-trigger',
  rules: [defineConnection({ ... }), defineAggregate({ ... }), defineView({ ... })],
})
```

Rules may live in other files and be spread into `rules` (`rules: [...postRules, ...userRules]`).

Collections are paths with placeholders for parent IDs: `users/{uid}/posts`. Fields may be dotted: `address.city`.

### `defineConnection`: copy `fields` of `source/{id}` into `target.targetField` where `target.idField == id`

| Key | Meaning |
|---|---|
| `source`, `target` | Collections. Every placeholder of `source` must appear in `target`; extra `target` placeholders mean a collection-group query |
| `idField` | String field on the target holding the source ID |
| `fields` | Source fields to copy (missing ones are omitted) |
| `targetField` | Target field that receives `{ ...fields }` |
| `onSourceDelete` | When the source is missing: `'setNull'`, `'deleteField'` or `'nothing'` |

### `defineAggregate`: keep `target.targetField` = `count()` or `sum(field)` over the sources that belong to the target

| Key | Meaning |
|---|---|
| `source`, `target` | Collections |
| `idField` *or* `idParam` | How a source names its target: a string field on the source, or a placeholder of `source` (`post/{postId}/like` + `idParam: 'postId'`) |
| `aggregate` | `'count'` or `{ sum: '<numeric field>' }` |
| `targetField` | Numeric target field |

### Three ways a rule runs

| Mode | Trigger | Delay | Best for |
|---|---|---|---|
| Immediate (default) | Every matching Firestore event | None | Most rules |
| `defer` | A Cloud Tasks task, once per interval | Up to one interval | Hot documents, bursty writes |
| `schedule` | A Cloud Scheduler cron | Up to one cron interval | Large fan-outs, nightly aggregates, lag-tolerant reads |

### `schedule`: sync on a timer instead of on events

Any rule may carry `schedule: '<unix-cron>'` (5 fields) and an optional `timeZone` (IANA, default `Etc/UTC`). Such a rule is never processed on Firestore events; instead `deploy` creates a Cloud Scheduler job `<instance>-<rule>-<hash>` that calls `POST <service url>/schedule/<rule>` with the trigger service account's OIDC token, and the handler runs `rebuild` for that one rule. Collections used only by scheduled rules get no Eventarc trigger.

| Key | Meaning |
|---|---|
| `schedule` | Cloud Scheduler unix-cron, e.g. `'0 3 * * *'`. The rule's `name` must match `[A-Za-z0-9_-]` (it becomes the job name and URL segment) |
| `timeZone` | IANA time zone for the cron. Default `Etc/UTC` |

- Consistency becomes "eventually, within the cron interval plus one run". Writes are still `update(..., { lastUpdateTime })`, so a scheduled run never overwrites a concurrent event-driven write with stale data.
- Each run is time-boxed (`schedule.budgetMs` on `createDocSyncHandler`, default 20 minutes; Cloud Scheduler waits at most 30). When the budget runs out the run stops at a page boundary and enqueues a **continuation**: a Cloud Tasks task in the queue `<instance>-schedule` (in `serviceRegion`) that calls the same `/schedule/<rule>` URL with `{ startAfter, runId, chunk, startedAt }` in the body, so the pass continues where it stopped. Task ids are `<rule>-<runId>-<chunk>`; a duplicate id (a retried chunk) is ignored. If the task cannot be enqueued, the run answers `continued: false` and the next scheduled run starts from the beginning.
- The continuation needs: the queue (created by `setup`), and on the function's runtime service account `roles/cloudtasks.enqueuer` on the queue and `roles/iam.serviceAccountUser` on the trigger service account (`setup --runtime-service-account <email>` grants both). The handler finds the project from `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` / the Firestore client and the service URL from the request's `host` header; override with `schedule.project` / `schedule.serviceUrl`. `schedule.continue: false` turns the continuation off; `schedule.enqueue` replaces the Cloud Tasks call (tests, emulator, other platforms).
- The queue retries a failed continuation up to 5 times with at least 60 s backoff; a continuation for a rule that is no longer scheduled gets 404 and stops after those attempts.
- A pass longer than the cron interval overlaps the next one: in steady state about (pass duration ÷ cron interval) chains run at once, multiplying reads and competing for `maxInstances`. Choose a cron interval longer than a full pass (watch `durationMs` and `chunk` in the run logs). If the function answers 429/503, Cloud Tasks retries a chunk up to 5 times (≥ 60 s apart) and then drops it; the chain ends silently — only the Cloud Tasks logs show it — and the next cron starts over.
- Emulator: there is no Cloud Tasks emulator. Pass `schedule.enqueue` a function that calls the handler again with the task's `body` as the request body (the test suite does this), or run `doc-sync rebuild --rule <name>` which has no budget.
- To run a scheduled rule by hand or against the emulator: `doc-sync rebuild --rule <name>`, or `POST /schedule/<name>` on the function (no CloudEvent headers needed).
- Schedule or events, never both: a scheduled rule ignores target creation too, so its fields appear on the first run after the target exists.
- Set the function's `timeoutSeconds` above the budget: 300 for event-only deployments; ≥ `schedule.budgetMs` (default 20 min → 1800) once a rule is scheduled (see [Recommended function settings](#recommended-function-settings)). Otherwise the platform cuts a long run before it can stop cleanly.
- The job retries a failed run (HTTP 500) up to 3 times with at least 60 s backoff; runs are idempotent, so retries are safe.

### `defer`: mark on events, recompute once per interval

Any rule may carry `defer: '<duration>'` (`'90s'`, `'10m'`, `'1h'`, `'1h30m'`; 10 seconds to 24 hours) instead of `schedule`. An event marks what changed instead of recomputing it; a Cloud Tasks task recomputes it once per interval.

| Key | Meaning |
|---|---|
| `defer` | How often a marked unit is recomputed, e.g. `'10m'`. Not with `schedule` |

| Dirty unit | Marked by | Recomputed |
|---|---|---|
| `source` | A connection source, or a view `refField` source, changing (one task covers the whole fan-out) | That source's targets, fresh |
| `target` | An aggregate source, a view `idField` / `idParam` source, or an existing target or base, changing | That one target, fresh |
| (immediate, not deferred) | A base created or deleted, a target's first value, or a hand-deleted base-view target | Right away, same as a rule without `defer` |

- Skip checks (unchanged fields, unchanged `watch` fields, ...) run first, so an irrelevant write marks nothing.
- If the task cannot be queued, the event answers 500 and Eventarc retries it.
- A flush that keeps failing is retried by the queue up to 5 times, then dropped. `verify --fix` repairs such a target.
- Needs the same Cloud Tasks queue and grants as the schedule continuation above; `setup` creates the queue when any rule has `schedule` or `defer`.
- A custom `schedule.enqueue` must honour `scheduleTime` and treat a duplicate `id` as success.
- Flush: `POST /schedule/<rule>` with body `{ "flush": { "unit": "source" | "target", "path": "..." } }` recomputes that one unit and answers the same JSON as a processed event, plus `flush` and `durationMs`. A `flush` for a rule without `defer` gets 404; a `defer` rule called without `flush` gets 400.
- Emulator: there is no Cloud Tasks emulator. Pass `schedule.enqueue` to `createDocSyncHandler` and post each task's `body` to `/schedule/<rule>` yourself (the test suite does this).

### `defineView`: keep the declared `targetFields` of `target` = the matching paths of `build(...)`

The general form. `defineConnection`, `defineAggregate` and `defineProjection` are shorthands for views of a fixed shape.

| Key | Meaning |
|---|---|
| `target` | Collection holding the derived fields |
| `targetFields` | Field paths this view writes, e.g. `['title', 'stats.commentCount', 'profile']`. Only these paths are taken from the `build` result; a path whose value is `undefined` is deleted. `'rest'` (needs `base`) adds every root key no rule declares |
| `base?` | Collection whose document with the same ID decides whether the target exists (below). Same placeholders as `target` |
| `sources` | Object keyed by the names `build` sees, each a source below. Optional when `base` is set |
| `build({ target, base, sources, firestore })` | Returns an object holding the declared paths, nested (`{ stats: { commentCount: 3 } }`), or `undefined` to delete them all. Must be deterministic. `sources.<key>` is `QueryDocumentSnapshot[]`; `base` is the base document (always exists when `build` runs) |
| `patch?(current, change, { target, base, firestore })` | Optional fast path: derive the new values from the current ones (same shape as the `build` result, plus the `rest` keys) and one changed source document (one fresh read) instead of reading every source; return `undefined` to fall back to `build`. Events can be delivered more than once and out of order, so `patch` must be idempotent and must only use `change.after` to decide what the item looks like, keyed by document id |

| Source key | Relation to the target | Extras |
|---|---|---|
| `idField: 'postId'` | Many-to-one: source field holds the target ID | `orderBy`, `limit`, `watch` |
| `idParam: 'postId'` | Many-to-one: sources under the target path | `orderBy`, `limit`, `watch` |
| `refField: 'authorId'` | One-to-one: target field holds the source ID (0 or 1 document) | `watch` |

- `orderBy`: `['createdAt', ['score', 'desc']]`. `limit`: max documents read. `watch`: source fields that trigger a recompute (default: any change); `idField` and `orderBy` fields are always watched. Every change of the `base` document triggers a recompute.
- Writes: one `update()` of the declared paths whose value differs, conditional on the target's `updateTime`. Fields outside `targetFields` are never touched. Paths in the result that are not declared are logged once (`warn`) and ignored. A result key written literally as a dotted path equal to a declared path (`{ 'stats.count': 3 }`) is accepted as that path.
- `base`: `target/{id}` exists exactly when `base/{id}` exists, judged by a fresh read on every event of the base, of a source, and on target creation or deletion (a plain update of the target does not re-check the base). A missing target is created with `create()`; a target whose base is gone is deleted with `delete({ lastUpdateTime })`. Subcollections of a deleted target are not deleted (Firestore semantics). Several views may share one `base` for a target; `validate` requires them to agree. Other rules on that target skip while it does not exist and catch up on the create event.
- On a target with `base`, a field another rule uses as an id (`idField` / `refField`) cannot be written by any rule and is not covered by `'rest'`; it is lost when the target is removed and recreated. Keep such ids on the base and derive them with `targetFields` instead.
- `'rest'`: owns every root key of the target that no rule writes or uses as an id. Such keys in the `build` result are written; such keys on the target that the result lacks are deleted. Only on a view with `base`.
- `build` / `patch` results: `undefined` map entries are dropped, `undefined` array elements become `null`.
- `change.after` is a fresh read of the changed document (`undefined` if it was deleted or no longer belongs to this target). `patch` must be idempotent and key items by document ID.
- Target side: recomputed on create, when a `refField` changes, when a declared path was removed, and, with `base`, when the target was deleted (it is recreated while the base exists). Other target fields `build` reads are not watched.
- `rebuild` / `verify` always use `build`. For a view with `base` they walk the base collection first (creating / checking targets), then the target collection (removing / reporting targets whose base is gone). `verify` reports each finding with `issue: 'value' | 'missing' | 'orphan'`.
- Rules run in config order grouped connections → aggregates → views, so on a fresh database (no triggers yet) a base view's targets are created only once the pass reaches that view, after any aggregate or connection rule earlier in the list already ran against targets that did not exist yet: run `rebuild` a second time, or rebuild the base view first with `--rule`.
- The typed config cannot express that `'rest'` requires `base`, or that a view needs `base` or at least one source; `validate` reports both at runtime.

### `defineProjection`: a view with `base` and no `build`

| Key | Meaning |
|---|---|
| `base` | Collection to mirror |
| `target` | Collection receiving `target/{id}` for every `base/{id}`. Same placeholders as `base` |
| `targetFields` | Paths copied from the base as they are. `'rest'` is not supported |

Lifecycle as a view with `base`: the target is created when the base exists, deleted when it is gone, and a path missing on the base is deleted on the target. Put aggregates or views on `target` for derived fields. Logged as `kind: 'projection'`.

### Validation

`validateConfig` (run by every CLI command) rejects duplicate names, overlapping writes to one collection, unresolvable placeholders, patterns that match the same documents, and rule loops.

### Typed config

```ts
type Collections = { post: Post; category: Category; 'post/{postId}/comment': Comment }  // type alias, not interface
const { defineConfig, defineConnection, defineAggregate, defineView } = typed<Collections>()
```

Collection names, field paths, `idParam` and the `build` return type are checked against your document types at compile time. Both functions are identities at runtime.

## Handler

```ts
createDocSyncHandler(config, { firestore, logger, maxRetries, pageSize, schedule })
```

| Option | Default | Meaning |
|---|---|---|
| `firestore` | `getFirestore()` | Firestore instance |
| `logger` | JSON to stdout | Anything with `info` / `warn` / `error`; `console` works |
| `maxRetries` | 5 | Redos of a target whose conditional write failed |
| `pageSize` | 500 | Target query page size |
| `schedule: { budgetMs, concurrency, project, serviceUrl, enqueue, continue }` | `budgetMs` 20 minutes, `concurrency` 20, `continue` `true` | Options for `/schedule/<rule>` runs: `budgetMs` is the time box; `concurrency` is targets processed in parallel within a page. A budget-stopped run enqueues a Cloud Tasks continuation unless `continue: false`; `project` / `serviceUrl` override the GCP project of the queue and this service's public URL (defaults: `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` / the Firestore client's project; the request's `host` header); `enqueue` replaces the Cloud Tasks call (tests, emulator, other platforms); for deferred rules it must honour the task's `scheduleTime` |

Within one event, a source document is read once; a read older than the target it is combined with is never reused.

The handler is `(req, res) => Promise<void>` and also works with Express or Node's `http`.

`POST /schedule/<rule>` runs that scheduled rule and answers JSON `{ rule, runId, chunk, scanned, written, completed, continued, lastPath, reads, queries, aggregations, durationMs }` (200), `404` for an unknown or event-driven rule, `405` for a method other than POST, `500` on failure with `{ error, runId, chunk }` (Cloud Scheduler retries the first chunk, Cloud Tasks retries a continuation chunk). The body may carry a continuation `{ startAfter, runId, chunk, startedAt }` to resume a budget-stopped pass; `runId` identifies the pass, `chunk` is `0` for the Scheduler's own call then `1`, `2`, ..., and `continued` says whether this run enqueued a further chunk. Pass `req.url` through (Express does).

## CLI

| Command | Does |
|---|---|
| `validate [--strict]` | Checks the config; prints triggers, cost estimate, write chains, warnings, and (when a rule is scheduled or deferred) `continuation queue: <instance>-schedule (<serviceRegion>)`. `--strict` fails on warnings |
| `setup [--runtime-service-account <email>]` | Creates the trigger SA, grants `roles/eventarc.eventReceiver` (project) and `roles/run.invoker` (service), enables APIs; enables the Cloud Scheduler API when a rule is scheduled, the Cloud Tasks API when a rule is scheduled or deferred, and creates the continuation queue or updates its retry policy when it drifted (`--max-attempts=5 --min-backoff=60s`). With `--runtime-service-account <email>`, also grants that SA `roles/cloudtasks.enqueuer` on the queue and `roles/iam.serviceAccountUser` on the trigger SA (needed to enqueue continuations and deferred flushes); without it, prints the two `gcloud` commands to run by hand. Idempotent; the invoker grant is skipped until the service exists, so rerun after the first deploy |
| `deploy [--deploy-function <name>]` | Creates missing Eventarc triggers (for collections of event-driven rules), updates drifted ones (service, service region, path pattern, SA), deletes stale ones; only triggers labelled `doc-sync-instance=<name>` in `region`. Likewise creates / updates / deletes the Cloud Scheduler jobs of scheduled rules (identified by description `doc-sync-instance=<name>` in `serviceRegion`); jobs need the Cloud Run service URL, so run it after the first function deploy. Optionally runs `firebase deploy` first |
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
| View base changed | document unchanged | re-read the target, then the base. Base gone: delete the target. Target missing: `build` and `create()`. Otherwise `build` and write the differing paths |
| View source changed | `watch` fields (or the whole document) unchanged | for each target: re-read it (and its base; a missing base deletes the target, a missing target is created), then `patch` with a fresh read of the changed document, or `build` over fresh reads of all sources |
| View target changed | not a create, no `refField` changed, every declared path still present; with `base`: also skipped unless deleted | `build`; with `base`, a deleted target is recreated while the base exists |

- Every field write is `update(..., { lastUpdateTime })` with the `updateTime` read before the sources; targets of base views are created with `create()` and removed with `delete({ lastUpdateTime })`. A failed precondition (or `ALREADY_EXISTS`) redoes that target from a fresh read, up to `maxRetries`, then the request fails with 500.

| Response | When |
|---|---|
| `204` | Done or nothing to do; also undecodable payload, unknown collection, other database, non-Firestore `ce-type`, body over 16 MiB, nesting over 20 levels (logged, not retried) |
| `500` | Transient failure, retries exhausted, or user code threw; Eventarc redelivers with backoff for up to 24 hours |

## Logs

One JSON line per rule per event: `eventId`, `rule`, `kind`, `source` (view source key), `document`, `role`, `action` (`skip` / `write` / `delete` / `defer`, the last with `deferred` = number of marked documents), `reason`, `targets`, `writes`, `retries`, `reads`, `queries`, `aggregations`, `durationMs` (whole event). A failed rule logs `doc-sync: failed, will be retried by Eventarc` with `error`. A deferred rule also logs `doc-sync: deferred` (a unit was marked), `doc-sync: flushed` (a flush ran), and `doc-sync schedule: flush failed`.

## Cost estimate

`validate` prints per rule the reads and writes one event causes, as formulas over `N` (matching targets) and `M` (source documents per target), and warns about `refField` view sources (fan-out) and many-to-one view sources with neither `limit` nor `patch`. `--strict` turns warnings into exit code 1.

A scheduled rule shows one line `schedule <cron> (<tz>): every <target>` with reads `T × (per-target reads)` and writes `≤ T`, T being the number of targets.

A deferred rule's marking events show `0 (+ 1 task)` reads (or `≤ 2 tasks`) and `0` writes, each with a matching `flush <collection>/{id} (≤ 1 per <interval>)` line carrying the recompute's reads and writes. Lifecycle lines (a target's first value, a base created or deleted) keep their immediate cost.

## Known limitations

- Targets are not deleted when the source is deleted; use `setNull` or `deleteField`.
- A `targetField` overwritten by the application keeps the wrong value until the source changes or `rebuild` / `verify --fix`; a removed one is repaired on the next event.
- Target queries need the single-field index on `idField`; collection-group queries (`validate` lists them) need a collection-group index; `idField` + `orderBy` in a view needs a composite index. Firestore prints the creation link on first use.
- Permanent failures in `build` / `patch` or a missing index return 500 and are redelivered for up to 24 hours; watch the `doc-sync: failed` log line.

## Security

- The handler does not authenticate. Restrict invocation to the trigger SA: `invoker:` in `onRequest`, or `--no-allow-unauthenticated` + `roles/run.invoker` on Cloud Run. Without it the function is public.
- A forged or replayed request can force recomputation: reads, writes of correct values, scheduled and deferred runs. Values are re-read from the real sources. `patch` gets `change.after` from a fresh, membership-checked read, but `change.before` is the request payload and may be forged: never derive values from it.
- Continuation and flush tasks call back at `https://<Host header>`. If the service is reachable under any host other than its run.app URL, set `schedule.serviceUrl`.
- Scheduler jobs call the function with the trigger service account's OIDC token; the same `invoker` restriction covers them. The `/schedule/<rule>` route does no authentication of its own.
- Continuation tasks call back with the same trigger service account's OIDC token, so the same `invoker` restriction covers them too.
- `setup` grants the trigger SA `roles/eventarc.eventReceiver` on the project and `roles/run.invoker` on the service. With `--runtime-service-account`, it also grants the runtime SA `roles/cloudtasks.enqueuer` on the queue and `roles/iam.serviceAccountUser` on the trigger SA, so every workload running as the runtime SA can act as the trigger SA.
- The function's runtime SA needs Firestore read/write (`roles/datastore.user`) and runs your `build` / `patch`; use a dedicated SA, not the default compute one.
- Fan-out has no per-event cap; control it with `validate` warnings, `maxInstances`, `timeoutSeconds`.
- `verify` output and `Mismatch` objects contain document values. Logs contain document paths and ids, and the messages of errors thrown by `build` / `patch`.

## Recommended function settings

| Setting | Value | Why |
|---|---|---|
| `cpu` | 1 | Required for `concurrency > 1`; the work is I/O bound |
| `memory` | 512MiB | Target queries are paged |
| `concurrency` | 80 | Mostly waiting on Firestore |
| `minInstances` | 1 | Avoids cold starts (optional) |
| `maxInstances` | 10 | Caps write bursts |
| `timeoutSeconds` | 300 (≥ `schedule.budgetMs` once a rule is scheduled) | 300 for event-only deployments (below Eventarc's 600 s ack deadline); ≥ `schedule.budgetMs` (default 20 min → 1800) once a rule is scheduled |
| `invoker` | trigger SA email | Required; otherwise public |
