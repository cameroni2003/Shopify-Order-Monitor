/**
 * Pure logic for the settings page's age-based row coloring. Rules are evaluated
 * highest-threshold-reached-wins: sort descending by threshold, take the first rule whose
 * threshold the order's age has reached. This makes the result independent of the order rules
 * were entered/stored in. See docs/PLAN.md, "App Home".
 */

export interface AgeRule {
  id: string;
  thresholdDays: number;
  /** #RRGGBB or #RGB, validated by isValidHexColor before storage. */
  color: string;
}

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

export function validateAgeRules(rules: AgeRule[]): string[] {
  const errors: string[] = [];
  const seenThresholds = new Set<number>();

  for (const rule of rules) {
    if (!Number.isFinite(rule.thresholdDays) || rule.thresholdDays < 0) {
      errors.push(`Rule ${rule.id}: threshold must be a non-negative number of days.`);
    }
    if (seenThresholds.has(rule.thresholdDays)) {
      errors.push(`Rule ${rule.id}: duplicate threshold (${rule.thresholdDays} days).`);
    }
    seenThresholds.add(rule.thresholdDays);
    if (!isValidHexColor(rule.color)) {
      errors.push(`Rule ${rule.id}: "${rule.color}" is not a valid hex color.`);
    }
  }

  return errors;
}

/**
 * Returns the color of the highest-threshold rule the given age has reached, or null if no rule
 * matches (including when `rules` is empty).
 */
export function resolveAgeColor(ageDays: number, rules: AgeRule[]): string | null {
  let best: AgeRule | null = null;
  for (const rule of rules) {
    if (ageDays >= rule.thresholdDays) {
      if (best === null || rule.thresholdDays > best.thresholdDays) {
        best = rule;
      }
    }
  }
  return best?.color ?? null;
}
