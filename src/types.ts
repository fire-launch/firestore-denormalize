/**
 * Typed config: `typed<Collections>()` returns `defineConfig` / `defineView` whose field names
 * are checked against your document types at compile time. Nothing here exists at runtime
 * beyond two identity functions; `validateConfig` performs the same checks as for an untyped config.
 *
 * ```ts
 * type Collections = { post: Post; category: Category; 'users/{uid}/posts': UserPost }
 * const { defineConfig, defineView } = typed<Collections>()
 * ```
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  FieldValue,
  Firestore,
  GeoPoint,
  QueryDocumentSnapshot,
  Timestamp,
} from 'firebase-admin/firestore'
import type { DocSyncConfig, OnSourceDelete, ViewRule } from './config.js'

/** Collection path patterns (`post`, `users/{uid}/posts`) mapped to their document types. Use a type alias, not an interface. */
export type Collections = Record<string, object>

type Key<C> = keyof C & string

/** Values that are not descended into when building field paths. */
export type Leaf =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | Uint8Array
  | Timestamp
  | GeoPoint
  | DocumentReference
  | FieldValue
  | readonly unknown[]
  | ((...args: never[]) => unknown)

type Prev = [never, 0, 1, 2, 3, 4, 5]

/** Dotted field paths of `T`: `'name' | 'address' | 'address.city'`, at most 5 levels deep. */
export type FieldPath<T, D extends number = 5> = [D] extends [never]
  ? never
  : NonNullable<T> extends Leaf
    ? never
    : {
        [K in Key<NonNullable<T>>]: K | (NonNullable<NonNullable<T>[K]> extends Leaf ? never : `${K}.${FieldPath<NonNullable<T>[K], Prev[D]>}`)
      }[Key<NonNullable<T>>]

/** The value type at a dotted path, or `unknown` when the path is not statically known. */
export type Get<T, P extends string> = P extends `${infer K}.${infer R}`
  ? K extends Key<NonNullable<T>>
    ? Get<NonNullable<T>[K], R>
    : unknown
  : P extends Key<NonNullable<T>>
    ? NonNullable<T>[P]
    : unknown

/** Field paths of `T` whose (non-null) value is assignable to `V`. */
export type FieldPathOf<T, V> = { [P in FieldPath<T>]: NonNullable<Get<T, P>> extends V ? P : never }[FieldPath<T>]

/** Placeholder names of a collection path pattern: `Params<'users/{uid}/posts'>` is `'uid'`. */
export type Params<P extends string> = P extends `${string}{${infer N}}${infer R}` ? N | Params<R> : never

// ---------------------------------------------------------------- rules

export interface TypedConnection<C, S extends Key<C>, T extends Key<C>> {
  name: string
  source: S
  target: T
  /** A string field of the target. */
  idField: FieldPathOf<C[T], string>
  /** Fields of the source. */
  fields: FieldPath<C[S]>[]
  /** The field of the target that receives the copy. */
  targetField: FieldPath<C[T]>
  onSourceDelete: OnSourceDelete
}

export interface TypedAggregate<C, S extends Key<C>, T extends Key<C>> {
  name: string
  source: S
  target: T
  /** A string field of the source. Use this or `idParam`. */
  idField?: FieldPathOf<C[S], string>
  /** A placeholder of `source`. Use this or `idField`. */
  idParam?: Params<S>
  aggregate: 'count' | { sum: FieldPathOf<C[S], number> }
  /** A numeric field of the target. */
  targetField: FieldPathOf<C[T], number>
}

/** Every (source, target) combination, so the literal `source` / `target` select the field types. */
export type AnyTypedConnection<C> = { [S in Key<C>]: { [T in Key<C>]: TypedConnection<C, S, T> }[Key<C>] }[Key<C>]
export type AnyTypedAggregate<C> = { [S in Key<C>]: { [T in Key<C>]: TypedAggregate<C, S, T> }[Key<C>] }[Key<C>]

export type TypedViewSource<C, T extends Key<C>> = {
  [K in Key<C>]: {
    collection: K
    idField?: FieldPathOf<C[K], string>
    idParam?: Params<K>
    refField?: FieldPathOf<C[T], string>
    orderBy?: (FieldPath<C[K]> | [field: FieldPath<C[K]>, direction: 'asc' | 'desc'])[]
    limit?: number
    watch?: FieldPath<C[K]>[]
  }
}[Key<C>]

type SourceDoc<C, S> = S extends { collection: infer K extends Key<C> } ? C[K] : never

export interface TypedBuildContext<C, T extends Key<C>, S extends Record<string, { collection: Key<C> }>> {
  target: DocumentSnapshot<C[T]>
  sources: { [N in keyof S]: QueryDocumentSnapshot<SourceDoc<C, S[N]>>[] }
  firestore: Firestore
}

export type TypedViewChange<C, S extends Record<string, { collection: Key<C> }>> = {
  [N in keyof S & string]: { source: N; path: string; before?: SourceDoc<C, S[N]>; after?: SourceDoc<C, S[N]> }
}[keyof S & string]

export interface TypedPatchContext<C, T extends Key<C>> {
  target: DocumentSnapshot<C[T]>
  firestore: Firestore
}

export interface TypedViewRule<C, T extends Key<C>, TF extends FieldPath<C[T]>, S extends Record<string, TypedViewSource<C, T>>> {
  name: string
  target: T
  targetField: TF
  sources: S
  build(ctx: TypedBuildContext<C, T, S>): Get<C[T], TF> | undefined | Promise<Get<C[T], TF> | undefined>
  patch?(
    current: Get<C[T], TF> | undefined,
    change: TypedViewChange<C, S>,
    ctx: TypedPatchContext<C, T>,
  ): Get<C[T], TF> | undefined | Promise<Get<C[T], TF> | undefined>
}

export interface TypedDocSyncConfig<C> extends Omit<DocSyncConfig, 'connections' | 'aggregates' | 'views'> {
  connections?: AnyTypedConnection<C>[]
  aggregates?: AnyTypedAggregate<C>[]
  /** Views made with the `defineView` returned by the same `typed<C>()` call. */
  views?: ViewRule[]
}

export interface Typed<C> {
  /** Like `defineConfig`, with `source` / `target` / field names checked against `C`. */
  defineConfig(config: TypedDocSyncConfig<C>): DocSyncConfig
  /** Like `defineView`, with `sources` typed from `C` and `build` / `patch` typed from the target field. */
  defineView<T extends Key<C>, TF extends FieldPath<C[T]>, S extends Record<string, TypedViewSource<C, T>>>(
    view: TypedViewRule<C, T, TF, S>,
  ): ViewRule
}

/**
 * Binds your collection types. Both returned functions are identities at runtime; the result
 * is an ordinary `DocSyncConfig` / `ViewRule`.
 */
export function typed<C extends Collections>(): Typed<C> {
  return {
    defineConfig: (config) => config as unknown as DocSyncConfig,
    defineView: (view) => view as unknown as ViewRule,
  }
}
