/**
 * Snapshot of built-ins that the code under test could patch to make laws pass
 * (e.g. `Math.random = () => 0.5`, or a polluted Object.prototype).
 * The child takes it before importing the law file and re-checks it after
 * loading and after every law.
 */

type Probe = readonly [label: string, read: () => unknown];

const g = globalThis as unknown as Record<string, Record<string, unknown> | undefined>;

function methods(objectLabel: string, read: () => object | undefined, names: string[]): Probe[] {
  return names.map((name) => [`${objectLabel}.${name}`, () => (read() as Record<string, unknown> | undefined)?.[name]] as const);
}

function ownKeys(label: string, read: () => object | undefined): Probe {
  return [
    `own keys of ${label}`,
    () => {
      const o = read();
      return o === undefined ? "" : Reflect.ownKeys(o).map(String).sort().join(",");
    },
  ];
}

const proto = (name: string) => () => (g[name] as { prototype?: object } | undefined)?.prototype;

function buildProbes(): Probe[] {
  const arrayIteratorProto = Object.getPrototypeOf([][Symbol.iterator]()) as object;
  return [
    ...["Math", "JSON", "Object", "Array", "Function", "String", "Number", "Boolean", "Symbol", "Promise", "Reflect", "Map", "Set", "WeakMap", "Date", "Error", "RegExp", "Proxy"].map(
      (name) => [`globalThis.${name}`, () => g[name]] as const,
    ),
    ...methods("Math", () => g.Math, ["random", "floor", "ceil", "round", "abs", "max", "min", "trunc", "sign"]),
    ...methods("Date", () => g.Date, ["now"]),
    ...methods("JSON", () => g.JSON, ["stringify", "parse"]),
    ...methods("Object", () => g.Object, ["is", "keys", "values", "entries", "assign", "freeze", "create", "defineProperty", "getOwnPropertyDescriptor", "getPrototypeOf"]),
    ...methods("Array", () => g.Array, ["isArray", "from", "of"]),
    ...methods("Array.prototype", proto("Array"), ["map", "filter", "reduce", "push", "forEach", "some", "every", "includes", "indexOf", "slice", "splice", "concat", "join", "sort", "find", "findIndex", "flatMap"]),
    ["Array.prototype[Symbol.iterator]", () => (proto("Array")() as Record<symbol, unknown>)[Symbol.iterator]],
    ["ArrayIterator.next", () => (arrayIteratorProto as Record<string, unknown>).next],
    ...methods("Function.prototype", proto("Function"), ["call", "apply", "bind", "toString"]),
    ...methods("Object.prototype", proto("Object"), ["hasOwnProperty", "toString", "valueOf"]),
    ...methods("Number", () => g.Number, ["isNaN", "isInteger", "isSafeInteger", "isFinite"]),
    ...methods("String.prototype", proto("String"), ["slice", "split", "includes", "startsWith", "endsWith", "trim"]),
    ...methods("Map.prototype", proto("Map"), ["get", "set", "has"]),
    ...methods("Set.prototype", proto("Set"), ["add", "has"]),
    ...methods("WeakMap.prototype", proto("WeakMap"), ["get", "set"]),
    ...methods("Promise.prototype", proto("Promise"), ["then"]),
    ...methods("Reflect", () => g.Reflect, ["apply", "get", "ownKeys"]),
    ...methods("process", () => g.process, ["exit", "send", "on", "once", "emit"]),
    ownKeys("Object.prototype", proto("Object")),
    ownKeys("Array.prototype", proto("Array")),
    ownKeys("Function.prototype", proto("Function")),
    ownKeys("Math", () => g.Math),
    ownKeys("JSON", () => g.JSON),
  ];
}

/** Takes a snapshot now; the returned function lists everything that changed since. */
export function snapshotIntrinsics(): () => string[] {
  const probes = buildProbes();
  const captured = probes.map(([label, read]) => [label, read, safeRead(read)] as const);
  return () => {
    const changed: string[] = [];
    for (const [label, read, value] of captured) {
      if (safeRead(read) !== value) changed.push(label);
    }
    return changed;
  };
}

const UNREADABLE = Symbol("unreadable");

function safeRead(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return UNREADABLE;
  }
}
