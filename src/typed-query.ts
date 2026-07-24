// A typesafe Stardust query — the HYBRID.
//
//   - The field→type map AND the per-field runtime validators are GENERATED from
//     Stardust's JSON Schema (src/generated/schema-fields.ts, `npm run gen:query`).
//     One source of truth, regenerable, no drift.
//   - The compile-time "you cannot write an invalid query" machinery below is
//     PURE TypeScript over that generated map — no validation library at all,
//     at compile time or runtime.
//   - Runtime boundary validation reuses the generated validators — no library.
//
// The call site stays plain JSON: `query({ find, where, then })` — no builder.

import { query as rawQuery } from "./stardust.ts";
import type { FieldTypes } from "./field-registry.ts";
import { validators } from "./field-registry.ts";

// The observable-field vocabulary the checker is bound to — a FIELD registry
// (schema-derived ∪ declared), not an entity shape. Stardust has no entity types.
type Fields = FieldTypes;

// ---------------------------------------------------------------------------
// Operator vocabularies + the branded compile-error carrier.
// ---------------------------------------------------------------------------
type CmpOp = "<" | ">" | "<=" | ">=" | "=" | "!=";
type AggOp = "count" | "sum" | "avg" | "min" | "max";
type Var = `?${string}`;

// An invalid clause becomes this branded object. A real tuple isn't assignable
// to it, so the error surfaces AT the offending clause with message M in-tooltip.
type Err<M extends string> = { readonly " query error": M };

type Stringify<T> = T extends string ? T : T extends number ? `${T}` : "value";

// ---------------------------------------------------------------------------
// Field-type helpers that drive operator compatibility.
// ---------------------------------------------------------------------------
// Comparable with <,>,<=,>=: number, text, instant, ref. NOT boolean/array/object.
type IsComparable<T> = [T] extends [number]
  ? true
  : [T] extends [string]
    ? true
    : [T] extends [{ "#utc": string }]
      ? true
      : [T] extends [{ "#": number }]
        ? true
        : false;

// `contains {#set}` needs a scalar set-comparable field: text or number.
type IsSetScalar<T> = [T] extends [string] ? true : [T] extends [number] ? true : false;

// ---------------------------------------------------------------------------
// Binding env: fold `where` fact patterns into { "?var": fieldType }.
// Subject-position vars bind to "@id" (a bare number).
// ---------------------------------------------------------------------------
type EnvOfClause<C, F> = C extends readonly [infer S, infer B, infer O]
  ? B extends keyof F
    ? (S extends Var ? { [K in S & string]: "@id" } : {}) & (O extends Var ? { [K in O & string]: F[B] } : {})
    : {}
  : {};

type BuildEnv<W, F, Acc = {}> = W extends readonly [infer H, ...infer T]
  ? BuildEnv<T, F, Acc & EnvOfClause<H, F>>
  : Acc;

type VarType<V, E> = V extends keyof E ? (E[V] extends "@id" ? number : E[V]) : unknown;

// ---------------------------------------------------------------------------
// Per-clause checks. Return the clause type when valid, else an Err<...>.
// ---------------------------------------------------------------------------
type FactObj<T> = Var | T; // a var, or a literal of the field's type (refs are {"#":n})
type FactSubj = Var | { "#": number } | number;

type CheckFact<C, F> = C extends readonly [infer _S, infer K, infer O]
  ? K extends keyof F
    ? O extends readonly unknown[] // array destructure [?a, field, [?x, ?y]]
      ? F[K] extends readonly unknown[]
        ? C
        : Err<`array destructure requires a list field; '${K & string}' is scalar`>
      : [O] extends [FactObj<F[K]>]
        ? readonly [FactSubj, K, O]
        : Err<`value ${Stringify<O>} is not assignable to field '${K & string}'`>
    : Err<`unknown field '${Stringify<K>}' (or malformed clause)`>
  : Err<"malformed clause">;

type CheckPredicate<C, E> = C extends readonly [infer Op, infer A, infer B]
  ? Op extends CmpOp
    ? IsComparable<VarType<A, E>> extends true
      ? [B] extends [Var | VarType<A, E>]
        ? C
        : Err<`predicate rhs ${Stringify<B>} not compatible with lhs field type`>
      : Op extends "=" | "!=" // equality allowed on any type (incl. boolean/enum)
        ? C
        : Err<`operator '${Op & string}' needs a comparable field (number/text/instant/ref)`>
    : never
  : never;

type CheckContains<C, E> = C extends readonly ["contains", infer Set, infer V]
  ? IsSetScalar<VarType<V, E>> extends true
    ? Set extends { "#set": infer Els }
      ? Els extends readonly VarType<V, E>[]
        ? C
        : Err<`#set elements must all match the field type of ${Stringify<V>}`>
      : Err<"contains needs a {'#set': [...]} literal">
    : Err<`contains needs a scalar (text/number) field, got ${Stringify<V>}`>
  : never;

type CheckClause<C, F, E> = C extends readonly [infer A, infer B, infer _O]
  ? A extends CmpOp
    ? CheckPredicate<C, E>
    : A extends "contains"
      ? CheckContains<C, E>
      : A extends AggOp
        ? Err<`aggregate '${A & string}' is only allowed in the find aggregate position`>
        : B extends keyof F
          ? CheckFact<C, F>
          : Err<`'${Stringify<B>}' is not an observable field`>
  : Err<"where clause must be a 3-element tuple">;

type CheckWhere<W, F, E> = { readonly [I in keyof W]: CheckClause<W[I], F, E> };

