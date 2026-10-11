# View `targetFields` / `base` / `defineProjection` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a view write several declared field paths of its target (`targetFields`), own the target document's existence through a same-id `base` document, and offer `defineProjection` as the build-less shorthand.

**Architecture:** The handler's view path computes a `FieldPlan` (field path → value or DELETE) instead of a single value, and writes the differing paths in one conditional `update()`. A view with `base` reads the base document after the target and creates (`create()`) or deletes (`delete({ lastUpdateTime })`) the target so that it exists iff the base exists. `defineProjection` is validated on its own and then converted into a `ResolvedView` whose generated `build` copies the declared paths from `base`; handler, rebuild and verify have no projection-specific code.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), firebase-admin Firestore, vitest against the Firestore emulator (`npm test`), `tsc --noEmit` for the type tests, tsup build.

**Spec:** `docs/superpowers/specs/2026-10-12-view-target-fields-and-base.md`

## Global Constraints

- Version becomes `0.8.0`; the view's `targetField` (singular) is removed, not deprecated (package not yet published).
- `connection` and `aggregate` keep their singular `targetField`.
- Never use `set()`. Field writes stay `update(updates, { lastUpdateTime })`; document creation is `create()`; document removal is `delete({ lastUpdateTime })`.
- `'rest'` in `targetFields` is allowed only on a view with `base`, and never on a projection.
- Build/patch results: `undefined` map entries are dropped, `undefined` array elements become `null` (existing `stripUndefined`), and an `undefined` declared path means "delete this path".
- Undeclared paths in a build result are logged once per rule and path with `logger.warn` and ignored, never written.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and the `d-nakajima` git identity already configured. Do not push.
- Tests: `npm test` runs the whole suite inside the emulator. To run one file inside the emulator, use `firebase emulators:exec --only firestore --project demo-doc-sync "$(which node) ./node_modules/vitest/vitest.mjs run <file>"` (calling `npx vitest` inside `emulators:exec` fails with ERR_REQUIRE_ESM). Unit tests that need no emulator: `npm run test:unit`. Types: `npm run typecheck`.
- Japanese and English docs are kept in step: every doc change is made in both `docs/reference.md` / `docs/reference.ja.md` and `README.md` / `README.ja.md`.

## Review Focus

1. A build result that puts a value under a root key some other rule owns (e.g. a `rest` view returning `likeCount` that an aggregate writes): must be ignored with a warning, never written or deleted. Pinned in Task 7.
2. A stale source event arriving after the base was deleted (`post` gone, late `comment` create): must not resurrect the target. Pinned in Task 5.
3. A base view's target deleted by hand while the base still exists: the target-side delete event recreates it. Pinned in Task 5.
4. Rebuild/verify resume (`startAfter`) pointing into the target collection of a base view: skips the base walk and continues the target walk only. Pinned in Task 6.
5. `create()` racing with another writer (`ALREADY_EXISTS`): the sync redoes itself from a fresh read and ends up updating, not failing. Pinned in Task 5.

---

## File map

| File | Change |
|---|---|
| `src/config.ts` | `ViewRule.targetFields`/`base`, optional `sources`, `ProjectionRule`, `defineProjection`, validation, `ResolvedView` (`targetFields`, `rest`, `reservedRootKeys`, `base`, `basePattern`, `projection`), `collectionsOf` with base, `writeTriggerEdges` over `targetFields`/base |
| `src/handler.ts` | `FieldPlan`, `planUpdates`, generalized `write`, `createTarget`/`removeTarget`, `readBase`, `planOf` + undeclared warning, `viewBase`, dispatch on base, multi-field `check`, `Outcome` gains `create`/`remove`, `RuleResult.kind` gains `projection`, exported `basePathForTarget`/`targetPathForBase` |
| `src/walk.ts` | `walkCollection(pattern)`; `walkTargets` delegates |
| `src/rebuild.ts`, `src/verify.ts` | two-phase walk for base views; verify reports `issue: 'value' | 'missing' | 'orphan'` |
| `src/cost.ts` | base trigger line, base read in per-target cost |
| `src/cli/commands.ts` | rule summary prints `targetFields`, `base`, projections |
| `src/types.ts` | typed `defineView` with `targetFields`/`base`, typed `defineProjection` |
| `src/index.ts` | export `defineProjection`, `ProjectionRule` |
| `test/unit/config.test.ts`, `test/unit/cost.test.ts`, `test/unit/commands.test.ts`, `test/unit/plan.test.ts` | `targetFields`, base, projection cases |
| `test/view.test.ts`, `test/verify.test.ts`, `test/rebuild.test.ts`, `test/handler.test.ts`, `test/dev.test.ts` | `targetFields` migration; new multi-field, base, rest, projection, two-phase tests |
| `test/types/typed-config.types.ts` | typed view/projection cases |
| `docs/reference.md`, `docs/reference.ja.md`, `README.md`, `README.ja.md`, `CHANGELOG.md`, `examples/functions/src/doc-sync.config.ts`, `package.json` | docs, examples, version |

---

### Task 1: Handler internals write a field plan (no behaviour change)

Generalize the single-field write path so later tasks can write several paths at once. Views still have one `targetField` after this task; every existing test must keep passing.

**Files:**
- Modify: `src/handler.ts` (types near line 79; `write` ~303; `syncCopy` ~423-433; `syncAggregate` ~562-571; `syncView` ~664-675; helpers `needsWrite`/`toFieldValue` ~920-928)

**Interfaces:**
- Produces: `type FieldPlan = Map<string, Desired>`; `function planUpdates(target: DocumentSnapshot | undefined, plan: FieldPlan): { updates: Record<string, unknown>; outcome: Outcome }`; `Processor.write(ref, target, updates: Record<string, unknown>, outcome: Outcome, redo)`.

- [ ] **Step 1: Add the plan types and `planUpdates` next to `needsWrite`**

In `src/handler.ts`, directly above `function needsWrite(...)`, add:

```ts
/** What a rule wants each written field path to hold: a value, or `DELETE` for "the path must be absent". */
type FieldPlan = Map<string, Desired>

/**
 * The `update()` payload for the paths of `plan` whose current value on `target` differs, and
 * the outcome that write would be (`skip` when nothing differs, `delete` when only deletions remain).
 * Without an existing target every non-DELETE entry is included.
 */
function planUpdates(target: DocumentSnapshot | undefined, plan: FieldPlan): { updates: Record<string, unknown>; outcome: Outcome } {
  const updates: Record<string, unknown> = {}
  let outcome: Outcome = 'skip'
  for (const [path, desired] of plan) {
    if (target?.exists ? !needsWrite(target, path, desired) : desired === DELETE) continue
    updates[path] = toFieldValue(desired)
    if (desired !== DELETE) outcome = 'write'
    else if (outcome === 'skip') outcome = 'delete'
  }
  return { updates, outcome }
}
```

- [ ] **Step 2: Generalize `write`**

Replace the `write` method (the one with signature `write(ref, target, field: string, desired: Desired, redo)`) with:

```ts
  /**
   * Applies `updates` (field path → value or `FieldValue.delete()`) to `ref` conditional on the
   * `updateTime` of `target`, the snapshot the values were computed from. On a failed
   * precondition `redo` runs the whole read-compute-write again.
   */
  private async write(ref: DocumentReference, target: DocumentSnapshot, updates: Record<string, unknown>, outcome: Outcome, redo: () => Promise<Outcome>): Promise<Outcome> {
    try {
      await ref.update(updates, { lastUpdateTime: target.updateTime })
      return outcome
    } catch (err) {
      if (isCode(err, GRPC_NOT_FOUND)) return 'skip'
      if (!isCode(err, GRPC_FAILED_PRECONDITION)) throw err
      return redo()
    }
  }
```

- [ ] **Step 3: Route the three sync methods through `planUpdates`**

In `syncCopy`, replace the last three lines (`if (value === NOTHING || !needsWrite(...)) return 'skip'` … `return this.write(...)`) with:

```ts
    if (value === NOTHING) return 'skip'
    const { updates, outcome } = planUpdates(target, new Map([[conn.targetField, value]]))
    if (outcome === 'skip') return 'skip'
    if (opts.dryRun) return outcome
    return this.write(ref, target, updates, outcome, () => this.syncCopy(ref, conn, { ...opts, counter, attempt: attempt + 1, sourceCache: undefined }))
```

In `syncAggregate`, replace the equivalent three lines with:

```ts
    if (value === NOTHING) return 'skip'
    const { updates, outcome } = planUpdates(target, new Map([[rule.targetField, value]]))
    if (outcome === 'skip') return 'skip'
    if (opts.dryRun) return outcome
    return this.write(ref, target, updates, outcome, () => this.syncAggregate(ref, rule, { ...opts, counter, attempt: attempt + 1 }))
```

In `syncView`, replace the equivalent three lines with:

```ts
    if (value === NOTHING) return 'skip'
    const { updates, outcome } = planUpdates(target, new Map([[view.targetField, value]]))
    if (outcome === 'skip') return 'skip'
    if (opts.dryRun) return outcome
    return this.write(ref, target, updates, outcome, () => this.syncView(ref, view, { ...opts, counter, attempt: attempt + 1 }))
```

- [ ] **Step 4: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: both pass with no test changes.

- [ ] **Step 5: Commit**

```bash
git add src/handler.ts
git commit -m "handler: write a field plan instead of a single field (no behaviour change)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `targetFields` replaces the view's `targetField`

**Files:**
- Modify: `src/config.ts` (ViewRule ~128-151, ResolvedView ~199-208, view validation ~443-597, `writeTriggerEdges` ~740-754)
- Modify: `src/handler.ts` (`check` ~283-296, `viewTarget` ~635-658, `syncView`, `patchWith`, `buildValue`)
- Modify: `src/verify.ts` (Mismatch + visit), `src/cli/commands.ts:58`
- Modify tests: `test/unit/config.test.ts`, `test/unit/cost.test.ts`, `test/unit/commands.test.ts`, `test/unit/plan.test.ts`, `test/view.test.ts`, `test/handler.test.ts`, `test/dev.test.ts`, `test/verify.test.ts`, `test/rebuild.test.ts`, `test/types/typed-config.types.ts`, `examples/functions/src/doc-sync.config.ts`

**Interfaces:**
- Consumes: `FieldPlan`, `planUpdates`, `write(ref, target, updates, outcome, redo)` from Task 1.
- Produces: `ViewRule.targetFields: string[]`, `build` returns `DocumentData | undefined`, `patch(current: DocumentData, change, ctx)`; `ResolvedView.targetFields: string[]`, `ResolvedView.rest: boolean` (always false in this task), `ResolvedView.reservedRootKeys: string[]` (always `[]` in this task); `CheckResult { status; reason?; issue?: 'value' | 'missing' | 'orphan'; fields?: FieldMismatch[] }`; `Mismatch { rule; document; issue; field?; actual?; expected?; fixed }`; `Processor.planOf(view, target, built)`.

- [ ] **Step 1: Write the failing unit tests for validation**

In `test/unit/config.test.ts`, inside `describe('views')`, change the fixture `view` to use `targetFields: ['latestComments']` and its `build` to return `{ latestComments: sources.comments!.map((c) => c.id) }`. Replace the test `requires name, target, targetField, ...` with:

```ts
    it('requires name, target, non-empty targetFields, a non-empty sources map and a build function', () => {
      expect(problemsOf(only({ name: '' }))).toContainEqual(expect.stringContaining('`name` is required'))
      expect(problemsOf(only({ target: '' }))).toContainEqual(expect.stringContaining('`target` is required'))
      expect(problemsOf(only({ targetFields: [] }))).toContainEqual(expect.stringContaining('`targetFields` must be a non-empty array'))
      expect(problemsOf(only({ targetFields: 'latest' as never }))).toContainEqual(expect.stringContaining('`targetFields` must be a non-empty array'))
      expect(problemsOf(only({ targetFields: ['a/b'] }))).toContainEqual(expect.stringContaining('`targetFields` entry "a/b" is not a valid field path'))
      expect(problemsOf(only({ targetFields: ['stats', 'stats.count'] }))).toContainEqual(expect.stringContaining('`targetFields` "stats" and "stats.count" overlap'))
      expect(problemsOf(only({ sources: {} }))).toContainEqual(expect.stringContaining('`sources` must have at least one entry'))
      expect(problemsOf(only({ sources: [] as never }))).toContainEqual(expect.stringContaining('`sources` must be an object'))
      expect(problemsOf(only({ build: undefined as never }))).toContainEqual(expect.stringContaining('`build` must be a function'))
      expect(problemsOf(only({ patch: 'x' as never }))).toContainEqual(expect.stringContaining('`patch` must be a function'))
    })

    it('resolves targetFields and keeps every path apart from other rules and refFields', () => {
      const r = validateConfig(only({ targetFields: ['latestComments', 'stats.commentCount'] }))
      expect(r.views[0]).toMatchObject({ targetFields: ['latestComments', 'stats.commentCount'], rest: false, reservedRootKeys: [] })
      // `only` drops the other rules, so put the base config's connection (writes post.category, idField categoryId) back
      expect(problemsOf({ ...base, rules: [...base.rules, { ...view, targetFields: ['category.name'] }] })).toContainEqual(
        expect.stringContaining('overlaps "category" written by connection "post-category"'),
      )
      expect(problemsOf({ ...base, rules: [...base.rules, { ...view, targetFields: ['categoryId'] }] })).toContainEqual(expect.stringContaining('is used as an `idField` by another rule'))
      expect(
        problemsOf(only({ targetFields: ['authorId'], sources: { author: { collection: 'user', refField: 'authorId' } } })),
      ).toContainEqual(expect.stringContaining('`refField` "authorId" and `targetFields` must not overlap'))
    })
```

Delete the old `keeps targetField apart from other rules and refFields` test (its cases are covered above). In the test `resolves sources, patterns and ordering`, change `comments: view.sources.comments!` to `comments: view.sources!.comments!` (`sources` becomes optional in Step 3). Update every remaining `targetField: '<x>'` in this file's view fixtures to `targetFields: ['<x>']`, and every view `build` to return `{ <x>: ... }`.

- [ ] **Step 2: Run the unit tests to see them fail**

Run: `npm run test:unit -- test/unit/config.test.ts`
Expected: FAIL (new messages not produced; `targetFields` unknown).

- [ ] **Step 3: Change the public and resolved view types**

In `src/config.ts` replace the `BuildContext`, `PatchContext`, `ViewRule`, `ResolvedView` declarations and `defineView` with:

```ts
/** What `build` receives: the target and the current documents of every source, all freshly read. */
export interface BuildContext<S extends Record<string, ViewSource> = Record<string, ViewSource>> {
  target: DocumentSnapshot
  /** The base document (views with `base`); always exists when `build` runs. */
  base?: DocumentSnapshot
  /** Documents per source key, in query order. A `refField` source has zero or one document. */
  sources: { [K in keyof S]: QueryDocumentSnapshot[] }
  /** The Firestore instance the handler uses, for extra reads. Reads happen after the target was read, so the conditional write stays safe. */
  firestore: Firestore
}

export interface PatchContext {
  /** Freshly read target document. */
  target: DocumentSnapshot
  /** The base document (views with `base`); always exists when `patch` runs. */
  base?: DocumentSnapshot
  /** The Firestore instance the handler uses, for a small extra read (e.g. refilling a "latest N" list after a delete). */
  firestore: Firestore
}

/**
 * View: keep the declared `targetFields` of `target` equal to the matching paths of
 * `build(...)`, an object computed by user code from the documents of one or more source
 * collections. For shapes the other rules cannot express: "latest N items", a map keyed by
 * id, a custom summary, a read model spread over several fields.
 */
