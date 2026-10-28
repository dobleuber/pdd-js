/** Shared by the Stryker plugin and pdd mutate. Kept free of Stryker imports so the CLI loads without it. */
export const TEST_ID_SEPARATOR = "::";

/** Prefix of the error message of a mutant run in which the code under test tampered with the runner. */
export const TAMPERING_MARKER = "pdd-tampering:";
