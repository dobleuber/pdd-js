// Emulates the code Stryker injects into mutated files (see @stryker-mutator/instrumenter):
// coverage goes to __stryker__.mutantCoverage, and a mutant is active when its id matches.
function cover(id) {
  const ns = globalThis.__stryker__;
  if (!ns) return;
  const cov = (ns.mutantCoverage ??= { static: {}, perTest: {} });
  const into = ns.currentTestId ? (cov.perTest[ns.currentTestId] ??= {}) : cov.static;
  into[id] = (into[id] ?? 0) + 1;
}

function active(id) {
  const ns = globalThis.__stryker__;
  if (ns?.activeMutant !== id) return false;
  if (ns.hitCount !== undefined && ++ns.hitCount > ns.hitLimit) throw new Error(`Stryker: Hit count limit reached (${ns.hitCount})`);
  return true;
}

cover("0");
/** Mutant "0" is static: it changes a value computed while the module loads. */
export const offset = active("0") ? 1 : 0;

/** Mutant "1" turns x + x into x * 3. */
export function double(x) {
  cover("1");
  return active("1") ? x * 3 : x + x;
}
