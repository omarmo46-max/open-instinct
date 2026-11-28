/**
 * Older deployments used the prefix `INSTINCT_` for every setting. The prefix is now `ORION_`.
 * Call this once at process start (the server and the CLI do) so an environment file that was
 * written before the rename keeps working. A value set under the new name always wins.
 */
const LEGACY_PREFIX = "INSTINCT_";
const PREFIX = "ORION_";

export function applyLegacyEnv(env: NodeJS.ProcessEnv): string[] {
  const migrated: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    const next = PREFIX + key.slice(LEGACY_PREFIX.length);
    if (env[next] === undefined && env[key] !== undefined) {
      env[next] = env[key];
      migrated.push(key);
    }
  }
  return migrated;
}
