import type { GuardRule } from "../types.js";
import { noDynamicCode, noEnvSniff, noGlobalPatch, noPddInternals, noRunnerIpc } from "./runtime-integrity.js";
import { noMockUnderLaw, noTestSkip } from "./test-hygiene.js";
import { noExplicitAny, noLintSuppress, noNonNullAssertion, noTsSuppress, noUnsafeCast } from "./type-escapes.js";

export const RULES: readonly GuardRule[] = [
  noExplicitAny,
  noTsSuppress,
  noLintSuppress,
  noUnsafeCast,
  noNonNullAssertion,
  noTestSkip,
  noMockUnderLaw,
  noGlobalPatch,
  noDynamicCode,
  noPddInternals,
  noEnvSniff,
  noRunnerIpc,
];

export const RULE_IDS: readonly string[] = RULES.map((r) => r.id);
