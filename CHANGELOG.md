# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.6.0] - 2026-10-11

### Changed

- A target whose `idField` now points at a missing source follows `onSourceDelete`, the same treatment `rebuild` gives a missing source (was: left alone).
- A `targetField` removed by an application write (e.g. `set()` without merge) is recomputed on the next event for that document.
- Trigger names are derived from collection ids lower-cased (`chatRooms` → `chatrooms`).
- A view's `patch` receives `after: undefined` when the changed document no longer belongs to the target, not only when it was deleted.
- `undefined` is stripped from the values a view's `build` / `patch` returns before they are written (map entries dropped, array elements become `null`).
- `--emulator-host` applies to `rebuild` and `verify`, not only `dev`.
- The `verify` library log line no longer includes the mismatch's actual/expected values.

### Added

- Validation for multi-region `serviceRegion`, `service` names, reserved ids/field names, overlapping collection patterns, and `idField` aggregates whose collection group would be ambiguous.
- `ce-type`, request body size, and value nesting depth limits on incoming events.
- A read of the changed document once per page on `refField` fan-out.

### Removed

Removed from the public API: `Processor`, `ConnectionResult`, `SyncOptions`, `DeletedSource`, `CheckResult`, `CheckOptions`, `resolveConfig`. Added: `EncodeOptions`.

### Fixed

- Retries no longer reuse a page's source cache.
- `BulkWriter` is closed on failure.
- Windows argument quoting for `gcloud` / `firebase` commands.

## [0.5.0] - 2026-10-11

### Added

- Cost estimate in `validate` (`--strict`), runtime read counters.

## [0.4.0] - 2026-10-11

### Added

- Typed config: `typed<Collections>()`.

## [0.3.0] - 2026-10-09

### Added

- Views (`build` + `patch`).
- `doc-sync verify`.

## [0.2.0] - 2026-10-08

### Added

- Counts and sums.
- Subcollections.
- `rebuild`.
- `doc-sync dev`.

## [0.1.0] - 2026-10-08

### Added

- Copy sync.
- `validate` / `setup` / `deploy`.
