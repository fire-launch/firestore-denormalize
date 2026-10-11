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
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  FieldValue,
  Firestore,
  GeoPoint,
  QueryDocumentSnapshot,
  Timestamp,
} from 'firebase-admin/firestore'
import type { DocSyncConfig, OnSourceDelete, ProjectionRule, ViewRule } from './config.js'

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
  kind: 'connection'
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
  kind: 'aggregate'
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

export type TypedViewChange<C, S extends Record<string, { collection: Key<C> }>> = {
  [N in keyof S & string]: { source: N; path: string; before?: SourceDoc<C, S[N]>; after?: SourceDoc<C, S[N]> }
}[keyof S & string]

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

export interface TypedDocSyncConfig<C> extends Omit<DocSyncConfig, 'rules'> {
  rules: TypedRule<C>[]
}

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
