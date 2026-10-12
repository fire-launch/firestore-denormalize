# Reference

[README](../README.md) · [Config](#config) · [Handler](#handler) · [CLI](#cli) · [Processing](#how-a-change-is-processed) · [Logs](#logs) · [Cost estimate](#cost-estimate) · [Limitations](#known-limitations) · [Security](#security) · [Function settings](#recommended-function-settings)

## Config

The config file (e.g. `functions/src/doc-sync.config.ts`; any name, passed with `--config`) exports `defineConfig({ ... })`. TypeScript or JavaScript, ESM or CJS. Complete example: [examples/functions/src/doc-sync.config.ts](../examples/functions/src/doc-sync.config.ts).

| Key | Meaning |
|---|---|
| `name` | Instance name; prefix of trigger names (`[a-z][a-z0-9-]*`) |
| `region` | Eventarc location = Firestore database location (`asia-northeast1`, `nam5`, ...) |
| `database` | Firestore database ID. Default `(default)` |
| `service` | Cloud Run service name of the function (for `onRequest`: the function name, lower-cased) |
| `serviceRegion` | Cloud Run region. Default `region`; required when `region` is a multi-region (`nam5`, `eur3`) |
| `serviceAccount` | Trigger service account; a bare ID becomes `<id>@<project>.iam.gserviceaccount.com` |
| `rules[]` | The rules, in any order: `defineConnection(...)`, `defineAggregate(...)`, `defineView(...)`, `defineProjection(...)` (or objects with a `kind`) |

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

### `schedule`: sync on a timer instead of on events

Any rule may carry `schedule: '<unix-cron>'` (5 fields) and an optional `timeZone` (IANA, default `Etc/UTC`). Such a rule is never processed on Firestore events; instead `deploy` creates a Cloud Scheduler job `<instance>-<rule>` that calls `POST <service url>/schedule/<rule>` with the trigger service account's OIDC token, and the handler runs `rebuild` for that one rule. Collections used only by scheduled rules get no Eventarc trigger.

| Key | Meaning |
|---|---|
| `schedule` | Cloud Scheduler unix-cron, e.g. `'0 3 * * *'`. The rule's `name` must match `[A-Za-z0-9_-]` (it becomes the job name and URL segment) |
| `timeZone` | IANA time zone for the cron. Default `Etc/UTC` |

- Consistency becomes "eventually, within the cron interval plus one run". Writes are still `update(..., { lastUpdateTime })`, so a scheduled run never overwrites a concurrent event-driven write with stale data.
- Each run is time-boxed (`schedule.budgetMs` on `createDocSyncHandler`, default 20 minutes; Cloud Scheduler waits at most 30). When the budget runs out the run stops at a page boundary and answers `completed: false` with `lastPath`; the next scheduled run starts from the beginning. For collections too large for one run, split the rule or wait for the resumable version (planned).
- To run a scheduled rule by hand or against the emulator: `doc-sync rebuild --rule <name>`, or `POST /schedule/<name>` on the function (no CloudEvent headers needed).
- Schedule or events, never both: a scheduled rule ignores target creation too, so its fields appear on the first run after the target exists.
- Set the function's `timeoutSeconds` above the budget (the README example uses 1800); otherwise the platform cuts a long run before it can stop cleanly.

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
| `schedule: { budgetMs, concurrency }` | `budgetMs` 20 minutes, `concurrency` 20 | Options for `/schedule/<rule>` runs: `budgetMs` is the time box; `concurrency` is targets processed in parallel within a page |

The handler is `(req, res) => Promise<void>` and also works with Express or Node's `http`.

`POST /schedule/<rule>` runs that scheduled rule and answers JSON `{ rule, scanned, written, completed, lastPath, reads, queries, aggregations, durationMs }` (200), `404` for an unknown or event-driven rule, `500` on failure (Cloud Scheduler retries). Pass `req.url` through (Express does).

## CLI

| Command | Does |
|---|---|
| `validate [--strict]` | Checks the config; prints triggers, cost estimate, write chains, warnings. `--strict` fails on warnings |
| `setup` | Creates the trigger SA, grants `roles/eventarc.eventReceiver` (project) and `roles/run.invoker` (service), enables APIs; enables the Cloud Scheduler API when a rule is scheduled. Idempotent; the invoker grant is skipped until the service exists, so rerun after the first deploy |
| `deploy [--deploy-function <name>]` | Creates / updates / deletes the Eventarc triggers of event-driven rules and the Cloud Scheduler jobs of scheduled rules (diff-based; `--dry-run` prints the commands). Jobs need the Cloud Run service URL, so run it after the first function deploy |
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

One JSON line per rule per event: `eventId`, `rule`, `kind`, `source` (view source key), `document`, `role`, `action` (`skip` / `write` / `delete`), `reason`, `targets`, `writes`, `retries`, `reads`, `queries`, `aggregations`, `durationMs` (whole event). A failed rule logs `doc-sync: failed, will be retried by Eventarc` with `error`.

## Cost estimate

`validate` prints per rule the reads and writes one event causes, as formulas over `N` (matching targets) and `M` (source documents per target), and warns about `refField` view sources (fan-out) and many-to-one view sources with neither `limit` nor `patch`. `--strict` turns warnings into exit code 1.

A scheduled rule shows one line `schedule <cron> (<tz>): every <target>` with reads `T × (per-target reads)` and writes `≤ T`, T being the number of targets.

## Known limitations

- Targets are not deleted when the source is deleted; use `setNull` or `deleteField`.
- A `targetField` overwritten by the application keeps the wrong value until the source changes or `rebuild` / `verify --fix`; a removed one is repaired on the next event.
- Target queries need the single-field index on `idField`; collection-group queries (`validate` lists them) need a collection-group index; `idField` + `orderBy` in a view needs a composite index. Firestore prints the creation link on first use.
- Permanent failures in `build` / `patch` or a missing index return 500 and are redelivered for up to 24 hours; watch the `doc-sync: failed` log line.

## Security

- The handler does not authenticate. Restrict invocation to the trigger SA: `invoker:` in `onRequest`, or `--no-allow-unauthenticated` + `roles/run.invoker` on Cloud Run. Without it the function is public.
- A forged or replayed request can only force recomputation (reads). Values are re-read from the real sources; `patch` gets a fresh, membership-checked read, never request data.
- Scheduler jobs call the function with the trigger service account's OIDC token; the same `invoker` restriction covers them. The `/schedule/<rule>` route does no authentication of its own.
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
