# Roadmap

[日本語版ロードマップ](./ROADMAP.ja.md)

This document lists what `firestore-denormalize` needs before it is useful outside the project it was built for, and in which order we intend to build it. It is a plan, not a promise; items move as we learn more.

The guiding principle does not change: **derived Firestore data, kept correct, with one function.** Values are always re-read from the source, every write is conditional on the target's `updateTime`, and the whole thing deploys as a single Cloud Run service with one Eventarc trigger per collection. Features that would require a different correctness model are listed under *Not planned*.

## Deployment model

We stay with **Eventarc → one HTTP function**. We do not intend to add a second deployment mode based on per-collection `onDocumentWritten` functions. Local development is covered by a bridge command (see *Emulator support* below) rather than by a different runtime path, so the code that runs locally is the code that runs in production.

## Status

| Area | Status |
|---|---|
| Copy sync (`connections`) | Done (v0.1) |
| `validate` / `setup` / `deploy` CLI | Done (v0.1) |
| Counts and sums | Done (v0.2) |
| `rebuild` / backfill | Done (v0.2) |
| Subcollections | Done (v0.2) |
| Emulator support (`doc-sync dev`) | Done (v0.2) |
| `doc-sync verify` | Done (v0.3) |
| Typed config | Done (v0.4) |
| Views (`build` + `patch`) | Done (v0.3) |
| Cost estimate in `validate` | Done (v0.5) |
| Sync metadata (`_sync`) | Planned |

## 1. Required before publishing

Without these the package is not adoptable by a typical Firestore project.

### Copy sync (`connections`) — done

Copy fields from `source/{id}` into `target.targetField` wherever `target.idField == id`. Existing Firestore Extensions need two functions per rule; this package handles any number of rules with one function. Shipped in v0.1.

### Counts and sums — done

Maintain `post.likeCount` or `order.total` from a child or related collection. Values are **recomputed with aggregation queries** (`count()`, `sum()`), never adjusted with `increment()`. This makes the result correct under duplicate delivery and out-of-order events, which is where hand-written counters usually drift.

- New rule kind alongside `connections`, with the aggregate (`count` | `sum(field)`), the target document and the target field.
- Same conditional-write and retry loop as copy sync.
- Cost is one aggregation read per event, which `validate` will report (see *Cost estimate*).

### `rebuild` / backfill — done

`doc-sync rebuild [--connection <name>] [--dry-run]` walks the targets of a rule and brings every document in line with its current source. Required for introducing the package into a project that already has data, and for recovering after a rule change. Today existing targets are only fixed the next time their source changes; this moves backfill from "known limitation" into scope.

- Runs from the CLI against production or the emulator, paged, resumable.
- Reuses the handler's compute-and-conditionally-write code so the result is identical to what a live event would produce.

### Subcollections — done

Allow `users/{uid}/payments` style paths for `source` and `target`, and dotted paths for `fields` / `idField` / `targetField`. Most real projects use subcollections; limiting the package to top-level collections rules out too many of them.

- Eventarc path patterns (`users/{uid}/payments/{docId}`) and the matching collection-group query for targets.
- Validation of the path shape in `defineConfig`.

### Emulator support (`doc-sync dev`) — done

The Firebase Emulator Suite has no Eventarc for Firestore events, so today the handler cannot be exercised locally. `doc-sync dev` is a small bridge that makes it possible without changing the runtime path:

1. Listens to the configured collections in the Firestore emulator with `onSnapshot`.
2. Builds a CloudEvent in the same protobuf format Eventarc sends in production (`google.cloud.firestore.document.v1.written`), using the previous document from a local cache as `oldValue`.
3. POSTs it to the handler URL, typically the `onRequest` function running in the Functions emulator.

Uses only public APIs, so it does not depend on firebase-tools internals. The bridge coalesces rapid consecutive writes, which is acceptable because the handler re-reads sources anyway and uses the event only to decide whether work is needed.

## 2. Reasons to choose this package

### `doc-sync verify` — done

`doc-sync verify [--rule <name>] [--fix]` reads the derived data, recomputes it from the sources and reports every mismatch. With `--fix` it repairs them with the same conditional writes the handler uses. Being able to *prove* that derived data is correct is the main advantage over both hand-written triggers and the existing Extensions. Shipped in v0.3; exits non-zero while a mismatch remains, so it can run as a CI check.

### Typed config — done

```ts
const { defineConfig, defineView } = typed<{ post: Post; category: Category }>()
```

With the collection types supplied, `source` / `target`, `fields`, `idField`, `targetField`, `idParam`, view `sources` and the `build` return type are checked at compile time, so a renamed field fails the build instead of silently copying `undefined`. Shipped in v0.4; type-only, the runtime config is unchanged.

### Views (`build` + `patch`) — done

Rules that compute a derived value with user code instead of a fixed field list, for shapes the built-in rules cannot express: "latest N items", a dictionary keyed by id, a denormalized summary.

- `build({ target, sources }) => value` recomputes the whole value from a fresh read, so results stay deterministic.
- `patch(current, change) => value` is an optional fast path; `rebuild` and `verify` always use `build`.
- Sources relate to the target by `idField`, `idParam` or `refField`, with optional `orderBy`, `limit` and `watch`.

Shipped in v0.3.

## 3. Nice to have

### Cost estimate in `validate` — done

`doc-sync validate` prints, per rule, the maximum number of document reads and writes caused by one source update (for example "1 read of the source, up to N target reads and N writes, where N is the number of matching targets"). Firestore users are cost-sensitive, and this surfaces fan-out-shaped rules before they are deployed. Shipped in v0.5.

### Sync metadata (`_sync`)

Optional per-rule setting that stores the source's `updateTime` next to the derived value, e.g. `post._sync.category.sourceUpdatedAt`. Clients can tell how fresh a derived value is. The timestamp comes from the source document, not from the clock, so the written value stays deterministic and idempotent.

## Not planned

These change the correctness model and belong in a separate package, if anywhere:

- **One-to-many fan-out** (one write producing writes to a large, unbounded set of documents): write-volume control becomes the dominant problem.
- **Debouncing with Cloud Tasks.**
- **Scheduled recomputation of time-dependent values.**
- **A second deployment mode** based on per-collection `onDocumentWritten` functions; see *Deployment model*.

## Release plan

| Version | Contents |
|---|---|
| v0.1 | copy sync, `validate` / `setup` / `deploy` |
| v0.2 | counts and sums, subcollections, `rebuild`, `doc-sync dev` |
| v0.3 | verify, views |
| v0.4 | typed config |
| v0.5 | cost estimate, runtime read counters |
| v1.0 (public release) | validated in the first production project |
| v1.x | `_sync` metadata |
