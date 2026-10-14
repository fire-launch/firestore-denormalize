# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