export interface ViewRule<S extends Record<string, ViewSource> = Record<string, ViewSource>, T extends DocumentData = DocumentData> {
  kind: 'view'
  /** Unique name, used in logs. */
  name: string
  /** Collection holding the derived value. */
  target: string
  /**
   * Field paths of the target this view writes (`title`, `stats.count`, `profile`). Only these
   * paths are read from the `build` result; a path whose value is `undefined` is deleted.
   * `'rest'` (views with `base` only) adds every root key no rule declares.
   */
  targetFields: string[]
  /**
   * Collection whose document with the same ID decides whether the target exists: the target is
   * created when the base exists and deleted when it does not. Must have the same placeholders as `target`.
   */
  base?: string
  /** Source collections keyed by the name used in `build` / `patch`. May be omitted when `base` is set. */
  sources?: S
  /**
   * Recomputes the declared fields from a fresh read of the base and every source. Must be
   * deterministic. Return `undefined` to delete every declared field. Used by the handler,
   * `rebuild` and `verify`.
   */
  build(ctx: BuildContext<S>): T | undefined | Promise<T | undefined>
  /**
   * Optional fast path: derive the new values from the current ones (`current` holds the
   * declared paths as they are on the target) and one changed source document. Return
   * `undefined` to fall back to `build`.
   */
  patch?(current: T, change: ViewChange, ctx: PatchContext): T | undefined | Promise<T | undefined>
}
```

```ts
export interface ResolvedView {
  kind: 'view'
  name: string
  target: string
  /** Declared field paths, without `'rest'`. */
  targetFields: string[]
  /** Whether `'rest'` was declared. */
  rest: boolean
  /** Root keys of the target that `'rest'` must never touch: every root of a field written or used as an id by any rule on this collection. */
  reservedRootKeys: string[]
  base?: string
  basePattern?: CollectionPattern
  targetPattern: CollectionPattern
  sources: ResolvedViewSource[]
  build: ViewRule['build']
  patch?: ViewRule['patch']
  /** Set when the view was made from `defineProjection`. */
  projection?: true
}
```

```ts
/** Tags a view with its `kind` and types `build` / `patch` from the view's own `sources` keys. */
export function defineView<S extends Record<string, ViewSource>, T extends DocumentData>(view: Omit<ViewRule<S, T>, 'kind'>): ViewRule<S, T> {
  return { kind: 'view', ...view } as ViewRule<S, T>
}
```

Add `DocumentData` to the `firebase-admin/firestore` type import at the top of `src/config.ts` and import `splitFieldPath` from `./fields.js`.

- [ ] **Step 4: Validate `targetFields` (base and rest come in Task 4 and Task 7)**

In the `viewList.forEach` block of `validateConfig`, replace `const okTargetField = fieldPath(v.targetField, label, 'targetField')` with:

```ts
    const okTargetFieldsShape = Array.isArray(v.targetFields) && v.targetFields.length > 0 && v.targetFields.every((f) => typeof f === 'string')
    if (!okTargetFieldsShape) problems.push(`${label}: \`targetFields\` must be a non-empty array of field paths`)
    const declared: string[] = okTargetFieldsShape ? (v.targetFields as string[]) : []
    const explicit = declared.filter((f) => f !== 'rest')
    const restCount = declared.length - explicit.length
    let okTargetFields = okTargetFieldsShape
    for (const f of explicit) {
      if (!isValidFieldPath(f)) {
        problems.push(`${label}: \`targetFields\` entry "${f}" is not a valid field path`)
        okTargetFields = false
      }
    }
    for (let a = 0; a < explicit.length; a++) {
      for (let b = a + 1; b < explicit.length; b++) {
        if (fieldPathsOverlap(explicit[a]!, explicit[b]!)) {
          problems.push(`${label}: \`targetFields\` "${explicit[a]}" and "${explicit[b]}" overlap`)
          okTargetFields = false
        }
      }
    }
    if (restCount > 0) {
      problems.push(`${label}: 'rest' in \`targetFields\` requires \`base\``)
      okTargetFields = false
    }
```

Replace the refField/targetField overlap check inside the sources loop with:

```ts
      if (okRefField) {
        for (const f of explicit) {
          if (fieldPathsOverlap(s.refField!, f)) problems.push(`${sLabel}: \`refField\` "${s.refField}" and \`targetFields\` must not overlap ("${f}")`)
        }
      }
```

Replace `if (target && okTargetField) writtenFields.push({ rule: label, target, field: v.targetField })` with:

```ts
    if (target && okTargetFields) for (const f of explicit) writtenFields.push({ rule: label, target, field: f })
```

Replace the `resolvedViews.push({...})` block with:

```ts
    if (target && okTargetFields && okBuild && okPatch && sourcesOk) {
      resolvedViews.push({
        kind: 'view',
        name: v.name,
        target: v.target,
        targetFields: explicit,
        rest: restCount === 1,
        reservedRootKeys: [],
        targetPattern: target,
        sources: resolvedSources,
        build: v.build,
        patch: v.patch,
      })
    }
```

Keep the `sources` checks as they are for now (`sources` still required; Task 4 relaxes them when `base` is set), but read them through `v.sources ?? undefined` so the optional type compiles:

```ts
    const sourcesIsObject = v.sources !== null && typeof v.sources === 'object' && !Array.isArray(v.sources)
```
stays valid because `undefined !== null` is true and `typeof undefined === 'object'` is false, so a missing `sources` is reported as "must be an object" in this task.

- [ ] **Step 5: Update `writeTriggerEdges` to iterate the written paths**

Replace the body of `writeTriggerEdges` with:

```ts
function writeTriggerEdges(rules: ResolvedRule[]): WriteTrigger[] {
  const watchers = (r: ResolvedRule): { key: string; fields: string[] | undefined }[] => {
    if (r.kind === 'connection') return [{ key: r.sourcePattern.key, fields: r.fields }]
    if (r.kind === 'aggregate') return [{ key: r.sourcePattern.key, fields: r.watchedFields }]
    return r.sources.map((s) => ({ key: s.pattern.key, fields: s.watch }))
  }
  /** Field paths a rule writes; `undefined` when it may write any field (`rest`). */
  const written = (r: ResolvedRule): string[] | undefined => (r.kind === 'view' ? (r.rest ? undefined : r.targetFields) : [r.targetField])
  const edges: WriteTrigger[] = []
  for (const a of rules) {
    const fields = written(a)
    for (const b of rules) {
      const hit = watchers(b).some(
        (w) => w.key === a.targetPattern.key && (w.fields === undefined || fields === undefined || w.fields.some((f) => fields.some((t) => fieldPathsOverlap(f, t)))),
      )
      if (hit) edges.push({ from: a.name, field: `${a.target}.${fields ? fields.join(',') : '*'}`, to: b.name })
    }
  }
  return edges
}
```

- [ ] **Step 6: Update the CLI summary**

In `src/cli/commands.ts`, change the view line to:

```ts
      log(`  ${v.name}: build(${v.sources.map((s) => s.key).join(', ')}) -> ${v.target}.{${[...v.targetFields, ...(v.rest ? ['rest'] : [])].join(',')}}`)
```

- [ ] **Step 7: Compute a plan in the handler's view path**

In `src/handler.ts`:

(a) Change `CheckResult` to:

```ts
/** One field whose current value differs from what the rule computes. */
export interface FieldMismatch {
  field: string
  /** Current value (`undefined` when absent). */
  actual: unknown
  /** Value the field should hold (`undefined` when it should be absent). */
  expected: unknown
}

/** Result of comparing one target with what its sources say it should hold. */
export interface CheckResult {
  /** `ok`: up to date. `mismatch`: differs. `skip`: nothing to check (target missing, idField not a string, ...). */
  status: 'ok' | 'mismatch' | 'skip'
  reason?: string
  /** For `mismatch`: `value` (fields differ), `missing` (base exists, target does not), `orphan` (target exists, base does not). */
  issue?: 'value' | 'missing' | 'orphan'
  /** For `value` / `missing`: the differing fields. */
  fields?: FieldMismatch[]
}
```

(b) Replace `check` with:

```ts
  async check(target: DocumentSnapshot, rule: ResolvedRule, opts: CheckOptions = {}): Promise<CheckResult> {
    if (rule.kind === 'view') return this.checkView(target, rule, opts)
    if (!target.exists) return { status: 'skip', reason: 'target missing' }
    const counter = opts.counter ?? new ReadCounter()
    const computed =
      rule.kind === 'connection'
        ? await this.computeCopy(target, rule, { sourceCache: opts.sourceCache, counter, deleted: { onSourceDelete: rule.onSourceDelete } })
        : await this.computeAggregate(target, rule, counter)
    if (computed.value === NOTHING) return { status: 'skip', reason: computed.reason }
    return checkPlan(target, new Map([[rule.targetField, computed.value]]))
  }

  private async checkView(target: DocumentSnapshot, view: ResolvedView, opts: CheckOptions): Promise<CheckResult> {
    if (!target.exists) return { status: 'skip', reason: 'target missing' }
    const counter = opts.counter ?? new ReadCounter()
    const { plan, reason } = await this.computeView(target, view, { counter })
    if (plan === NOTHING) return { status: 'skip', reason }
    return checkPlan(target, plan)
  }
```

and add, next to `planUpdates`:

```ts
/** Compares an existing target with a plan: `ok` when every path already holds its value. */
function checkPlan(target: DocumentSnapshot, plan: FieldPlan): CheckResult {
  const fields: FieldMismatch[] = []
  for (const [path, desired] of plan) {
    if (!needsWrite(target, path, desired)) continue
    fields.push({ field: path, actual: target.get(path), expected: desired === DELETE ? undefined : desired })
  }
  return fields.length ? { status: 'mismatch', issue: 'value', fields } : { status: 'ok' }
}
```

(c) Change `computeView`, `patchWith` and `buildValue` to return `{ plan: FieldPlan | typeof NOTHING; reason?: string }`:

```ts
  /** The values the declared paths of `target` should hold: `patch` applied to the current values, or `build` over fresh reads. */
  private async computeView(
    target: DocumentSnapshot,
    view: ResolvedView,
    opts: { change?: ViewChange; changeCache?: ChangeCache; counter: ReadCounter },
  ): Promise<{ plan: FieldPlan | typeof NOTHING; reason?: string }> {
    const { counter } = opts
    const firestore = countingFirestore(this.db(), counter)
    const source = opts.change && view.sources.find((s) => s.key === opts.change!.source)
    if (opts.change && source && view.patch && target.exists) {
      const { path } = opts.change
      const cache = opts.changeCache
      if (!cache?.doc) {
        counter.doc()
        const read = this.db().doc(path).get()
        if (cache) cache.doc = read
        else return this.patchWith(target, view, source, opts.change, await read, counter, firestore)
      }
      return this.patchWith(target, view, source, opts.change, await cache.doc!, counter, firestore)
    }
    return this.buildValue(target, view, counter, firestore)
  }

  private async patchWith(
    target: DocumentSnapshot,
    view: ResolvedView,
    source: ResolvedViewSource,
    change: ViewChange,
    current: DocumentSnapshot,
    counter: ReadCounter,
    firestore: Firestore,
  ): Promise<{ plan: FieldPlan | typeof NOTHING; reason?: string }> {
    const belongs = current.exists && this.belongsToTarget(view, source, target, current)
    const fresh: ViewChange = { ...change, after: belongs ? current.data() : undefined }
    const patched = await view.patch!(this.currentValues(view, target), fresh, { target, firestore })
    if (patched !== undefined) return { plan: this.planOf(view, target, stripUndefined(patched)) }
    return this.buildValue(target, view, counter, firestore)
  }

  private async buildValue(target: DocumentSnapshot, view: ResolvedView, counter: ReadCounter, firestore: Firestore): Promise<{ plan: FieldPlan | typeof NOTHING; reason?: string }> {
    const sources: Record<string, QueryDocumentSnapshot[]> = {}
    for (const source of view.sources) {
      const docs = await this.viewSourceDocs(view, source, target, counter)
      if (docs === undefined) return { plan: NOTHING, reason: `source "${source.key}" unresolvable for this target` }
      sources[source.key] = docs
    }
    const built = await view.build({ target, sources, firestore })
    return { plan: this.planOf(view, target, built === undefined ? undefined : stripUndefined(built)) }
  }

  /** The declared paths of `view` as they are on `target`, as a nested object (what `patch` receives). */
  private currentValues(view: ResolvedView, target: DocumentSnapshot): DocumentData {
    const out: DocumentData = {}
    for (const path of view.targetFields) {
      const v: unknown = target.get(path)
      if (v !== undefined) setField(out, path, v)
    }
    return out
  }

  /** Reads the declared paths out of a build/patch result; a missing path becomes a deletion. Paths the view does not declare are warned about once and ignored. */
  private planOf(view: ResolvedView, target: DocumentSnapshot, built: DocumentData | undefined): FieldPlan {
    const plan: FieldPlan = new Map()
    for (const path of view.targetFields) {
      const v = getField(built, path)
      plan.set(path, v === undefined ? DELETE : v)
    }
    this.warnUndeclared(view, built)
    return plan
  }

  private readonly warnedUndeclared = new Set<string>()

  private warnUndeclared(view: ResolvedView, built: DocumentData | undefined): void {
    const undeclared = undeclaredPaths(view, built)
    for (const path of undeclared) {
      const key = `${view.name}:${path}`
      if (this.warnedUndeclared.has(key)) continue
      this.warnedUndeclared.add(key)
      this.logger.warn('doc-sync: build returned a field the view does not declare, ignored', { rule: view.name, field: path })
    }
  }
```

and the module-level helper (next to `planUpdates`):

```ts
/** Paths in `built` that no declared `targetFields` entry covers (root keys, or sub-keys next to a declared deeper path). */
function undeclaredPaths(view: ResolvedView, built: DocumentData | undefined, prefix = ''): string[] {
  if (built === undefined) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(built)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (view.targetFields.includes(path)) continue
    if (!prefix && view.rest && !view.reservedRootKeys.includes(key)) continue
    const deeper = view.targetFields.some((f) => f.startsWith(`${path}.`))
    if (deeper && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...undeclaredPaths(view, value as DocumentData, path))
    } else {
      out.push(path)
    }
  }
  return out
}
```

(d) In `syncView`, replace the compute/write tail with:

```ts
    const { plan } = await this.computeView(target, view, { ...opts, counter, changeCache: attempt === 0 ? opts.changeCache : undefined })
    if (plan === NOTHING) return 'skip'
    const { updates, outcome } = planUpdates(target, plan)
    if (outcome === 'skip') return 'skip'
    if (opts.dryRun) return outcome
    return this.write(ref, target, updates, outcome, () => this.syncView(ref, view, { ...opts, counter, attempt: attempt + 1 }))
