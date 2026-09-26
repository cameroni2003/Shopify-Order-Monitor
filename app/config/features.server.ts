/**
 * Feature flags that gate functionality which is implemented but not yet exposed. Keep this as
 * the single place flags are read from env, so a route/service never inlines its own
 * `process.env.X === "true"` check.
 */

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  return raw === "true" || raw === "1";
}

/**
 * Editing/deleting your own comments is implemented in app/lib/db/comments.server.ts (see
 * docs/PLAN.md) but has no UI yet and is rejected server-side while this is false, so it can't be
 * triggered by a hand-made request either.
 */
export const COMMENT_EDITING_ENABLED = readBooleanEnv("COMMENT_EDITING_ENABLED", false);
