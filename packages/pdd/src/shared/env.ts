export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CI;
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Variables that tell code it is running under a test runner or CI. Production
 * code must not read them, and the law processes never receive them.
 */
const SNIFFED_ENV_VARS = new Set([
  "CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "RUN_ID",
  "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "TRAVIS", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION", "TF_BUILD",
  "VITEST", "JEST_WORKER_ID", "NODE_TEST_CONTEXT", "MOCHA_WORKER_ID",
]);

export function isSniffedEnvVar(name: string): boolean {
  return (
    SNIFFED_ENV_VARS.has(name) ||
    name.startsWith("PDD_") ||
    name.startsWith("VITEST_") ||
    name.startsWith("GITHUB_") ||
    name.startsWith("__STRYKER_") ||
    name.startsWith("STRYKER_")
  );
}