```

(e) In `viewTarget`, replace `if (before && !fieldRemoved(before, after, view.targetField)) {` with:

```ts
    if (before && !view.targetFields.some((f) => fieldRemoved(before, after, f))) {
```

- [ ] **Step 8: Report one mismatch per field in verify**

In `src/verify.ts` change `Mismatch` to:

```ts
export interface Mismatch {
  rule: string
  /** Target document path. */
  document: string
  /** `value`: a field differs. `missing`: the base exists but the target does not. `orphan`: the target exists but its base does not. */
  issue: 'value' | 'missing' | 'orphan'
  /** The differing field path (`value` only). */
  field?: string
  /** Current value of the field (`undefined` when absent). */
  actual?: unknown
  /** Value the field should hold (`undefined` when it should be absent). */
  expected?: unknown
  /** With `fix`: the value was repaired (or found already correct on re-read). Always false without `fix`. */
  fixed: boolean
}
```

and replace the `pending.push({...})` call in the visit callback with:

```ts
        for (const f of check.fields ?? []) {
          pending.push({ rule: rule.name, document: target.ref.path, issue: 'value', field: f.field, actual: f.actual, expected: f.expected, fixed: didFix })
        }
```

In `test/verify.test.ts`, add `issue: 'value'` to every expected mismatch object literal (lines 47-53 and any others that list full `Mismatch` objects). Do the same in `test/view.test.ts` (`verify reports mismatches and fixes them…`, which compares full `Mismatch` objects with `toEqual`). Keep `field`/`actual`/`expected` as they are.

- [ ] **Step 9: Migrate every remaining `targetField` of a view**

Mechanical edits, each `defineView({ targetField: 'x', build: (...) => expr })` becomes `defineView({ targetFields: ['x'], build: (...) => ({ x: expr }) })`, and each `patch` that returned the value now returns `{ x: value }` and reads `current.x` (with `current` typed as the object; `current ?? []` becomes `current.x ?? []`). Files: `test/view.test.ts` (6 views near the top plus any inline ones), `test/handler.test.ts`, `test/dev.test.ts`, `test/rebuild.test.ts`, `test/unit/cost.test.ts`, `test/unit/commands.test.ts`, `test/unit/plan.test.ts`, `examples/functions/src/doc-sync.config.ts`, `test/types/typed-config.types.ts` (keep this one compiling for now: change `targetField: 'latest'` to `targetFields: ['latest']`, wrap the build/patch results, change every negative case's `build: () => []` to `build: () => ({})`, and delete the case `// @ts-expect-error build must return the type of the target field (number)` — with `build` returning `DocumentData` it no longer errors; Task 9 brings an equivalent case back).

For `test/view.test.ts` specifically, the `badges` patch becomes:

```ts
  patch: (current, change) => {
    const id = change.path.split('/').pop()!
    if (change.before && change.after) return undefined // an update: fall back to build
    const next: Record<string, { name: unknown }> = { ...((current.badges as Record<string, { name: unknown }> | undefined) ?? {}) }
    if (change.after) next[id] = { name: change.after.name }
    else delete next[id]
    return { badges: next }
  },
```

and `latestMessages` reads `const list = (current.latest as Item[] | undefined) ?? []` in place of `current ?? []`, returning `{ latest: [...] }` in every branch (`return current` becomes `return { latest: list }`).

In `src/types.ts`, make the minimal change that compiles: `targetField: TF` → `targetFields: TF[]` in `TypedViewRule` and `defineView`, with `build` returning `DocumentData | undefined` and `patch(current: DocumentData, ...)`. Task 9 replaces this with the real typed API.

- [ ] **Step 10: Typecheck and run everything**

Run: `npm run typecheck && npm test`
Expected: PASS. If `test/verify.test.ts` or `test/rebuild.test.ts` compare `Mismatch` objects with `toEqual`, add `issue: 'value'` (Step 8).

- [ ] **Step 11: Commit**

```bash
git add -A src test examples
git commit -m "views: targetFields replaces targetField; build returns an object of the declared paths

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Multi-field views end to end

**Files:**
- Test: `test/view.test.ts` (new `describe`)

**Interfaces:**
- Consumes: Task 2's `targetFields`, `planOf`, undeclared warning.

- [ ] **Step 1: Write the failing tests**

Append to `test/view.test.ts`:

```ts
describe('views: several declared paths', () => {
  const stats = defineView({
    name: 'post-stats',
    target: 'post',
    targetFields: ['commentCount', 'stats.latest', 'firstBody'],
    sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId', orderBy: ['createdAt'] } },
    build: ({ sources }) => ({
      commentCount: sources.comments.length,
      stats: { latest: sources.comments[sources.comments.length - 1]?.id, ignored: 'x' },
      firstBody: sources.comments[0]?.get('body'),
      extra: 1,
    }),
  })
  const cfg = defineConfig({ ...config, rules: [stats] })

  it('writes every declared path in one update, deletes undefined ones and leaves other fields alone', async () => {
    const post = db.doc('post/p1')
    await post.set({ title: 'keep', stats: { likes: 7 } })
    const { handler, logs } = handlerFor(cfg)
    const c1 = db.doc('post/p1/comment/c1')
    await invoke(handler, await change(c1, () => c1.set({ body: 'one', createdAt: 1 })))
    expect((await post.get()).data()).toEqual({ title: 'keep', stats: { likes: 7, latest: 'c1' }, commentCount: 1, firstBody: 'one' })
    expect(processed(logs, 'post-stats')).toMatchObject({ action: 'write', writes: 1 })

    await invoke(handler, await change(c1, () => c1.delete()))
    expect((await post.get()).data()).toEqual({ title: 'keep', stats: { likes: 7 }, commentCount: 0 })
    expect(processed(logs, 'post-stats')).toMatchObject({ action: 'write', writes: 1 })
  })

  it('warns once per undeclared path and never writes it', async () => {
    const post = db.doc('post/p1')
    await post.set({})
    const { handler, logs } = handlerFor(cfg)
    const c1 = db.doc('post/p1/comment/c1')
    await invoke(handler, await change(c1, () => c1.set({ body: 'one', createdAt: 1 })))
    await invoke(handler, await change(c1, () => c1.update({ body: 'two' })))
    const warnings = logs.filter((l) => l.message === 'doc-sync: build returned a field the view does not declare, ignored')
    expect(warnings.map((w) => w.fields?.field).sort()).toEqual(['extra', 'stats.ignored'])
    expect((await post.get()).get('extra')).toBeUndefined()
  })

  it('skips when every declared path already holds its value', async () => {
    const post = db.doc('post/p1')
    await post.set({ commentCount: 1, stats: { latest: 'c1' }, firstBody: 'one' })
    const { handler, logs } = handlerFor(cfg)
    const c1 = db.doc('post/p1/comment/c1')
    await c1.set({ body: 'one', createdAt: 1 })
    await invoke(handler, await change(c1, () => c1.update({ createdAt: 2 }))) // changes the document, not the built values
    expect(processed(logs, 'post-stats')).toMatchObject({ action: 'skip', reason: 'targets up to date' })
  })

  it('gives patch the declared paths as an object and writes what it returns', async () => {
    const counted = defineView({
      name: 'post-counted',
      target: 'post',
      targetFields: ['commentCount', 'lastBody'],
      sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
      build: ({ sources }) => ({ commentCount: sources.comments.length, lastBody: sources.comments[sources.comments.length - 1]?.get('body') }),
      patch: (current, change) => {
        if (!change.after || change.before) return undefined
        return { commentCount: ((current.commentCount as number | undefined) ?? 0) + 1, lastBody: change.after.body }
      },
    })
    const post = db.doc('post/p1')
    await post.set({ commentCount: 4, lastBody: 'd' })
    const { handler } = handlerFor(defineConfig({ ...config, rules: [counted] }))
    const c5 = db.doc('post/p1/comment/c5')
    await invoke(handler, await change(c5, () => c5.set({ body: 'e' })))
    expect((await post.get()).data()).toEqual({ commentCount: 5, lastBody: 'e' })
  })
})
```

- [ ] **Step 2: Run the file and watch the new tests fail or pass**

Run: `firebase emulators:exec --only firestore --project demo-doc-sync "$(which node) ./node_modules/vitest/vitest.mjs run test/view.test.ts"`
Expected: the four new tests PASS if Task 2 was complete; any failure points at `planOf` / `undeclaredPaths` / `currentValues`. Fix in `src/handler.ts` until green.

- [ ] **Step 3: Commit**

```bash
git add test/view.test.ts src/handler.ts
git commit -m "views: cover several declared paths, undeclared warning and object-shaped patch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `base` in the config layer

Validation, resolution, trigger collections and write-trigger edges. No runtime behaviour yet.

**Files:**
- Modify: `src/config.ts` (view validation block, `collectionsOf`, `writeTriggerEdges`)
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Produces: `ResolvedView.base?: string`, `ResolvedView.basePattern?: CollectionPattern`; `sources` optional when `base` is set; `collectionsOf` includes `base`; a base view watches every field of its base collection in `writeTriggers`.

- [ ] **Step 1: Write the failing unit tests**

Add `writeTriggers` to the import list at the top of `test/unit/config.test.ts`. Inside `describe('views')` add:

```ts
    it('accepts base with the same placeholders and rejects mismatches', () => {
      const r = validateConfig(only({ base: 'draft', sources: undefined, targetFields: ['title'], build: ({ base }) => ({ title: base!.get('title') }) }))
      expect(r.views[0]).toMatchObject({ base: 'draft', basePattern: expect.objectContaining({ key: 'draft' }), sources: [] })
      expect(problemsOf(only({ base: 'post' }))).toContainEqual(expect.stringContaining('`base` and `target` must be different collections'))
      expect(problemsOf(only({ base: 'shop/{shopId}/draft' }))).toContainEqual(expect.stringContaining('`base` must have the same placeholders as `target`'))
      expect(problemsOf(only({ sources: undefined }))).toContainEqual(expect.stringContaining('`sources` must have at least one entry (or set `base`)'))
      expect(problemsOf(only({ targetFields: ['latestComments', 'rest'] }))).toContainEqual(expect.stringContaining("'rest' in `targetFields` requires `base`"))
      expect(problemsOf(only({ base: 'draft', targetFields: ['rest', 'rest'] }))).toContainEqual(expect.stringContaining("'rest' may appear once"))
      expect(problemsOf(only({ sources: { base: { collection: 'draft', refField: 'draftId' } } }))).toContainEqual(expect.stringContaining('source key "base" is reserved'))
    })

    it('requires every base view of a target to agree on the base', () => {
      const other = { ...view, name: 'post-other', targetFields: ['other'], base: 'archive' }
      expect(problemsOf({ ...base, rules: [{ ...view, base: 'draft' }, other] })).toContainEqual(
        expect.stringContaining('`base` "archive" differs from "draft" declared by view "post-latest-comments"'),
      )
    })

    it('lists the base collection for triggers and treats a base view as watching every base field', () => {
      expect(collectionsOf(validateConfig(only({ base: 'draft' }))).map((p) => p.raw)).toContain('draft')
      const watcher = defineView({ name: 'post-public', target: 'postPublic', base: 'post', targetFields: ['title'], build: ({ base }) => ({ title: base!.get('title') }) })
      expect(writeTriggers(validateConfig({ ...base, rules: [view, watcher] }))).toContainEqual({ from: 'post-latest-comments', field: 'post.latestComments', to: 'post-public' })
    })
```

- [ ] **Step 2: Run them**

Run: `npm run test:unit -- test/unit/config.test.ts`
Expected: FAIL (`base` ignored / sources required).

- [ ] **Step 3: Validate `base`, relax `sources`, record base agreement**

In `src/config.ts`, before `viewList.forEach(...)`, add:

```ts
  /** The base declared for each target collection, so every base view of a target agrees. */
  const baseByTarget = new Map<string, { key: string; raw: string; rule: string }>()
```

Inside the view block, directly after the `targetFields` validation from Task 2, replace the line `if (restCount > 0) { problems.push(... requires base ...) }` with:

```ts
    const hasBase = v.base !== undefined
    const basePattern = hasBase ? pattern(v.base, label, 'base') : undefined
    let okBase = !hasBase || basePattern !== undefined
    if (basePattern && target) {
      if (basePattern.key === target.key) {
        problems.push(`${label}: \`base\` and \`target\` must be different collections`)
        okBase = false
      }
      const sameParams = basePattern.params.length === target.params.length && basePattern.params.every((p) => target.params.includes(p))
      if (!sameParams) {
        problems.push(`${label}: \`base\` must have the same placeholders as \`target\``)
        okBase = false
      }
      const prev = baseByTarget.get(target.key)
      if (prev && prev.key !== basePattern.key) {
        problems.push(`${label}: \`base\` "${v.base}" differs from "${prev.raw}" declared by ${prev.rule} for the same target`)
        okBase = false
      } else if (!prev) baseByTarget.set(target.key, { key: basePattern.key, raw: v.base as string, rule: label })
    }
    if (restCount > 1) {
      problems.push(`${label}: 'rest' may appear once in \`targetFields\``)
      okTargetFields = false
    }
    if (restCount > 0 && !hasBase) {
      problems.push(`${label}: 'rest' in \`targetFields\` requires \`base\``)
      okTargetFields = false
    }
```

Replace the three `sources` lines with:

```ts
    const sourcesIsObject = v.sources === undefined || (v.sources !== null && typeof v.sources === 'object' && !Array.isArray(v.sources))
    if (!sourcesIsObject) problems.push(`${label}: \`sources\` must be an object keyed by source name`)
    const sourceEntries: [string, ViewSource][] = sourcesIsObject && v.sources ? Object.entries(v.sources as Record<string, ViewSource>) : []
    if (sourcesIsObject && sourceEntries.length === 0 && !hasBase) problems.push(`${label}: \`sources\` must have at least one entry (or set \`base\`)`)
```

and `let sourcesOk = sourceEntries.length > 0` with `let sourcesOk = sourcesIsObject && (sourceEntries.length > 0 || hasBase)`.

At the top of the `for (const [key, s] of sourceEntries)` loop body, before `if (!s || typeof s !== 'object')`, add:

```ts
      if (key === 'base') {
        // `RuleResult.source` reports the base as "base"; a source of that name would be indistinguishable in logs.
        problems.push(`${label}: source key "base" is reserved`)
        sourcesOk = false
        continue
      }
```

In the `resolvedViews.push` condition add `&& okBase`, and add `base: v.base, basePattern,` to the pushed object.

- [ ] **Step 4: `collectionsOf` and `writeTriggerEdges` know about `base`**

In `collectionsOf`, change the `views` parameter type to `readonly { target: string; base?: string; sources?: Record<string, { collection: string }> | readonly { collection: string }[] }[]` and add `add(v?.base)` after `add(v?.target)`.

In `writeTriggerEdges`, change the view branch of `watchers` to:

```ts
    return [...(r.basePattern ? [{ key: r.basePattern.key, fields: undefined }] : []), ...r.sources.map((s) => ({ key: s.pattern.key, fields: s.watch }))]
```

- [ ] **Step 5: Run unit tests and typecheck**

Run: `npm run typecheck && npm run test:unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/unit/config.test.ts
git commit -m "config: views may declare a base collection with the same id as the target

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The handler creates and removes targets of base views

**Files:**
- Modify: `src/handler.ts` (types, dispatch ~193-223, `viewTarget`, `syncView`, `computeView`/`patchWith`/`buildValue`, `checkView`, new `viewBase`, `readBase`, `createTarget`, `removeTarget`, exported path helpers)
- Test: `test/view.test.ts`

**Interfaces:**
- Consumes: `ResolvedView.basePattern` (Task 4).
- Produces: `export type Outcome = 'skip' | 'write' | 'delete' | 'create' | 'remove'`; `RuleResult.action: Outcome`; `RuleResult.kind: 'connection' | 'aggregate' | 'view' | 'projection'`; `SyncOptions.base?: DocumentSnapshot`, `SyncOptions.orphansOnly?: boolean`; `CheckOptions.base?: DocumentSnapshot`, `CheckOptions.orphansOnly?: boolean`; `export function basePathForTarget(view, targetPath): string | undefined`; `export function targetPathForBase(view, basePath): string | undefined`; `Processor.viewBase(view, match, before, after): Promise<RuleResult>`; `BuildContext.base` / `PatchContext.base` populated.

