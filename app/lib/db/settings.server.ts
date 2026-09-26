import { z } from "zod";
import type { AgeRule } from "../../../shared/age-rules";
import { validateAgeRules } from "../../../shared/age-rules";
import { withShop } from "./shop-scope.server";
import { ensureShop } from "./shops.server";

/**
 * General-purpose per-shop settings, stored as ShopSetting(shopDomain, key, value: Json) rather
 * than a one-off table per feature (see docs/PLAN.md). Each key has a zod schema and default
 * registered below, validated on both read and write so a hand-edited or partially-migrated row
 * can never reach the UI unvalidated.
 */

const ageRuleSchema = z.object({
  id: z.string().min(1),
  thresholdDays: z.number().finite().nonnegative(),
  color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
});

const settingsRegistry = {
  ageRules: {
    schema: z.array(ageRuleSchema).max(25),
    default: [] as AgeRule[],
  },
  showTestOrders: {
    schema: z.boolean(),
    default: true,
  },
} satisfies Record<string, { schema: z.ZodType; default: unknown }>;

type SettingsRegistry = typeof settingsRegistry;
type SettingKey = keyof SettingsRegistry;
type SettingValue<K extends SettingKey> = z.infer<SettingsRegistry[K]["schema"]>;

export async function getSetting<K extends SettingKey>(
  shopDomain: string,
  key: K,
): Promise<SettingValue<K>> {
  const row = await withShop(shopDomain, (tx) =>
    tx.shopSetting.findUnique({ where: { shopDomain_key: { shopDomain, key } } }),
  );
  const registered = settingsRegistry[key];
  if (!row) return registered.default as SettingValue<K>;

  const parsed = registered.schema.safeParse(row.value);
  if (!parsed.success) {
    // A stored value that no longer matches the schema (e.g. after a schema change) shouldn't
    // crash the page — fall back to the default and let the next save overwrite it.
    console.warn(`Invalid stored setting ${shopDomain}/${key}, falling back to default`, parsed.error);
    return registered.default as SettingValue<K>;
  }
  return parsed.data as unknown as SettingValue<K>;
}

export async function setSetting<K extends SettingKey>(
  shopDomain: string,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  const registered = settingsRegistry[key];
  const schemaResult = registered.schema.safeParse(value);
  if (!schemaResult.success) {
    // schemaResult.error.message is a JSON-stringified issues array — fine for logs, but not
    // something to put in front of a merchant. flatten() gives a short, readable message per
    // field instead.
    const messages = schemaResult.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    });
    throw new Error(`Invalid ${key}: ${messages.join("; ")}`);
  }
  // registered.schema is narrowed to a union across all keys, not to K specifically — safe to
  // assert here because `value` itself is already typed as SettingValue<K> by the signature.
  const parsed = schemaResult.data as unknown as SettingValue<K>;

  if (key === "ageRules") {
    const errors = validateAgeRules(parsed as AgeRule[]);
    if (errors.length > 0) {
      throw new Error(`Invalid age rules: ${errors.join("; ")}`);
    }
  }

  // ShopSetting has a FK to Shop, and unlike orders (always preceded by an event that calls
  // ensureShop — see applyOrderEvent), the Settings page can be the very first thing touched
  // for a shop with no order events yet. Without this, that first save would fail with a
  // foreign key violation instead of silently succeeding. ensureShop is idempotent.
  await ensureShop(shopDomain);

  await withShop(shopDomain, (tx) =>
    tx.shopSetting.upsert({
      where: { shopDomain_key: { shopDomain, key } },
      create: { shopDomain, key, value: parsed },
      update: { value: parsed },
    }),
  );
}

export async function getAgeRules(shopDomain: string) {
  return getSetting(shopDomain, "ageRules");
}

export async function setAgeRules(shopDomain: string, rules: AgeRule[]) {
  return setSetting(shopDomain, "ageRules", rules);
}

export async function getShowTestOrders(shopDomain: string) {
  return getSetting(shopDomain, "showTestOrders");
}

export async function setShowTestOrders(shopDomain: string, value: boolean) {
  return setSetting(shopDomain, "showTestOrders", value);
}