type CheckFindEl<X> = X extends Var
  ? X
  : X extends readonly [infer Op, infer V]
    ? Op extends AggOp
      ? V extends Var
        ? readonly [Op, V]
        : Err<"aggregate arg must be a ?var">
      : Err<`invalid aggregate op ${Stringify<Op>}`>
    : Err<"find element must be a ?var or [aggOp, ?var]">;
type CheckFind<Fnd> = { readonly [I in keyof Fnd]: CheckFindEl<Fnd[I]> };

type CheckThen<Tn, E> = Tn extends { project: infer P }
  ? {
      project: {
        readonly [K in keyof P]: P[K] extends Var
          ? P[K] extends keyof E
            ? P[K]
            : Err<`project var ${Stringify<P[K]>} is never bound in where`>
          : Err<"project values must be a ?var">;
      };
    }
  : Err<"then must be { project: {...} }">;

// ---------------------------------------------------------------------------
// The query literal shape + its checked counterpart.
// ---------------------------------------------------------------------------
export interface QueryLiteral {
  readonly find: readonly unknown[];
  readonly where: readonly unknown[];
  readonly orderBy?: readonly unknown[];
  readonly limit?: number;
  readonly groupBy?: readonly unknown[];
  readonly then?: { readonly project: Readonly<Record<string, string>> };
}

type Env<Q extends QueryLiteral> = BuildEnv<Q["where"], Fields>;

// Intersect the argument with this. Any Err<...> position breaks assignment there.
type CheckQuery<Q extends QueryLiteral> = {
  find: CheckFind<Q["find"]>;
  where: CheckWhere<Q["where"], Fields, Env<Q>>;
} & (Q extends { then: infer Tn } ? { then: CheckThen<Tn, Env<Q>> } : {});

// ---------------------------------------------------------------------------
// Result row inference (secondary — "too loose is ok").
// ---------------------------------------------------------------------------
type Prettify<T> = { [K in keyof T]: T[K] } & {};

// A `find` element → its result type: a ?var resolves through the env, an
// aggregate ([count ?t], [sum ?x], …) is a number.
type FindElType<X, E> = X extends Var ? VarType<X, E> : X extends readonly [AggOp, Var] ? number : unknown;
// Recursive tuple map (mapping over `keyof tuple` would pull in array methods).
type FindTuple<F, E> = F extends readonly [infer H, ...infer T] ? [FindElType<H, E>, ...FindTuple<T, E>] : [];

export type ResultOf<Q extends QueryLiteral> = Q extends { then: { project: infer P } }
  ? Prettify<{ -readonly [K in keyof P]: VarType<P[K], Env<Q>> }> // projection → object
  : FindTuple<Q["find"], Env<Q>>; // bare find → tuple

// ===========================================================================
// Runtime — boundary validation from the SAME generated validators.
// ===========================================================================
export interface ValidationCheck {
  key: string; // the projected output key
  field: string; // the Stardust field it's bound to ("@id" for a subject var)
  check: (v: unknown) => boolean; // the validator (generated from the schema)
}

/**
 * The runtime validation PLAN for a query — this is the whole mechanism, made
 * inspectable. It (1) walks `where` to bind each ?var to its field, then
 * (2) maps each projected key to that field's generated validator. So the boundary
 * check is derived entirely from the query + the schema-generated field map.
 */
export function validationPlan(where: readonly unknown[], project: Record<string, string>): ValidationCheck[] {
  const bind: Record<string, string> = {};
  for (const c of where) {
    if (!Array.isArray(c) || c.length !== 3) continue;
    const [s, f, o] = c;
    if (typeof f === "string" && f in validators) {
      // Subject binding (@id) ALWAYS wins over an object/ref binding, regardless
      // of clause order: if a var ever appears in subject position it names an
      // entity, so `then.project` returns its numeric id. This mirrors the
      // compile-time VarType (the "@id" & Fieldtype intersection resolves to id).
      if (typeof s === "string" && s.startsWith("?")) bind[s] = "@id"; // always
      if (typeof o === "string" && o.startsWith("?") && bind[o] !== "@id") bind[o] = f;
    }
  }
  const plan: ValidationCheck[] = [];
  for (const [key, v] of Object.entries(project)) {
    const field = bind[v];
    if (field === "@id") plan.push({ key, field: "@id", check: (x) => typeof x === "number" });
    else if (field && validators[field]) plan.push({ key, field, check: validators[field] });
  }
  return plan;
}

function rowValidator(where: readonly unknown[], project: Record<string, string>): (row: unknown) => string | null {
  const plan = validationPlan(where, project);
  return (row) => {
    if (typeof row !== "object" || row === null) return "row is not an object";
    for (const { key, field, check } of plan) {
      if (!check((row as Record<string, unknown>)[key])) {
        return `field '${key}' (${field}) failed validation: got ${JSON.stringify((row as Record<string, unknown>)[key])}`;
      }
    }
    return null;
  };
}

/** The single typed entry point. Call site is plain JSON. */
export async function query<const Q extends QueryLiteral>(q: Q & CheckQuery<Q>): Promise<ResultOf<Q>[]> {
  const data = await rawQuery(q);
  if (!Array.isArray(data)) throw new Error("expected an array result");
  const proj = (q as unknown as QueryLiteral).then?.project;
  if (proj) {
    const check = rowValidator((q as unknown as QueryLiteral).where, proj);
    data.forEach((row, i) => {
      const err = check(row);
      if (err) throw new Error(`Stardust result failed validation — row ${i}: ${err}`);
    });
  }
  return data as ResultOf<Q>[];
}