- [ ] **Step 1: Write the failing tests**

Append to `test/view.test.ts`:

```ts
describe('views: base decides whether the target exists', () => {
  const publicView = defineView({
    name: 'post-public',
    target: 'postPublic',
    base: 'post',
    targetFields: ['title', 'commentCount'],
    sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
    build: ({ base, sources }) => ({ title: base!.get('title'), commentCount: sources.comments.length }),
  })
  const cfg = defineConfig({ ...config, rules: [publicView] })

  it('creates the target when the base is created and updates it when the base changes', async () => {
    const post = db.doc('post/p1')
    const { handler, logs } = handlerFor(cfg)
    await invoke(handler, await change(post, () => post.set({ title: 'a', secret: 's' })))
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a', commentCount: 0 })
    expect(processed(logs, 'post-public')).toMatchObject({ role: 'source', source: 'base', action: 'create', writes: 1 })
    await invoke(handler, await change(post, () => post.update({ title: 'b' })))
    expect((await db.doc('postPublic/p1').get()).get('title')).toBe('b')
    expect(processed(logs, 'post-public')).toMatchObject({ action: 'write' })
    await invoke(handler, await change(post, () => post.update({ secret: 't' })))
    expect(processed(logs, 'post-public')).toMatchObject({ action: 'skip', reason: 'target up to date' })
  })

  it('creates the target from a source event when the base exists, and skips when it does not', async () => {
    await db.doc('post/p1').set({ title: 'a' })
    const { handler, logs } = handlerFor(cfg)
    const c1 = db.doc('post/p1/comment/c1')
    await invoke(handler, await change(c1, () => c1.set({ body: 'x' })))
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a', commentCount: 1 })
    expect(processed(logs, 'post-public')).toMatchObject({ source: 'comments', action: 'create' })
    const ghost = db.doc('post/ghost/comment/c1')
    await invoke(handler, await change(ghost, () => ghost.set({ body: 'x' })))
    expect((await db.doc('postPublic/ghost').get()).exists).toBe(false)
    expect(processed(logs, 'post-public')).toMatchObject({ action: 'skip' })
  })

  it('removes the target when the base is deleted, but not when a source is deleted', async () => {
    const post = db.doc('post/p1')
    await post.set({ title: 'a' })
    const target = db.doc('postPublic/p1')
    await target.set({ title: 'a', commentCount: 1, likeCount: 3 })
    const c1 = db.doc('post/p1/comment/c1')
    await c1.set({ body: 'x' })
    const { handler, logs } = handlerFor(cfg)
    await invoke(handler, await change(c1, () => c1.delete()))
    expect((await target.get()).data()).toEqual({ title: 'a', commentCount: 0, likeCount: 3 })
    await invoke(handler, await change(post, () => post.delete()))
    expect((await target.get()).exists).toBe(false)
    expect(processed(logs, 'post-public')).toMatchObject({ source: 'base', action: 'remove', writes: 1 })
  })

  it('does not resurrect the target from a stale source event after the base was deleted', async () => {
    const post = db.doc('post/p1')
    await post.set({ title: 'a' })
    const c1 = db.doc('post/p1/comment/c1')
    const staleCreate = await change(c1, () => c1.set({ body: 'x' })) // captured while the base existed
    await post.delete()
    const { handler, logs } = handlerFor(cfg)
    await invoke(handler, staleCreate)
    expect((await db.doc('postPublic/p1').get()).exists).toBe(false)
    expect(processed(logs, 'post-public')).toMatchObject({ action: 'skip' })
  })

  it('recreates a target that was deleted by hand while the base exists', async () => {
    await db.doc('post/p1').set({ title: 'a' })
    const target = db.doc('postPublic/p1')
    await target.set({ title: 'a', commentCount: 0 })
    const { handler, logs } = handlerFor(cfg)
    await invoke(handler, await change(target, () => target.delete()))
    expect((await target.get()).data()).toEqual({ title: 'a', commentCount: 0 })
    expect(processed(logs, 'post-public')).toMatchObject({ role: 'target', action: 'create' })
  })

  it('redoes the sync from a fresh read when create() loses a race', async () => {
    let raced = false
    const racy = defineView({
      name: 'post-public-racy',
      target: 'postPublic',
      base: 'post',
      targetFields: ['title', 'commentCount'],
      sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
      build: async ({ base, sources }) => {
        if (!raced) {
          raced = true
          await db.doc('postPublic/p1').set({ title: 'manual', likeCount: 1 }) // someone else creates it between our read and our create()
        }
        return { title: base!.get('title'), commentCount: sources.comments.length }
      },
    })
    const post = db.doc('post/p1')
    const { handler, logs } = handlerFor(defineConfig({ ...config, rules: [racy] }))
    await invoke(handler, await change(post, () => post.set({ title: 'a' })))
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a', commentCount: 0, likeCount: 1 })
    expect(processed(logs, 'post-public-racy')).toMatchObject({ action: 'write', writes: 1 })
  })
})
```

- [ ] **Step 2: Run the file; the new tests fail**

Run: `firebase emulators:exec --only firestore --project demo-doc-sync "$(which node) ./node_modules/vitest/vitest.mjs run test/view.test.ts"`
Expected: the six new tests FAIL (targets never created).

- [ ] **Step 3: Types and constants**

In `src/handler.ts`:

```ts
export type Outcome = 'skip' | 'write' | 'delete' | 'create' | 'remove'
```
(replace the private `type Outcome`), and in `RuleResult` change `kind` to `'connection' | 'aggregate' | 'view' | 'projection'` and `action` to `Outcome` with the doc comment `/** What happened: field write, field deletion, target document created, target document removed, or nothing. */`.

Add `const GRPC_ALREADY_EXISTS = 6` next to `GRPC_NOT_FOUND`.

Extend `SyncOptions` and `CheckOptions`:

```ts
  /** Already-read base snapshot to use for the first attempt instead of reading again (views with `base`). */
  base?: DocumentSnapshot
  /** Views with `base`: only remove the target when its base is gone; do nothing when the base exists (second pass of `rebuild` / `verify`). */
  orphansOnly?: boolean
```

Change `newResult` to report projections:

```ts
function newResult(rule: ResolvedRule, role: RuleResult['role']): RuleResult {
  const kind = rule.kind === 'view' && rule.projection ? 'projection' : rule.kind
  return { rule: rule.name, kind, role, action: 'skip', targets: 0, writes: 0, retries: 0, reads: 0, queries: 0, aggregations: 0 }
}
```

Add the exported path helpers after `stripUndefined`:

```ts
/** Path of the base document of a target of `view`; `undefined` when the path does not match the view's target pattern. */
export function basePathForTarget(view: ResolvedView, targetPath: string): string | undefined {
  const m = matchDocumentPath(view.targetPattern, targetPath)
  const collection = m && view.basePattern ? resolveCollectionPath(view.basePattern, m.params) : undefined
  return m && collection ? `${collection}/${m.id}` : undefined
}

/** Path of the target that mirrors a base document of `view`; `undefined` when the path does not match the view's base pattern. */
export function targetPathForBase(view: ResolvedView, basePath: string): string | undefined {
  const m = view.basePattern ? matchDocumentPath(view.basePattern, basePath) : undefined
  const collection = m ? resolveCollectionPath(view.targetPattern, m.params) : undefined
  return m && collection ? `${collection}/${m.id}` : undefined
}
```

- [ ] **Step 4: Dispatch base events**

In `docSyncHandler`'s rule loop, inside `if (rule.kind === 'view') {` before the `for (const source of rule.sources)` loop, add:

```ts
      if (rule.basePattern) {
        const asBase = matchDocumentPath(rule.basePattern, document)
        if (asBase) parallel.push({ rule: rule.name, run: () => processor.viewBase(rule, asBase, before, after) })
      }
```

- [ ] **Step 5: `viewBase`, `readBase`, `createTarget`, `removeTarget`, and `syncView` with lifecycle**

Add to `Processor` (views section):

```ts
  /** The base document of a view changed: the target with the same ID is created, updated or removed. */
  async viewBase(view: ResolvedView, match: DocumentMatch, before: DecodedDocument | undefined, after: DecodedDocument | undefined): Promise<RuleResult> {
    const result = newResult(view, 'source')
    result.source = 'base'
    if (before && after && isEqual(before.data, after.data)) {
      result.reason = 'unchanged'
      return result
    }
    const collection = resolveCollectionPath(view.targetPattern, match.params)
    if (!collection) {
      result.reason = 'target collection unresolvable'
      return result
    }
    result.targets = 1
    const counter = new ReadCounter()
    count(result, await this.syncView(this.db().doc(`${collection}/${match.id}`), view, { counter }))
    if (result.writes === 0) result.reason = 'target up to date'
    return finish(result, counter)
  }

  /** The base for this attempt: the caller's snapshot on a first try, else a fresh (counted) read. `undefined` when the target path does not match the view. */
  private async readBase(targetPath: string, view: ResolvedView, opts: { base?: DocumentSnapshot; attempt?: number; sourceCache?: Map<string, Promise<DocumentSnapshot>> }, counter: ReadCounter): Promise<DocumentSnapshot | undefined> {
    if (opts.base && (opts.attempt ?? 0) === 0) return opts.base
    const path = basePathForTarget(view, targetPath)
    if (!path) {
      this.logger.warn('doc-sync: cannot locate base for target, skipped', { rule: view.name, document: targetPath })
      return undefined
    }
    return this.readSource(path, counter, opts.sourceCache)
  }

  /** Creates the target with the plan's values. `ALREADY_EXISTS` means someone else created it meanwhile: `redo` from a fresh read. */
  private async createTarget(ref: DocumentReference, plan: FieldPlan, redo: () => Promise<Outcome>): Promise<Outcome> {
    const data: DocumentData = {}
    for (const [path, desired] of plan) if (desired !== DELETE) setField(data, path, desired)
    try {
      await ref.create(data)
      return 'create'
    } catch (err) {
      if (!isCode(err, GRPC_ALREADY_EXISTS)) throw err
      return redo()
    }
  }

  /** Removes the target conditional on the `updateTime` it was read with. */
  private async removeTarget(ref: DocumentReference, target: DocumentSnapshot, redo: () => Promise<Outcome>): Promise<Outcome> {
    try {
      await ref.delete({ lastUpdateTime: target.updateTime })
      return 'remove'
    } catch (err) {
      if (isCode(err, GRPC_NOT_FOUND)) return 'skip'
      if (!isCode(err, GRPC_FAILED_PRECONDITION)) throw err
      return redo()
    }
  }
```

Replace `syncView` with:

```ts
  /**
   * Reads the target (and the base, for views with `base`), computes the declared fields with
   * `patch` (when a `change` is given and the view defines one) or `build`, and writes the paths
   * that differ, conditional on the target's `updateTime`. With `base`: a missing base removes
   * the target, a missing target is created.
   */
  async syncView(ref: DocumentReference, view: ResolvedView, opts: SyncOptions & { change?: ViewChange; changeCache?: ChangeCache }): Promise<Outcome> {
    const attempt = opts.attempt ?? 0
    if (attempt > this.maxRetries) throw new RetriesExhaustedError(ref.path, attempt)
    const counter = opts.counter ?? new ReadCounter()
    const target = await this.readTarget(ref, opts, counter)
    // A redo re-reads everything: no cached target, base or source (the page cache may hold the base as it was before another writer changed it).
    const redo = () => this.syncView(ref, view, { ...opts, counter, attempt: attempt + 1, target: undefined, base: undefined, sourceCache: undefined })
    let base: DocumentSnapshot | undefined
    if (view.basePattern) {
      base = await this.readBase(ref.path, view, { ...opts, attempt }, counter)
      if (!base) return 'skip'
      if (!base.exists) {
        if (!target.exists) return 'skip'
        return opts.dryRun ? 'remove' : this.removeTarget(ref, target, redo)
      }
      if (opts.orphansOnly) return 'skip'
    } else if (!target.exists) return 'skip'
    // A redo re-read the target, so the changed document must be re-read after it as well.
    const { plan } = await this.computeView(target, view, { ...opts, counter, base, changeCache: attempt === 0 ? opts.changeCache : undefined })
    if (plan === NOTHING) return 'skip'
    if (!target.exists) return opts.dryRun ? 'create' : this.createTarget(ref, plan, redo)
    const { updates, outcome } = planUpdates(target, plan)
    if (outcome === 'skip') return 'skip'
    if (opts.dryRun) return outcome
    return this.write(ref, target, updates, outcome, redo)
  }
```

Thread `base` through compute: add `base?: DocumentSnapshot` to the `opts` type of `computeView`, pass `base` into `patchWith` and `buildValue` as an extra parameter, and give it to user code: `view.patch!(this.currentValues(view, target), fresh, { target, base, firestore })` and `view.build({ target, base, sources, firestore })`.

In `viewTarget`, replace

```ts
    if (!after) {
      result.reason = 'target deleted'
      return result
    }
```
with
```ts
    if (!after && !view.basePattern) {
      result.reason = 'target deleted'
      return result
    }
    if (!after) {
      // The target of a base view was deleted by hand: recreate it while the base exists.
      const counter = new ReadCounter()
      count(result, await this.syncView(this.db().doc(target.path), view, { counter }))
      if (result.writes === 0) result.reason = 'base missing too'
      return finish(result, counter)
    }
```

Replace `checkView` (Task 2) with the base-aware version:

```ts
  private async checkView(target: DocumentSnapshot, view: ResolvedView, opts: CheckOptions): Promise<CheckResult> {
    const counter = opts.counter ?? new ReadCounter()
    let base: DocumentSnapshot | undefined
    if (view.basePattern) {
      base = await this.readBase(target.ref.path, view, { base: opts.base, sourceCache: opts.sourceCache }, counter)
      if (!base) return { status: 'skip', reason: 'base unresolvable' }
      if (!base.exists) return target.exists ? { status: 'mismatch', issue: 'orphan' } : { status: 'skip', reason: 'base and target missing' }
      if (opts.orphansOnly) return { status: 'ok' }
    } else if (!target.exists) return { status: 'skip', reason: 'target missing' }
    const { plan, reason } = await this.computeView(target, view, { counter, base })
    if (plan === NOTHING) return { status: 'skip', reason }
    if (!target.exists) {
      const fields: FieldMismatch[] = [...plan].filter(([, d]) => d !== DELETE).map(([field, expected]) => ({ field, actual: undefined, expected }))
      return { status: 'mismatch', issue: 'missing', fields }
    }
    return checkPlan(target, plan)
  }
```

- [ ] **Step 6: Run the view tests, then everything**

Run: `firebase emulators:exec --only firestore --project demo-doc-sync "$(which node) ./node_modules/vitest/vitest.mjs run test/view.test.ts"` then `npm run typecheck && npm test`
Expected: PASS. `test/handler.test.ts` or `test/dev.test.ts` may compare `RuleResult.action` against a narrowed union; widen those assertions to the new `Outcome`.

- [ ] **Step 7: Commit**

