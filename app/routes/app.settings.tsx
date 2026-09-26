import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getAgeRules, getShowTestOrders, setAgeRules, setShowTestOrders } from "../lib/db/settings.server";
import type { AgeRule } from "../../shared/age-rules";

const SAVE_BAR_ID = "settings-save-bar";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const [ageRules, showTestOrders] = await Promise.all([
    getAgeRules(shopDomain),
    getShowTestOrders(shopDomain),
  ]);

  return { ageRules, showTestOrders };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const formData = await request.formData();
  const ruleKeys = String(formData.get("ruleKeys") ?? "")
    .split(",")
    .filter(Boolean);
  const ageRules: AgeRule[] = ruleKeys.map((key) => ({
    id: String(formData.get(`rule-id-${key}`) ?? key),
    thresholdDays: Number(formData.get(`rule-threshold-${key}`) ?? 0),
    color: String(formData.get(`rule-color-${key}`) ?? ""),
  }));
  const showTestOrders = formData.get("showTestOrders") === "true";

  try {
    // Two writes, not one transaction: each is independently valid/atomic at the storage layer
    // (ShopSetting is keyed per-setting), and validation for one can't be invalidated by the
    // other, so there's nothing for a shared transaction to protect against here.
    await setAgeRules(shopDomain, ageRules);
    await setShowTestOrders(shopDomain, showTestOrders);
    return { ok: true as const };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "Couldn't save settings.",
    };
  }
};

interface RuleRow {
  key: string;
  id: string;
  thresholdDays: string;
  color: string;
}

function newRowId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `rule-${Math.random().toString(36).slice(2)}`;
}

function rowsFromRules(rules: AgeRule[]): RuleRow[] {
  return rules.map((rule) => ({
    key: rule.id,
    id: rule.id,
    thresholdDays: String(rule.thresholdDays),
    color: rule.color,
  }));
}

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [rows, setRows] = useState<RuleRow[]>(() => rowsFromRules(data.ageRules));
  const [showTestOrders, setShowTestOrdersValue] = useState(data.showTestOrders);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  function markDirty() {
    if (!hasUnsavedChanges) {
      setHasUnsavedChanges(true);
      shopify.saveBar.show(SAVE_BAR_ID);
    }
  }

  function handleDiscard() {
    setRows(rowsFromRules(data.ageRules));
    setShowTestOrdersValue(data.showTestOrders);
    setHasUnsavedChanges(false);
    shopify.saveBar.hide(SAVE_BAR_ID);
  }

  function addRule() {
    setRows((prev) => [...prev, { key: newRowId(), id: newRowId(), thresholdDays: "1", color: "#ffff00" }]);
    markDirty();
  }

  function removeRule(key: string) {
    setRows((prev) => prev.filter((row) => row.key !== key));
    markDirty();
  }

  function updateRow(key: string, patch: Partial<RuleRow>) {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    markDirty();
  }

  function handleSave() {
    const formData = new FormData();
    formData.set("ruleKeys", rows.map((row) => row.key).join(","));
    for (const row of rows) {
      formData.set(`rule-id-${row.key}`, row.id);
      formData.set(`rule-threshold-${row.key}`, row.thresholdDays);
      formData.set(`rule-color-${row.key}`, row.color);
    }
    formData.set("showTestOrders", showTestOrders ? "true" : "false");
    fetcher.submit(formData, { method: "post" });
  }

  // Clearing hasUnsavedChanges on a successful save uses React's "adjust state during render"
  // pattern (compare against the last-seen fetcher data, conditionally setState in the render
  // body) rather than a setState-in-effect. The imperative calls (toast, save bar) are genuine
  // side effects and stay in the effect below.
  const [lastHandledFetcherData, setLastHandledFetcherData] = useState(fetcher.data);
  if (fetcher.data !== lastHandledFetcherData) {
    setLastHandledFetcherData(fetcher.data);
    if (fetcher.data?.ok) {
      setHasUnsavedChanges(false);
    }
  }

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show("Settings saved");
      shopify.saveBar.hide(SAVE_BAR_ID);
    } else {
      shopify.toast.show(fetcher.data.error ?? "Couldn't save settings", { isError: true });
    }
  }, [fetcher.data, shopify]);

  const isSaving = fetcher.state !== "idle";

  return (
    <s-page heading="Settings">
      <ui-save-bar id={SAVE_BAR_ID}>
        {/* @ts-expect-error variant is a supported attribute of ui-save-bar's slotted buttons,
            not part of React's native ButtonHTMLAttributes typing. */}
        <button variant="primary" onClick={handleSave} {...(isSaving ? { loading: "" } : {})}>
          Save
        </button>
        <button onClick={handleDiscard}>Discard</button>
      </ui-save-bar>

      <s-section heading="Age rules">
        <s-paragraph>
          Color-code orders in the Needs attention list by how long they have been open. The
          highest threshold an order has reached wins, regardless of the order the rules are
          listed in below.
        </s-paragraph>

        {rows.length === 0 ? (
          <s-paragraph>No age rules yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {rows.map((row) => (
              <s-grid key={row.key} gridTemplateColumns="1fr 1fr auto" gap="base" alignItems="end">
                <s-number-field
                  label="Older than (days)"
                  value={row.thresholdDays}
                  min={0}
                  step={1}
                  onChange={(event) =>
                    updateRow(row.key, { thresholdDays: event.currentTarget.value })
                  }
                ></s-number-field>
                <s-color-field
                  label="Color"
                  value={row.color}
                  onChange={(event) => updateRow(row.key, { color: event.currentTarget.value })}
                ></s-color-field>
                <s-button
                  variant="tertiary"
                  icon="delete"
                  accessibilityLabel="Remove rule"
                  onClick={() => removeRule(row.key)}
                ></s-button>
              </s-grid>
            ))}
          </s-stack>
        )}

        <s-button variant="secondary" icon="plus" onClick={addRule}>
          Add rule
        </s-button>
      </s-section>

      <s-section heading="Test orders">
        <s-switch
          label="Show test orders"
          checked={showTestOrders}
          onChange={(event) => {
            setShowTestOrdersValue(event.currentTarget.checked);
            markDirty();
          }}
        ></s-switch>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
