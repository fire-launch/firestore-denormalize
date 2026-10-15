# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.13.0] - 2026-10-15

### Added

- `doc-sync run <rule>` runs a scheduled rule once against a real deployment, using an identity token from the trigger service account.
- Handler option `schedule.local` runs scheduled continuations and deferred flushes inside the process instead of Cloud Tasks; on by default under the Firestore emulator.
- `setup` also provisions Eventarc's service agent and warns when `--runtime-service-account` names a service account from another project.
- `validate` warns when a scheduled rule runs more than 24 times a day, and when a `sum` aggregate needs a composite index for `idField`.
- New reference sections cover the first deployment to a new project and tearing resources down.

### Changed

- Every CLI command prints which source the resolved project came from, and `setup`, `deploy`, `rebuild`, `verify --fix` and `run` now refuse a project that only comes from gcloud's active config.
- `validate`'s cost line for a scheduled rule now shows runs per day next to the per-run formula.
- Under the Firestore emulator, continuation and flush tasks now run inside the process by default. Tests that relied on a budget-stopped run answering `continued: false` without an `enqueue` should pass `schedule.local: false`.

## [0.12.0] - 2026-10-13

First published release.

### Added

- One Cloud Run function and one Eventarc trigger per collection keep denormalized documents in sync.
- Values are re-read from Firestore, never taken from the event, and every write is conditional on the target's `updateTime`.
- `defineView`: the general rule. Declared `targetFields` of a target are kept equal to `build(...)` over its sources. Optional `base` ties the target's existence to a same-id document; optional `patch` updates incrementally.
- `defineProjection`: a view with `base` and no `build`, for read models that copy declared fields.
- `defineConnection`: copies fields of a source document into the documents that point at it.
- `defineAggregate`: keeps a count or sum from an aggregation query.
- `typed<Collections>()` gives the config and `build` typed sources and targets.
- `schedule: '<cron>'` runs a rule from Cloud Scheduler instead of events. Runs over the time budget continue in chunks through a Cloud Tasks queue.
- `defer: '<duration>'` keeps a rule event-driven but recomputes each changed document at most once per interval through Cloud Tasks. Lifecycle events stay immediate.
- Within one event, a source document is read once and shared across rules, never older than the target it is combined with.
- CLI `doc-sync`: `validate` (cost estimate, write chains, warnings), `setup` (service account, IAM, APIs, queue), `deploy` (triggers and jobs), `rebuild`, `verify --fix`, `dev` (emulator bridge).
- Trigger, job and queue names carry a hash so instances never collide, and `deploy` finds its resources by an ownership marker.