```bash
git add src/handler.ts test/view.test.ts
git commit -m "handler: a view with base creates and removes its target; base events recompute the same-id target

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `rebuild` and `verify` walk base views in two passes

**Files:**
- Modify: `src/walk.ts`, `src/rebuild.ts`, `src/verify.ts`, `src/index.ts` (export `FieldMismatch`)
- Test: `test/view.test.ts`

**Interfaces:**
- Consumes: `targetPathForBase`, `SyncOptions.base`/`orphansOnly`, `CheckOptions.base`/`orphansOnly`, `CheckResult.issue` (Task 5).
- Produces: `walkCollection(firestore, pattern: CollectionPattern, opts, visit, onPage)`; `Mismatch.issue` reported as `missing` / `orphan`; `rebuild`/`verify` `scanned` counts base documents plus target documents for base views.

- [ ] **Step 1: Write the failing tests**

Append to `test/view.test.ts` (the `publicView` / `cfg` definitions from Task 5 are in another `describe`; copy them into this one under the same names):

```ts
describe('views: rebuild and verify with base', () => {
  const publicView = defineView({
    name: 'post-public',
    target: 'postPublic',
    base: 'post',
    targetFields: ['title', 'commentCount'],
    sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
    build: ({ base, sources }) => ({ title: base!.get('title'), commentCount: sources.comments.length }),
  })
  const cfg = defineConfig({ ...config, rules: [publicView] })

  it('rebuild creates missing targets, updates stale ones and removes orphans', async () => {
    await db.doc('post/p1').set({ title: 'a' }) // no target yet
    await db.doc('post/p2').set({ title: 'b' })
    await db.doc('postPublic/p2').set({ title: 'old', commentCount: 0 }) // stale
    await db.doc('postPublic/orphan').set({ title: 'x' }) // base gone
    const [dry] = await rebuild(cfg, { firestore: db, logger: silentLogger(), dryRun: true })
    expect(dry).toMatchObject({ scanned: 4, written: 3 })
    expect((await db.doc('postPublic/p1').get()).exists).toBe(false)
    const [r] = await rebuild(cfg, { firestore: db, logger: silentLogger() })
    expect(r).toMatchObject({ scanned: 5, written: 3 }) // pass 2 also visits postPublic/p1, which pass 1 just created
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a', commentCount: 0 })
    expect((await db.doc('postPublic/p2').get()).data()).toEqual({ title: 'b', commentCount: 0 })
    expect((await db.doc('postPublic/orphan').get()).exists).toBe(false)
  })

  it('rebuild resumes inside the target collection without walking the bases again', async () => {
    await db.doc('post/p1').set({ title: 'a' })
    await db.doc('postPublic/orphan').set({ title: 'x' })
    await db.doc('postPublic/zz').set({ title: 'y' })
    const [r] = await rebuild(cfg, { firestore: db, logger: silentLogger(), startAfter: 'postPublic/orphan' })
    expect(r).toMatchObject({ scanned: 1, written: 1 })
    expect((await db.doc('postPublic/p1').get()).exists).toBe(false) // base walk skipped
    expect((await db.doc('postPublic/orphan').get()).exists).toBe(true) // before the cursor
    expect((await db.doc('postPublic/zz').get()).exists).toBe(false)
  })

  it('verify reports missing targets, differing fields and orphans, and fixes all three', async () => {
    await db.doc('post/p1').set({ title: 'a' })
    await db.doc('post/p2').set({ title: 'b' })
    await db.doc('postPublic/p2').set({ title: 'old', commentCount: 0 })
    await db.doc('postPublic/orphan').set({ title: 'x' })
    const [report] = await verify(cfg, { firestore: db, logger: silentLogger() })
    expect(report!.mismatches.map((m) => [m.document, m.issue, m.field])).toEqual([
      ['postPublic/p1', 'missing', undefined],
      ['postPublic/p2', 'value', 'title'],
      ['postPublic/orphan', 'orphan', undefined],
    ])
    expect((await db.doc('postPublic/p1').get()).exists).toBe(false)
    const [fixed] = await verify(cfg, { firestore: db, logger: silentLogger(), fix: true })
    expect(fixed!.fixed).toBe(3)
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a', commentCount: 0 })
    expect((await db.doc('postPublic/p2').get()).get('title')).toBe('b')
    expect((await db.doc('postPublic/orphan').get()).exists).toBe(false)
    expect((await verify(cfg, { firestore: db, logger: silentLogger() }))[0]!.mismatched).toBe(0)
  })
})
```

- [ ] **Step 2: Run the file; the three tests fail**

Run: `firebase emulators:exec --only firestore --project demo-doc-sync "$(which node) ./node_modules/vitest/vitest.mjs run test/view.test.ts"`
Expected: FAIL (`postPublic/p1` never created by rebuild; verify has no `missing`).

- [ ] **Step 3: `walkCollection`**

In `src/walk.ts`, rename the existing `walkTargets` body into `walkCollection` taking a pattern, and make `walkTargets` delegate:

```ts
/**
 * Visits every document of a collection pattern in document-name order, `concurrency` at a
 * time within a page. Returns the number of documents visited and the path of the last one
 * (pass it back as `startAfter` to resume).
 */
export async function walkCollection(
  firestore: Firestore,
  pattern: CollectionPattern,
  opts: WalkOptions,
  visit: (doc: QueryDocumentSnapshot, page: WalkPage) => Promise<void>,
  onPage?: (progress: { scanned: number; lastPath: string }) => void,
): Promise<{ scanned: number; lastPath: string | undefined }> {
  const { pageSize, concurrency } = opts
  const base = pattern.params.length ? firestore.collectionGroup(pattern.collectionId) : firestore.collection(pattern.raw)
  let cursor: DocumentSnapshot | undefined
  if (opts.startAfter) {
    opts.counter?.doc()
    cursor = await firestore.doc(opts.startAfter).get()
    if (!cursor.exists) throw new Error(`cannot resume: ${opts.startAfter} does not exist`)
  }

  let scanned = 0
  let lastPath: string | undefined
  for (;;) {
    const page = await (cursor ? base.startAfter(cursor) : base).limit(pageSize).get()
    opts.counter?.query(page.size)
    if (page.empty) break
    const docs = page.docs.filter((d) => matchDocumentPath(pattern, d.ref.path))
    const sourceCache = new Map<string, Promise<DocumentSnapshot>>()

    await forEachLimit(docs, concurrency, (doc) => visit(doc, { sourceCache }))

    scanned += docs.length
    lastPath = page.docs[page.docs.length - 1]!.ref.path
    onPage?.({ scanned, lastPath })
    if (page.size < pageSize) break
    cursor = page.docs[page.docs.length - 1]
  }
  return { scanned, lastPath }
}

/** {@link walkCollection} over the rule's target collection(s). */
export function walkTargets(
  firestore: Firestore,
  rule: ResolvedRule,
  opts: WalkOptions,
  visit: (target: QueryDocumentSnapshot, page: WalkPage) => Promise<void>,
  onPage?: (progress: { scanned: number; lastPath: string }) => void,
): Promise<{ scanned: number; lastPath: string | undefined }> {
  return walkCollection(firestore, rule.targetPattern, opts, visit, onPage)
}
```

Delete the private `targetsQuery` and import `CollectionPattern` from `./paths.js`.

- [ ] **Step 4: Two-pass `rebuild`**

Replace the per-rule loop body of `rebuild` in `src/rebuild.ts` with:

```ts
  for (const rule of selected) {
    let written = 0
    let scanned = 0
    let lastPath: string | undefined
    const counter = new ReadCounter()
    const progress = (p: { scanned: number; lastPath: string }) =>
      options.onProgress?.({ rule: rule.name, scanned: scanned + p.scanned, written, lastPath: p.lastPath, ...counter.counts() })
    const report = (document: string, outcome: Outcome) => {
      if (outcome === 'skip') return
      written++
      if (options.dryRun) logger.info('doc-sync rebuild: would write', { rule: rule.name, document, action: outcome })
    }
    const baseView = rule.kind === 'view' && rule.basePattern ? rule : undefined
    const resumeInTargets = startAfter !== undefined && matchDocumentPath(rule.targetPattern, startAfter) !== undefined

    // Pass 1 (views with `base`): every base document gets its target created or brought up to date.
    if (baseView?.basePattern && !resumeInTargets) {
      const walked = await walkCollection(
        options.firestore,
        baseView.basePattern,
        { pageSize, concurrency, startAfter, counter },
        async (baseDoc, page) => {
          const targetPath = targetPathForBase(baseView, baseDoc.ref.path)
          if (!targetPath) return
          report(targetPath, await processor.sync(options.firestore.doc(targetPath), rule, { base: baseDoc, sourceCache: page.sourceCache, dryRun: options.dryRun, counter }))
        },
        progress,
      )
      scanned += walked.scanned
      lastPath = walked.lastPath ?? lastPath
      startAfter = undefined
    }

    // Pass 2: every existing target. For a base view only orphans are removed here (pass 1 synced the rest).
    const walked = await walkTargets(
      options.firestore,
      rule,
      { pageSize, concurrency, startAfter, counter },
      async (target, page) => {
        report(target.ref.path, await processor.sync(target.ref, rule, { target, sourceCache: page.sourceCache, dryRun: options.dryRun, counter, orphansOnly: baseView !== undefined }))
      },
      progress,
    )
    scanned += walked.scanned
    lastPath = walked.lastPath ?? lastPath
    startAfter = undefined
    results.push({ rule: rule.name, scanned, written, lastPath, kind: rule.kind, dryRun: Boolean(options.dryRun), ...counter.counts() })
  }
```

Imports: `import { type Outcome, Processor, targetPathForBase } from './handler.js'`, `import { matchDocumentPath } from './paths.js'`, `import { selectRules, walkCollection, walkTargets } from './walk.js'`.

- [ ] **Step 5: Two-pass `verify`**

Replace the per-rule loop body of `verify` in `src/verify.ts` with:

```ts
  for (const rule of selected) {
    let mismatched = 0
    let fixed = 0
    let scanned = 0
    let lastPath: string | undefined
    const mismatches: Mismatch[] = []
    let pending: Mismatch[] = []
    const counter = new ReadCounter()
    const baseView = rule.kind === 'view' && rule.basePattern ? rule : undefined
    const resumeInTargets = startAfter !== undefined && matchDocumentPath(rule.targetPattern, startAfter) !== undefined

    const record = (document: string, check: CheckResult, didFix: boolean) => {
      if (check.issue === 'missing' || check.issue === 'orphan') {
        pending.push({ rule: rule.name, document, issue: check.issue, fixed: didFix })
        return
      }
      for (const f of check.fields ?? []) {
        pending.push({ rule: rule.name, document, issue: 'value', field: f.field, actual: f.actual, expected: f.expected, fixed: didFix })
      }
    }
    const flush = (p: { scanned: number; lastPath: string }) => {
      pending.sort((a, b) => (a.document < b.document ? -1 : a.document > b.document ? 1 : 0))
      for (const m of pending) {
        mismatched++
        if (m.fixed) fixed++
        mismatches.push(m)
        // Values are not logged (they may hold personal data); they are in the returned `Mismatch` and in `onMismatch`.
        logger.info('doc-sync verify: mismatch', { rule: m.rule, document: m.document, issue: m.issue, field: m.field, fixed: m.fixed })
        options.onMismatch?.(m)
      }
      pending = []
      options.onProgress?.({ rule: rule.name, scanned: scanned + p.scanned, mismatched, fixed, lastPath: p.lastPath, ...counter.counts() })
    }

    // Pass 1 (views with `base`): a base without a target is `missing`; an existing target is checked field by field.
    if (baseView?.basePattern && !resumeInTargets) {
      const walked = await walkCollection(
        options.firestore,
        baseView.basePattern,
        { pageSize, concurrency, startAfter, counter },
        async (baseDoc, page) => {
          const targetPath = targetPathForBase(baseView, baseDoc.ref.path)
          if (!targetPath) return
          counter.doc()
          const target = await options.firestore.doc(targetPath).get()
          const check = await processor.check(target, rule, { base: baseDoc, sourceCache: page.sourceCache, counter })
          if (check.status !== 'mismatch') return
          let didFix = false
          if (fix) {
            await processor.sync(target.ref, rule, { target, base: baseDoc, sourceCache: page.sourceCache, counter })
            didFix = true
          }
          record(targetPath, check, didFix)
        },
        flush,
      )
      scanned += walked.scanned
      lastPath = walked.lastPath ?? lastPath
      startAfter = undefined
    }

    // Pass 2: every existing target. For a base view only orphans are reported here (pass 1 covered the values).
    const walked = await walkTargets(
      options.firestore,
      rule,
      { pageSize, concurrency, startAfter, counter },
      async (target, page) => {
        const check = await processor.check(target, rule, { sourceCache: page.sourceCache, counter, orphansOnly: baseView !== undefined })
        if (check.status !== 'mismatch') return
        let didFix = false
        if (fix) {
          // `sync` re-reads before writing; a skip means someone else corrected the value (or removed the target) meanwhile.
          await processor.sync(target.ref, rule, { target, sourceCache: page.sourceCache, counter, orphansOnly: baseView !== undefined })
          didFix = true
        }
        record(target.ref.path, check, didFix)
      },
      flush,
    )
    scanned += walked.scanned
    lastPath = walked.lastPath ?? lastPath
    startAfter = undefined
    results.push({ rule: rule.name, scanned, mismatched, fixed, lastPath, kind: rule.kind, fix, mismatches, ...counter.counts() })
  }
```

Imports: `import { type CheckResult, Processor, targetPathForBase } from './handler.js'`, `import { matchDocumentPath } from './paths.js'`, `import { selectRules, walkCollection, walkTargets } from './walk.js'`. Export `type FieldMismatch` and `type CheckResult` from `src/index.ts` next to `RuleResult`.

- [ ] **Step 6: Run the suite**

Run: `npm run typecheck && npm test`
Expected: PASS, including the older `test/verify.test.ts` / `test/rebuild.test.ts` (non-base rules take only pass 2, unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/walk.ts src/rebuild.ts src/verify.ts src/index.ts test/view.test.ts
git commit -m "rebuild/verify: walk the base collection first for base views; report missing and orphan targets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `'rest'`

**Files:**
- Modify: `src/config.ts` (reserved root keys after the view loop), `src/handler.ts` (`planOf`, `currentValues`)
- Test: `test/unit/config.test.ts`, `test/view.test.ts`

**Interfaces:**
- Consumes: `ResolvedView.rest`, `reservedRootKeys` (declared in Task 2, filled here).

- [ ] **Step 1: Failing unit test for the reserved keys**

Inside `describe('views')` of `test/unit/config.test.ts`:

```ts
    it('computes the root keys a rest view must never touch', () => {
      const restView = defineView({ name: 'post-public', target: 'postPublic', base: 'post', targetFields: ['rest', 'stats.commentCount'], build: ({ base }) => ({ ...base!.data() }) })
      const likes = defineAggregate({ name: 'post-public-likes', source: 'postPublic/{postId}/like', target: 'postPublic', idParam: 'postId', aggregate: 'count', targetField: 'stats.likeCount' })
      const author = defineConnection({ name: 'post-public-author', source: 'user', target: 'postPublic', idField: 'authorId', fields: ['name'], targetField: 'author' })
      const r = validateConfig({ ...base, rules: [restView, likes, author] })
      expect(r.views[0]).toMatchObject({ rest: true, reservedRootKeys: ['author', 'authorId', 'stats'] })
      const second = defineView({ name: 'post-public-2', target: 'postPublic', base: 'post', targetFields: ['rest'], build: () => ({}) })
      expect(problemsOf({ ...base, rules: [restView, second] })).toContainEqual(expect.stringContaining(`view "post-public-2": only one view per target may declare 'rest' (view "post-public" already does)`))
    })
```

Run: `npm run test:unit -- test/unit/config.test.ts` → FAIL (`reservedRootKeys: []`).

- [ ] **Step 2: Fill `reservedRootKeys` after all rules are resolved; one `rest` view per target**

In `validateConfig`, directly before the comment `// Two rules must not write overlapping fields of the same collection`, add:

```ts
  // Two `rest` views on one target would each delete what the other wrote.
  const restOwner = new Map<string, string>()
  for (const view of resolvedViews) {
    if (!view.rest) continue
    const prev = restOwner.get(view.targetPattern.key)
    if (prev) problems.push(`view "${view.name}": only one view per target may declare 'rest' (view "${prev}" already does)`)
    else restOwner.set(view.targetPattern.key, view.name)
  }
  // `rest` owns every root key no rule declares: collect the declared roots per target collection.
  for (const view of resolvedViews) {
    if (!view.rest) continue
    const roots = new Set<string>()
    for (const w of writtenFields) if (w.target.key === view.targetPattern.key) roots.add(splitFieldPath(w.field)[0]!)
    for (const id of idFields) if (id.target.key === view.targetPattern.key) roots.add(splitFieldPath(id.field)[0]!)
    view.reservedRootKeys = [...roots].sort()
  }
```

- [ ] **Step 3: Failing integration test**

Append to `test/view.test.ts` (needs `defineAggregate` added to the import from `../src/index.js`):

```ts
describe('views: rest', () => {
  const mirror = defineView({
    name: 'post-mirror',
    target: 'postPublic',
    base: 'post',
    targetFields: ['rest', 'stats.commentCount'],
    sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
    build: ({ base, sources }) => {
      const { secret: _secret, ...rest } = base!.data() as Record<string, unknown>
      return { ...rest, stats: { commentCount: sources.comments.length }, likeCount: 999 }
    },
  })
  const likes = defineAggregate({ name: 'post-mirror-likes', source: 'postPublic/{postId}/like', target: 'postPublic', idParam: 'postId', aggregate: 'count', targetField: 'likeCount' })
  const cfg = defineConfig({ ...config, rules: [mirror, likes] })

  it('writes the undeclared root keys, deletes the ones that disappeared and never touches reserved keys', async () => {
    const post = db.doc('post/p1')
    await post.set({ title: 'a', tags: ['x'], secret: 's' })
    await db.doc('postPublic/p1').set({ title: 'old', stale: true, likeCount: 3, stats: { likeAvg: 1 } })
    const { handler, logs } = handlerFor(cfg)
    await invoke(handler, await change(post, () => post.update({ tags: ['y'] })))
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a', tags: ['y'], likeCount: 3, stats: { likeAvg: 1, commentCount: 0 } })
    const ignored = logs.filter((l) => l.message === 'doc-sync: build returned a field the view does not declare, ignored').map((l) => l.fields?.field)
    expect(ignored).toEqual(['likeCount'])
  })

  it('gives patch the rest keys too', async () => {
    const patched = defineView({
      name: 'post-mirror-patched',
      target: 'postPublic',
      base: 'post',
      targetFields: ['rest', 'stats.commentCount'],
      sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
      build: ({ base, sources }) => ({ ...(base!.data() as Record<string, unknown>), stats: { commentCount: sources.comments.length } }),
      patch: (current, change) => (change.after && !change.before ? { ...current, stats: { commentCount: ((current.stats as { commentCount?: number } | undefined)?.commentCount ?? 0) + 1 } } : undefined),
    })
    await db.doc('post/p1').set({ title: 'a' })
    await db.doc('postPublic/p1').set({ title: 'a', stats: { commentCount: 2 } })
    const { handler } = handlerFor(defineConfig({ ...config, rules: [patched] }))
    const c = db.doc('post/p1/comment/c3')
    await invoke(handler, await change(c, () => c.set({ body: 'x' })))
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a', stats: { commentCount: 3 } })
  })
})
```

Run the view file → the two tests FAIL (rest keys not written; `stale` kept).

- [ ] **Step 4: Implement `rest` in `planOf` and `currentValues`**

Replace `planOf` in `src/handler.ts` with:

```ts
  /**
   * Reads the declared paths out of a build/patch result; a missing path becomes a deletion.
   * With `rest`, every root key of the result that no rule reserves is written too, and every
   * such key on the target that the result lacks is deleted. Undeclared paths are warned about once and ignored.
   */
  private planOf(view: ResolvedView, target: DocumentSnapshot, built: DocumentData | undefined): FieldPlan {
    const plan: FieldPlan = new Map()
    for (const path of view.targetFields) {
      const v = getField(built, path)
      plan.set(path, v === undefined ? DELETE : v)
    }
    if (view.rest) {
      const reserved = new Set(view.reservedRootKeys)
      for (const [key, value] of Object.entries(built ?? {})) {
        if (reserved.has(key)) continue
        if (key.includes('.') || !isValidFieldPath(key)) {
          this.logger.warn('doc-sync: build returned a root key that is not a valid field name, ignored', { rule: view.name, field: key })
          continue
        }
        plan.set(key, value)
      }
      for (const key of Object.keys(target.exists ? (target.data() ?? {}) : {})) {
        if (reserved.has(key) || plan.has(key)) continue
        if (key.includes('.') || !isValidFieldPath(key)) {
          // `update()` would read a dotted key as a path (and reject reserved characters): leave such keys alone rather than fail every event.
          this.logger.warn('doc-sync: target has a root key that is not a valid field name, left in place', { rule: view.name, document: target.ref.path, field: key })
          continue
        }
        plan.set(key, DELETE)
      }
    }
    this.warnUndeclared(view, built)
    return plan
  }
```

Replace `currentValues` with:

```ts
  /** The declared paths of `view` as they are on `target` (plus every unreserved root key for `rest`), as a nested object: what `patch` receives. */
  private currentValues(view: ResolvedView, target: DocumentSnapshot): DocumentData {
    const out: DocumentData = {}
    for (const path of view.targetFields) {
      const v: unknown = target.get(path)
      if (v !== undefined) setField(out, path, v)
    }
    if (view.rest) {
      const reserved = new Set(view.reservedRootKeys)
      for (const [key, value] of Object.entries(target.data() ?? {})) if (!reserved.has(key) && !(key in out)) out[key] = value
    }
    return out
  }
```

Import `isValidFieldPath` from `./fields.js` in `src/handler.ts`.

- [ ] **Step 5: Run everything**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/handler.ts test/unit/config.test.ts test/view.test.ts
git commit -m "views: 'rest' writes and prunes the root keys no rule declares (base views only)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `defineProjection`

**Files:**
- Modify: `src/config.ts` (new `ProjectionRule`, `defineProjection`, categorisation, conversion into the view list), `src/index.ts`
- Test: `test/unit/config.test.ts`, `test/view.test.ts`

**Interfaces:**
- Produces: `export interface ProjectionRule { kind: 'projection'; name: string; base: string; target: string; targetFields: string[] }`; `export function defineProjection(rule: Omit<ProjectionRule, 'kind'>): ProjectionRule`; `Rule = Connection | AggregateRule | ViewRule | ProjectionRule`; a projection resolves into `ResolvedConfig.views` with `projection: true`, `sources: []` and a generated `build`.

- [ ] **Step 1: Failing unit tests**

Add `defineProjection` to the import of `test/unit/config.test.ts` and `import type { DocumentSnapshot } from 'firebase-admin/firestore'`. Add a new `describe`:

```ts
  describe('projections', () => {
    const projection = defineProjection({ name: 'user-public', base: 'user', target: 'userPublic', targetFields: ['displayName', 'profile.bio'] })

    it('becomes a view with base, no sources and a build that copies the declared paths', async () => {
      const r = validateConfig({ ...base, rules: [projection] })
      const v = r.views[0]!
      expect(v).toMatchObject({ kind: 'view', projection: true, name: 'user-public', base: 'user', targetFields: ['displayName', 'profile.bio'], rest: false, sources: [] })
      const snap = { get: (p: string) => ({ displayName: 'D' } as Record<string, unknown>)[p] } as unknown as DocumentSnapshot
      expect(await v.build({ base: snap, target: snap, sources: {}, firestore: {} as never })).toEqual({ displayName: 'D' })
      expect(collectionsOf(r).map((p) => p.raw)).toEqual(expect.arrayContaining(['user', 'userPublic']))
    })

    it('rejects rest, sources, build, patch and a missing base', () => {
      expect(problemsOf({ ...base, rules: [{ ...projection, targetFields: ['rest'] }] })).toContainEqual(expect.stringContaining("'rest' is not supported by a projection"))
      expect(problemsOf({ ...base, rules: [{ ...projection, build: () => ({}) } as never] })).toContainEqual(expect.stringContaining('`build` does not apply to a projection'))
      expect(problemsOf({ ...base, rules: [{ ...projection, sources: {} } as never] })).toContainEqual(expect.stringContaining('`sources` does not apply to a projection'))
      expect(problemsOf({ ...base, rules: [{ ...projection, exclude: ['email'] } as never] })).toContainEqual(expect.stringContaining('`exclude` does not apply to a projection'))
      expect(problemsOf({ ...base, rules: [{ ...projection, base: undefined } as never] })).toContainEqual(expect.stringContaining('projection "user-public": `base` is required'))
      expect(problemsOf({ ...base, rules: [{ ...projection, targetFields: 'displayName' } as never] })).toContainEqual(expect.stringContaining('projection "user-public": `targetFields` must be a non-empty array'))
    })
  })
```

Run: `npm run test:unit -- test/unit/config.test.ts` → FAIL (`defineProjection` missing).

- [ ] **Step 2: Types and `defineProjection`**

In `src/config.ts`, after `ViewRule`:

```ts
/**
 * Projection: `target/{id}` mirrors the declared paths of `base/{id}` and exists exactly when
 * the base does. A view with `base`, no `sources` and a generated `build`; add aggregates or
 * views on `target` for derived fields.
 */
export interface ProjectionRule {
  kind: 'projection'
  /** Unique name, used in logs. */
  name: string
  /** Collection to mirror. */
  base: string
  /** Collection receiving one document per base document, same ID. Same placeholders as `base`. */
  target: string
  /** Paths copied from the base as they are. `'rest'` is not supported. */
  targetFields: string[]
}

/** One rule of any kind. */
export type Rule = Connection | AggregateRule | ViewRule | ProjectionRule
```
(remove the earlier `Rule` declaration), and next to `defineView`:

```ts
/** Tags a projection with its `kind` so it can go into `rules`. */
export function defineProjection(rule: Omit<ProjectionRule, 'kind'>): ProjectionRule {
  return { kind: 'projection', ...rule }
}

/** The `build` of a projection: the declared paths of the base, as they are. */
function projectionBuild(paths: string[]): ViewRule['build'] {
  return ({ base }) => {
    const out: DocumentData = {}
    for (const p of paths) {
      const v: unknown = base!.get(p)
      if (v !== undefined) setField(out, p, v)
    }
    return out
  }
}
```

Import `setField` from `./fields.js`. Update the `rules[]` doc comment on `DocSyncConfig` to list `defineProjection` as well.

- [ ] **Step 3: Categorise and convert**

In `validateConfig`, where rules are split by `kind` (around `else if (kind === 'view') viewList.push(...)`), change the list element type to `{ rule: ViewRule; i: number; label?: string; projection?: true }`, add `const projList: { rule: ProjectionRule; i: number }[] = []`, add the branch `else if (kind === 'projection') projList.push({ rule: r as ProjectionRule, i })`, and change the error message to `` `rules[${i}]: \`kind\` must be 'connection' | 'aggregate' | 'view' | 'projection' (use defineConnection / defineAggregate / defineView / defineProjection)` ``.

Before `viewList.forEach(...)`, add:

```ts
  projList.forEach(({ rule: p, i }) => {
    const label = str(p?.name) ? `projection "${p.name}"` : `rules[${i}]`
    if (!p || typeof p !== 'object') {
      problems.push(`${label}: must be an object`)
      return
    }
    let ok = true
    if (!str(p.base)) {
      problems.push(`${label}: \`base\` is required`)
      ok = false
    }
    if (!Array.isArray(p.targetFields) || p.targetFields.length === 0 || !p.targetFields.every((f) => typeof f === 'string')) {
      problems.push(`${label}: \`targetFields\` must be a non-empty array of field paths`)
      ok = false
    } else if (p.targetFields.includes('rest')) {
      problems.push(`${label}: 'rest' is not supported by a projection`)
      ok = false
    }
    for (const k of ['sources', 'build', 'patch', 'exclude', 'rename'] as const) {
      if (k in p) {
        problems.push(`${label}: \`${k}\` does not apply to a projection`)
        ok = false
      }
    }
    if (!ok) return
    viewList.push({
      rule: { kind: 'view', name: p.name, target: p.target, base: p.base, targetFields: p.targetFields, build: projectionBuild(p.targetFields) },
      i,
      label,
      projection: true,
    })
  })
```

In the view loop, change the first two lines to use the entry's label and flag:

```ts
  viewList.forEach(({ rule: v, i, label: givenLabel, projection }) => {
    const label = givenLabel ?? (str(v?.name) ? `view "${v.name}"` : `rules[${i}]`)
```

and add `projection,` to the `resolvedViews.push({...})` object (the property is `undefined` for ordinary views, which `toMatchObject` tolerates).

Export `defineProjection` and `type ProjectionRule` from `src/index.ts`.

- [ ] **Step 4: Integration test**

Append to `test/view.test.ts` (add `defineProjection` to the `../src/index.js` import and `import { FieldValue } from 'firebase-admin/firestore'`):

```ts
describe('projections', () => {
  const userPublic = defineProjection({ name: 'user-public', base: 'user', target: 'userPublic', targetFields: ['displayName', 'profile.bio'] })
  const cfg = defineConfig({ ...config, rules: [userPublic] })

  it('mirrors the declared paths and follows the base lifecycle', async () => {
    const user = db.doc('user/u1')
    const pub = db.doc('userPublic/u1')
    const { handler, logs } = handlerFor(cfg)
    await invoke(handler, await change(user, () => user.set({ displayName: 'D', email: 'e', profile: { bio: 'b', phone: 'p' } })))
    expect((await pub.get()).data()).toEqual({ displayName: 'D', profile: { bio: 'b' } })
    expect(processed(logs, 'user-public')).toMatchObject({ kind: 'projection', source: 'base', action: 'create' })
    await invoke(handler, await change(user, () => user.update({ 'profile.bio': FieldValue.delete(), email: 'f' })))
    expect((await pub.get()).data()).toEqual({ displayName: 'D', profile: {} })
    await invoke(handler, await change(user, () => user.delete()))
    expect((await pub.get()).exists).toBe(false)
    expect(processed(logs, 'user-public')).toMatchObject({ kind: 'projection', action: 'remove' })
  })

  it('is rebuilt and verified like a base view', async () => {
    await db.doc('user/u1').set({ displayName: 'D' })
    await db.doc('userPublic/gone').set({ displayName: 'x' })
    const [report] = await verify(cfg, { firestore: db, logger: silentLogger() })
    expect(report!.mismatches.map((m) => [m.document, m.issue])).toEqual([
      ['userPublic/u1', 'missing'],
      ['userPublic/gone', 'orphan'],
    ])
    await rebuild(cfg, { firestore: db, logger: silentLogger() })
    expect((await db.doc('userPublic/u1').get()).data()).toEqual({ displayName: 'D' })
    expect((await db.doc('userPublic/gone').get()).exists).toBe(false)
  })
})
```

- [ ] **Step 5: Run everything**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/index.ts test/unit/config.test.ts test/view.test.ts
git commit -m "defineProjection: a base view without build that mirrors declared paths

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Typed config for `targetFields`, `base` and projections

**Files:**
- Modify: `src/types.ts`, `src/index.ts`
- Test: `test/types/typed-config.types.ts` (checked by `npm run typecheck`)

**Interfaces:**
- Produces: `TypedViewRule<C, T, B, TF, S>`, `Declared<T, TF>`, `TypedProjection<C, B, T>`, `Typed.defineProjection`, `TypedBuildContext`/`TypedPatchContext` with `base`.

- [ ] **Step 1: Write the failing type tests**

In `test/types/typed-config.types.ts` add the interfaces and collections:

```ts
interface PostPublic {
  title: string
  likeCount?: number
  stats?: { commentCount: number; likeCount?: number }
}
interface User {
  displayName: string
  email: string
}
interface UserPublic {
  displayName: string
}
```

and extend `Collections` with `postPublic: PostPublic`, `user: User`, `userPublic: UserPublic`. Change the destructuring to `const { defineConfig, defineConnection, defineAggregate, defineView, defineProjection } = typed<Collections>()`.

Rewrite the existing `latest` view so it declares `targetFields: ['latest']`, returns `{ latest: sources.comments.map(...) }` and whose `patch` returns `current`; keep its `@ts-expect-error` cases (adapting `targetField: 'latest'` → `targetFields: ['latest']` in each). Then append:

```ts
// ---------------------------------------------------------------- views with base / several paths

const pub = defineView({
  name: 'post-public',
  target: 'postPublic',
  base: 'post',
  targetFields: ['title', 'stats.commentCount'],
  sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
  build: ({ base, sources }) => {
    const title: string = base.data()!.title
    return { title, stats: { commentCount: sources.comments.length } }
  },
  patch: (current, change) => {
    const n: number | undefined = current.stats?.commentCount
    void change
    return { ...current, stats: { commentCount: (n ?? 0) + 1 } }
  },
})

defineConfig({ name: 'doc-sync', region: 'r', service: 's', serviceAccount: 'sa', rules: [latest, pub] })

defineView({
  name: 'x',
  target: 'postPublic',
  base: 'post',
  targetFields: ['title'],
  // @ts-expect-error likeCount is a target key outside the declared roots
  build: () => ({ title: 't', likeCount: 1 }),
})

defineView({
  name: 'x',
  target: 'postPublic',
  base: 'post',
  targetFields: ['title'],
  // @ts-expect-error title must be a string
  build: () => ({ title: 1 }),
})

defineView({
  name: 'x',
  target: 'postPublic',
  targetFields: ['title'],
  sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
  // @ts-expect-error `base` is undefined on a view without `base`
  build: ({ base }) => ({ title: base.data()!.title }),
})

defineView({
  name: 'x',
  target: 'postPublic',
  base: 'post',
  // @ts-expect-error nope is not a field of postPublic
  targetFields: ['nope'],
  build: () => ({}),
})

// `rest` lets build return any part of the target type
defineView({ name: 'x', target: 'postPublic', base: 'post', targetFields: ['rest'], build: ({ base }) => ({ title: base.data()!.title, stats: { commentCount: 0 } }) })

// ---------------------------------------------------------------- projections

const proj = defineProjection({ name: 'user-public', base: 'user', target: 'userPublic', targetFields: ['displayName'] })
defineConfig({ name: 'doc-sync', region: 'r', service: 's', serviceAccount: 'sa', rules: [proj] })

defineProjection({
  name: 'x',
  base: 'user',
  target: 'userPublic',
  // @ts-expect-error email is not a field of userPublic
  targetFields: ['email'],
})
```

Run: `npm run typecheck` → FAIL (`defineProjection` not returned by `typed()`, `base` unknown).

- [ ] **Step 2: Implement the typed API**

In `src/types.ts`, import `DocumentData` is not needed; add `ProjectionRule` to the import from `./config.js`. Replace `TypedBuildContext`, `TypedPatchContext`, `TypedViewRule`, `TypedRule`, `Typed`, and `typed` with:

```ts
/** The first segment of a field path. */
type Root<P extends string> = P extends `${infer K}.${string}` ? K : P

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

/**
 * What `build` / `patch` return and `patch` receives: the target type, deep-partial, restricted to
 * the root keys of the declared paths (every key with `'rest'`). Target keys outside the declared
 * roots are typed `never` so returning them is a compile error; keys that are not in the target
 * type at all are not caught at compile time (the handler warns at runtime).
 */
export type Declared<T, TF extends string> = 'rest' extends TF
  ? DeepPartial<T>
  : DeepPartial<Pick<T, Extract<Root<TF>, keyof T>>> & { [K in Exclude<keyof T, Root<TF>>]?: never }

type BaseSnapshot<C, B extends Key<C> | undefined> = B extends Key<C> ? DocumentSnapshot<C[B]> : undefined

export interface TypedBuildContext<C, T extends Key<C>, B extends Key<C> | undefined, S extends Record<string, { collection: Key<C> }>> {
  target: DocumentSnapshot<C[T]>
  base: BaseSnapshot<C, B>
  sources: { [N in keyof S]: QueryDocumentSnapshot<SourceDoc<C, S[N]>>[] }
  firestore: Firestore
}

export interface TypedPatchContext<C, T extends Key<C>, B extends Key<C> | undefined> {
  target: DocumentSnapshot<C[T]>
  base: BaseSnapshot<C, B>
  firestore: Firestore
}

export interface TypedViewRule<C, T extends Key<C>, B extends Key<C> | undefined, TF extends FieldPath<C[T]> | 'rest', S extends Record<string, TypedViewSource<C, T>>> {
  kind: 'view'
  name: string
  target: T
  base?: B
  targetFields: TF[]
  sources?: S
  build(ctx: TypedBuildContext<C, T, B, S>): Declared<C[T], TF> | undefined | Promise<Declared<C[T], TF> | undefined>
  patch?(
    current: Declared<C[T], TF>,
    change: TypedViewChange<C, S>,
    ctx: TypedPatchContext<C, T, B>,
  ): Declared<C[T], TF> | undefined | Promise<Declared<C[T], TF> | undefined>
}

export interface TypedProjection<C, B extends Key<C>, T extends Key<C>> {
  kind: 'projection'
  name: string
  base: B
  target: T
  /** Paths that exist on both the base and the target type. */
  targetFields: (FieldPath<C[B]> & FieldPath<C[T]>)[]
}

/** A rule in a typed config: a typed connection, aggregate or projection, or a view made with the typed `defineView`. */
export type TypedRule<C> = AnyTypedConnection<C> | AnyTypedAggregate<C> | ViewRule | ProjectionRule

export interface Typed<C> {
  /** Like `defineConfig`, with `source` / `target` / field names checked against `C`. */
  defineConfig(config: TypedDocSyncConfig<C>): DocSyncConfig
  /** Like `defineConnection`, with `source` / `target` / field names checked against `C`. */
  defineConnection<S extends Key<C>, T extends Key<C>>(rule: Omit<TypedConnection<C, S, T>, 'kind'>): TypedConnection<C, S, T>
  /** Like `defineAggregate`, with `source` / `target` / field names checked against `C`. */
  defineAggregate<S extends Key<C>, T extends Key<C>>(rule: Omit<TypedAggregate<C, S, T>, 'kind'>): TypedAggregate<C, S, T>
  /** Like `defineView`, with `sources` / `base` typed from `C` and `build` / `patch` typed from `targetFields`. */
  defineView<T extends Key<C>, TF extends FieldPath<C[T]> | 'rest', S extends Record<string, TypedViewSource<C, T>> = Record<never, never>, B extends Key<C> | undefined = undefined>(
    view: Omit<TypedViewRule<C, T, B, TF, S>, 'kind'>,
  ): ViewRule
  /** Like `defineProjection`, with `base` / `target` / `targetFields` checked against `C`. */
  defineProjection<B extends Key<C>, T extends Key<C>>(rule: Omit<TypedProjection<C, B, T>, 'kind'>): ProjectionRule
}

/**
 * Binds your collection types. The returned functions only tag rules with their `kind`; the
 * results are ordinary `DocSyncConfig` / rule objects.
 */
export function typed<C extends Collections>(): Typed<C> {
  return {
    defineConfig: (config) => config as unknown as DocSyncConfig,
    defineConnection: (rule) => ({ kind: 'connection', ...rule }),
    defineAggregate: (rule) => ({ kind: 'aggregate', ...rule }),
    defineView: (view) => ({ kind: 'view', ...view }) as unknown as ViewRule,
    defineProjection: (rule) => ({ kind: 'projection', ...rule }) as unknown as ProjectionRule,
  }
}
```

Export `type Declared` and `type TypedProjection` from `src/index.ts` next to `TypedViewRule`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS, with every `@ts-expect-error` consumed. TypeScript does not apply excess-property checks to the returned literal of a contextually typed arrow inside this generic call, which is why `Declared` types the target's undeclared keys as `never` instead; a key that is not in the target type at all (e.g. `extra`) compiles and is caught by the handler's runtime warning.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/index.ts test/types/typed-config.types.ts
git commit -m "typed config: targetFields, base and defineProjection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Cost estimate and CLI summary know about `base`

**Files:**
- Modify: `src/cost.ts` (`estimateViewCost`), `src/cli/commands.ts` (view summary)
- Test: `test/unit/cost.test.ts`, `test/unit/commands.test.ts`

- [ ] **Step 1: Failing cost test**

In `test/unit/cost.test.ts` add:

```ts
  it('adds the base read and a base trigger line for a view with base', () => {
    const cfg = validateConfig({
      ...base,
      rules: [
        defineView({
          name: 'post-public',
          target: 'postPublic',
          base: 'post',
          targetFields: ['title'],
          sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId', limit: 3 } },
          build: ({ base }) => ({ title: base!.get('title') }),
        }),
      ],
    })
    const cost = estimateCost(cfg.views[0]!)
    expect(cost.lines[0]).toEqual({ trigger: 'post/{id} changed', reads: '1 target + 1 base + ≤ 3 comments (+ reads inside build)', writes: '≤ 1 (create / update / remove the target)' })
    expect(cost.lines[1]).toEqual({ trigger: 'post/{postId}/comment/{id} changed', reads: '1 target + 1 base + ≤ 3 comments (+ reads inside build)', writes: '≤ 1' })
    expect(cost.lines[2]!.trigger).toBe('postPublic/{id} created or deleted')
  })
```

Run: `npm run test:unit -- test/unit/cost.test.ts` → FAIL.

- [ ] **Step 2: Implement**

Replace `estimateViewCost` in `src/cost.ts` with:

```ts
function estimateViewCost(rule: ResolvedView): RuleCost {
  const segments = rule.sources.map((s) => {
    if (s.refField !== undefined) return ` + 1 ${s.key}`
    if (s.limit !== undefined) return ` + ≤ ${s.limit} ${s.key}`
    return ` + M ${s.key}`
  })
  const baseRead = rule.base ? ' + 1 base' : ''
  const perTarget = `1 target${baseRead}${segments.join('')} (+ reads inside build)`
  /** Reads of a patch attempt: the target, the base (if any) and the changed document. */
  const direct = rule.base ? 3 : 2

  const lines: CostLine[] = []
  const warnings: string[] = []
  const refFieldNames: string[] = []

  if (rule.base) lines.push({ trigger: `${rule.base}/{id} changed`, reads: perTarget, writes: '≤ 1 (create / update / remove the target)' })

  for (const s of rule.sources) {
    const trigger = `${s.collection}/{id} changed`
    if (s.refField !== undefined) {
      refFieldNames.push(s.refField)
      const reads = rule.patch
        ? `N + N × ${direct} (+ reads inside patch); if patch returns undefined: N + N × (${perTarget})`
        : `N + N × (${perTarget})`
      lines.push({ trigger, reads, writes: '≤ N' })
      warnings.push(
        `source "${s.key}" (refField) fans out: one change of a ${s.collection} document rebuilds every ${rule.target} that points at it`,
      )
      continue
    }

    const isIdField = s.idField !== undefined
    const reads = isIdField
      ? rule.patch
        ? `≤ 2 × ${direct} (+ reads inside patch); if patch returns undefined: ≤ 2 × (${perTarget})`
        : `≤ 2 × (${perTarget})`
      : rule.patch
        ? `${direct} (+ reads inside patch); if patch returns undefined: ${perTarget}`
        : perTarget
    lines.push({ trigger, reads, writes: isIdField ? '≤ 2' : '≤ 1' })
    if (s.limit === undefined && !rule.patch) {
      warnings.push(`source "${s.key}" has no limit and the view has no patch, so every event reads all ${s.collection} documents of the target`)
    }
  }

  const suffix = refFieldNames.length ? ` or ${refFieldNames.join('/')} changed` : ''
  const targetEvents = rule.base ? 'created or deleted' : 'created'
  lines.push({ trigger: `${rule.target}/{id} ${targetEvents}${suffix}`, reads: perTarget, writes: '≤ 1' })

  return { rule: rule.name, kind: rule.kind, lines, warnings }
}
```

In `src/cli/commands.ts`, replace the view summary line with:

```ts
      const shape = `${v.target}.{${[...v.targetFields, ...(v.rest ? ['rest'] : [])].join(',')}}`
      const via = v.projection ? `projection of ${v.base}` : `build(${[...(v.base ? ['base'] : []), ...v.sources.map((s) => s.key)].join(', ')})`
      log(`  ${v.name}: ${via} -> ${shape}${v.base && !v.projection ? ` (base ${v.base}: target exists iff base exists)` : ''}`)
```

Still in `src/cli/commands.ts`, the `verify` command prints each mismatch as `${m.document}.${m.field} actual=… expected=…` (around line 317). Split that line on the issue, keeping whatever prefix / `fixed` decoration it has today:

```ts
      m.issue === 'value' ? `${m.document}.${m.field} actual=${JSON.stringify(m.actual)} expected=${JSON.stringify(m.expected)}` : `${m.document} ${m.issue}`
```

- [ ] **Step 3: Run the unit tests**

Run: `npm run test:unit`
Expected: PASS. If `test/unit/commands.test.ts` asserts the exact view summary line, update that expectation to the new `build(...) -> post.{latestComments}` format.

- [ ] **Step 4: Commit**

```bash
git add src/cost.ts src/cli/commands.ts test/unit/cost.test.ts test/unit/commands.test.ts
git commit -m "validate: base read and base trigger in the cost estimate; summary prints targetFields and base

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Docs, examples, changelog, version

**Files:**
- Modify: `docs/reference.md`, `docs/reference.ja.md`, `README.md`, `README.ja.md`, `CHANGELOG.md`, `examples/functions/src/doc-sync.config.ts`, `package.json`

- [ ] **Step 1: Reference (English)**

In `docs/reference.md`:

(a) In the config table, change the `rules[]` row to:

```md
| `rules[]` | The rules, in any order: `defineConnection(...)`, `defineAggregate(...)`, `defineView(...)`, `defineProjection(...)` (or objects with a `kind`) |
```

(b) Replace the whole `### defineView` section (heading through the `rebuild / verify always use build` bullet) with:

```md
### `defineView`: keep the declared `targetFields` of `target` = the matching paths of `build(...)`

The general form. `defineConnection`, `defineAggregate` and `defineProjection` are shorthands for views of a fixed shape.

| Key | Meaning |
|---|---|
| `target` | Collection holding the derived fields |
| `targetFields` | Field paths this view writes, e.g. `['title', 'stats.commentCount', 'profile']`. Only these paths are taken from the `build` result; a path whose value is `undefined` is deleted. `'rest'` (needs `base`) adds every root key no rule declares |
| `base?` | Collection whose document with the same ID decides whether the target exists (below). Same placeholders as `target` |
| `sources` | Object keyed by the names `build` sees, each a source below. Optional when `base` is set |
| `build({ target, base, sources, firestore })` | Returns an object holding the declared paths, nested (`{ stats: { commentCount: 3 } }`), or `undefined` to delete them all. Must be deterministic. `sources.<key>` is `QueryDocumentSnapshot[]`; `base` is the base document (always exists when `build` runs) |
| `patch?(current, change, { target, base, firestore })` | Optional fast path from the current values (same shape as the `build` result) and one changed document; return `undefined` to fall back to `build` |

| Source key | Relation to the target | Extras |
|---|---|---|
| `idField: 'postId'` | Many-to-one: source field holds the target ID | `orderBy`, `limit`, `watch` |
| `idParam: 'postId'` | Many-to-one: sources under the target path | `orderBy`, `limit`, `watch` |
| `refField: 'authorId'` | One-to-one: target field holds the source ID (0 or 1 document) | `watch` |

- `orderBy`: `['createdAt', ['score', 'desc']]`. `limit`: max documents read. `watch`: source fields that trigger a recompute (default: any change); `idField` and `orderBy` fields are always watched. Every change of the `base` document triggers a recompute.
- Writes: one `update()` of the declared paths whose value differs, conditional on the target's `updateTime`. Fields outside `targetFields` are never touched. Paths in the result that are not declared are logged once (`warn`) and ignored.
- `base`: `target/{id}` exists exactly when `base/{id}` exists, judged by a fresh read on every event of the base, of a source or of the target. A missing target is created with `create()`; a target whose base is gone is deleted with `delete({ lastUpdateTime })`. Subcollections of a deleted target are not deleted (Firestore semantics). Several views may share one `base` for a target; `validate` requires them to agree. Other rules on that target skip while it does not exist and catch up on the create event.
- `'rest'`: owns every root key of the target that no rule writes or uses as an id. Such keys in the `build` result are written; such keys on the target that the result lacks are deleted. Only on a view with `base`.
- `build` / `patch` results: `undefined` map entries are dropped, `undefined` array elements become `null`.
- `change.after` is a fresh read of the changed document (`undefined` if it was deleted or no longer belongs to this target). `patch` must be idempotent and key items by document ID.
- Target side: recomputed on create, when a `refField` changes, when a declared path was removed, and, with `base`, when the target was deleted (it is recreated while the base exists). Other target fields `build` reads are not watched.
- `rebuild` / `verify` always use `build`. For a view with `base` they walk the base collection first (creating / checking targets), then the target collection (removing / reporting targets whose base is gone). `verify` reports each finding with `issue: 'value' | 'missing' | 'orphan'`.

### `defineProjection`: a view with `base` and no `build`

| Key | Meaning |
|---|---|
| `base` | Collection to mirror |
| `target` | Collection receiving `target/{id}` for every `base/{id}`. Same placeholders as `base` |
| `targetFields` | Paths copied from the base as they are. `'rest'` is not supported |

Lifecycle as a view with `base`: the target is created when the base exists, deleted when it is gone, and a path missing on the base is deleted on the target. Put aggregates or views on `target` for derived fields. Logged as `kind: 'projection'`.
```

(c) In the "How a change is processed" table, replace the two view rows with:

```md
| View base changed | document unchanged | re-read the target, then the base. Base gone: delete the target. Target missing: `build` and `create()`. Otherwise `build` and write the differing paths |
| View source changed | `watch` fields (or the whole document) unchanged | for each target: re-read it (and its base; a missing base deletes the target, a missing target is created), then `patch` with a fresh read of the changed document, or `build` over fresh reads of all sources |
| View target changed | not a create, no `refField` changed, every declared path still present; with `base`: also skipped unless deleted | `build`; with `base`, a deleted target is recreated while the base exists |
```

and the bullet under it to:

```md
- Every field write is `update(..., { lastUpdateTime })` with the `updateTime` read before the sources; targets of base views are created with `create()` and removed with `delete({ lastUpdateTime })`. A failed precondition (or `ALREADY_EXISTS`) redoes that target from a fresh read, up to `maxRetries`, then the request fails with 500.
```

- [ ] **Step 2: Reference (Japanese)**

Apply the same three changes to `docs/reference.ja.md`:

(a) `rules[]` row:

```md
| `rules[]` | ルール。順序は自由: `defineConnection(...)`、`defineAggregate(...)`、`defineView(...)`、`defineProjection(...)`（または `kind` を持つオブジェクト） |
```

(b) Replace the `### defineView` section with:

```md
### `defineView`: `target` の宣言した `targetFields` = `build(...)` の該当パス、を保つ

一般形です。`defineConnection`・`defineAggregate`・`defineProjection` は、形の決まった view の簡易設定です。

| キー | 意味 |
|---|---|
| `target` | 派生フィールドを持つコレクション |
| `targetFields` | この view が書くフィールドパス。例 `['title', 'stats.commentCount', 'profile']`。`build` の戻り値からはこのパスだけを取り出し、値が `undefined` のパスは削除します。`'rest'`（`base` が必要）は、どのルールも宣言していないルート直下のキー全部を加えます |
| `base?` | 同じ ID のドキュメントがターゲットの存在を決めるコレクション（後述）。`target` と同じプレースホルダを持つこと |
| `sources` | `build` が見る名前をキーにしたオブジェクト。各要素は下表のソース。`base` があれば省略可 |
| `build({ target, base, sources, firestore })` | 宣言したパスを持つオブジェクトをネストした形で返す（`{ stats: { commentCount: 3 } }`）。`undefined` を返すと全宣言パスを削除。決定的であること。`sources.<key>` は `QueryDocumentSnapshot[]`、`base` は base ドキュメント（`build` が呼ばれる時点で必ず存在） |
| `patch?(current, change, { target, base, firestore })` | 現在の値（`build` の戻り値と同じ形）と変更された 1 ドキュメントから求める任意の高速路。`undefined` を返すと `build` に戻る |

| ソースのキー | ターゲットとの関係 | 追加指定 |
|---|---|---|
| `idField: 'postId'` | 多対一: ソースのフィールドがターゲット ID を持つ | `orderBy`、`limit`、`watch` |
| `idParam: 'postId'` | 多対一: ターゲットのパス配下のソース | `orderBy`、`limit`、`watch` |
| `refField: 'authorId'` | 一対一: ターゲットのフィールドがソース ID を持つ（0 または 1 件） | `watch` |

- `orderBy`: `['createdAt', ['score', 'desc']]`。`limit`: 読む最大件数。`watch`: 再計算のきっかけになるソースのフィールド（既定は何でも）。`idField` と `orderBy` のフィールドは常に監視されます。`base` ドキュメントの変更は常に再計算のきっかけになります。
- 書き込み: 値が違う宣言パスだけを 1 回の `update()` にまとめ、ターゲットの `updateTime` を条件にします。`targetFields` 外のフィールドには触れません。戻り値にある宣言外のパスは 1 回だけ `warn` ログを出して無視します。
- `base`: `target/{id}` は `base/{id}` が存在するときだけ存在します。base・ソース・ターゲットのどのイベントでも、読み直した時点の base で判定します。ターゲットが無ければ `create()` で作り、base が消えていれば `delete({ lastUpdateTime })` で消します。消したターゲット配下のサブコレクションは残ります（Firestore の仕様）。同じターゲットに対して複数の view が同じ `base` を宣言でき、`validate` は一致を確認します。そのターゲットの他のルールは、ターゲットが無い間は skip し、作成イベントで追いつきます。
- `'rest'`: どのルールも書かず id にも使っていないルート直下のキー全部をこの view が所有します。戻り値にあるそのようなキーは書き、ターゲットにあって戻り値に無いものは削除します。`base` 付きの view でのみ使えます。
- `build` / `patch` の戻り値: `undefined` のマップ要素は落とし、配列の `undefined` 要素は `null` になります。
- `change.after` は変更ドキュメントの読み直しです（削除済み、またはこのターゲットに属さなくなった場合は `undefined`）。`patch` は冪等で、要素をドキュメント ID で管理すること。
- ターゲット側: 作成時、`refField` の変更時、宣言パスが消えた時、そして `base` 付きなら削除時（base があれば作り直す）に再計算します。`build` が読む他のターゲットフィールドは監視しません。
- `rebuild` / `verify` は常に `build` を使います。`base` 付き view では先に base コレクションを歩いて（ターゲットの作成・検査）、次にターゲットコレクションを歩きます（base を失ったターゲットの削除・報告）。`verify` は各件を `issue: 'value' | 'missing' | 'orphan'` で報告します。

### `defineProjection`: `build` の無い `base` 付き view

| キー | 意味 |
|---|---|
| `base` | 写す元のコレクション |
| `target` | `base/{id}` ごとに `target/{id}` を持つコレクション。`base` と同じプレースホルダ |
| `targetFields` | base からそのまま写すパス。`'rest'` は使えません |

寿命は `base` 付き view と同じです。base があればターゲットを作り、無くなれば消し、base に無いパスはターゲットからも削除します。派生フィールドは `target` に対する aggregate や view で足します。ログでは `kind: 'projection'` になります。
```

(c) In the 「変更の処理」 table, replace the two view rows with:

```md
| view の base が変わった | ドキュメントに変化なし | ターゲットを読み直し、続けて base を読む。base が無ければターゲットを削除。ターゲットが無ければ `build` して `create()`。それ以外は `build` して差分のパスを書く |
| view のソースが変わった | `watch` のフィールド（または全体）に変化なし | ターゲットごとに読み直し（`base` も。base が無ければターゲット削除、ターゲットが無ければ作成）、変更ドキュメントの読み直しで `patch`、または全ソースの読み直しで `build` |
| view のターゲットが変わった | 作成でなく、`refField` に変化がなく、宣言パスが全部残っている。`base` 付きでは削除以外も同様に skip | `build`。`base` 付きでは base があれば削除されたターゲットを作り直す |
```

and the bullet under it to:

```md
- フィールドの書き込みはすべて、ソースより前に読んだ `updateTime` を条件にした `update(..., { lastUpdateTime })` です。`base` 付き view のターゲットは `create()` で作り、`delete({ lastUpdateTime })` で消します。事前条件の失敗（および `ALREADY_EXISTS`）はそのターゲットを読み直しからやり直し、`maxRetries` 回を超えるとリクエストは 500 で失敗します。
```

- [ ] **Step 3: README (both languages)**

In `README.md`, under "## What this library does", change the view paragraph to:

```md
**View** (`defineView`): the general form. Reacts to changes on the target, its sources or its `base`, and writes the field paths you declare in `targetFields`, nested or at the root. For latest-N lists, maps keyed by id, summaries, read models. With `base`, the target document itself is created and deleted along with the same-id base document.
```

update its example to `targetFields: ['latestComments']` with `build: ({ sources }) => ({ latestComments: sources.comments.map((c) => ({ id: c.id, body: c.get('body') })) })`, and add after the view block:

```md
**Projection** (`defineProjection`): a read model in another collection. `userPublicView/{id}` exists exactly when `user/{id}` does and carries the declared paths; add aggregates or views on `userPublicView` for derived fields.

```ts
defineProjection({
  name: 'user-public',
  base: 'user',
  target: 'userPublicView',
  targetFields: ['displayName', 'avatarUrl'],
})
```
```
user/u1             { displayName: 'Ann', avatarUrl: '…', email: 'ann@…', phone: '…' }
                                   ▼
userPublicView/u1   { displayName: 'Ann', avatarUrl: '…' }
```

Targets are never created by connections, aggregates or views without `base`: they fill fields of documents that already exist. A view with `base` (and a projection) is the one exception and owns its target's existence.
```

In `README.ja.md`, under 「## 本ライブラリでできること」, change the view paragraph to:

```md
**ビュー**（`defineView`）: 一般形です。ターゲット・ソース・`base` の変更を検知し、`targetFields` で宣言したフィールドパス（ルート直下でもネストでも）を書きます。最新 N 件のリスト、ID をキーにしたマップ、サマリー、読み取りモデルに使います。`base` を付けると、同じ ID の base ドキュメントに合わせてターゲットのドキュメント自体を作成・削除します。
```

update its example the same way, and add after the view block:

```md
**プロジェクション**（`defineProjection`）: 別コレクションの読み取りモデルです。`user/{id}` があるときだけ `userPublicView/{id}` が存在し、宣言したパスを持ちます。派生フィールドは `userPublicView` に対する aggregate や view で足します。

```ts
defineProjection({
  name: 'user-public',
  base: 'user',
  target: 'userPublicView',
  targetFields: ['displayName', 'avatarUrl'],
})
```
```
user/u1             { displayName: 'Ann', avatarUrl: '…', email: 'ann@…', phone: '…' }
                                   ▼
userPublicView/u1   { displayName: 'Ann', avatarUrl: '…' }
```

connection・aggregate・`base` の無い view はターゲットを作りません。既存ドキュメントのフィールドを埋めるだけです。`base` 付きの view（と projection）だけが例外で、ターゲットの存在を所有します。
```

- [ ] **Step 4: Examples**

In `examples/functions/src/doc-sync.config.ts`, every view already migrated in Task 2 keeps `targetFields`. Add after the last view:

```ts
    defineProjection({
      // userPublicView/{uid} = user/{uid} without the private fields; created and deleted with it
      name: "user-public",
      base: "user",
      target: "userPublicView",
      targetFields: ["displayName", "avatarUrl"],
    }),

    defineView({
      // userPublicView.stats.postCount next to the projected fields: another rule may own other paths of the same document
      name: "user-public-posts",
      target: "userPublicView",
      base: "user",
      targetFields: ["stats.postCount"],
      sources: { posts: { collection: "post", idField: "authorId", watch: ["authorId"] } },
      build: ({ sources }) => ({ stats: { postCount: sources.posts.length } }),
    }),
```

and import `defineProjection` at the top of the file. The root `tsconfig.json` includes `examples`, so `npm run typecheck` checks it.

- [ ] **Step 5: Changelog and version**

Prepend to `CHANGELOG.md` under the format line:

```md
## [0.8.0] - 2026-10-12

### Changed

- **Breaking:** a view declares `targetFields: string[]` instead of `targetField`. `build` returns an object holding the declared paths (nested); a declared path whose value is `undefined` is deleted; undeclared paths are logged once and ignored. `patch` receives and returns the same object shape.
- `verify` mismatches carry `issue: 'value' | 'missing' | 'orphan'`; `field` is set for `value` only.
- Handler results (`RuleResult.action`) may now be `create` or `remove` (target document created / removed).

### Added

- `base` on a view: the target `target/{id}` exists exactly when `base/{id}` exists, judged by a fresh read on every event. The base document is passed to `build` / `patch` as `base`. `sources` may be omitted when `base` is set.
- `'rest'` in `targetFields` (views with `base`): write and prune every root key no rule declares.
- `defineProjection`: a view with `base` and no `build` that mirrors the declared paths into another collection.
- `rebuild` / `verify` walk the base collection first for base views (creating / reporting missing targets), then the target collection (removing / reporting orphans).
- `validate` prints a base trigger line and counts the base read.
```

Set `"version": "0.8.0"` in `package.json`.

- [ ] **Step 6: Final verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add docs README.md README.ja.md CHANGELOG.md examples package.json
git commit -m "docs: targetFields, base, 'rest' and defineProjection; 0.8.0

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Out of scope (follow-up plans)

- `aggregate: 'count' | { sum }` on a view source (build receives a number). The spec lists it as a separate plan.
- `exclude` / renames on `defineProjection`.
- Any `_sync` metadata.
