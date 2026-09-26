import { describe, expect, it } from "vitest";
import {
  ageInDays,
  buildAdminOrderUrl,
  formatDaysHoursSince,
  formatMoney,
  numericIdFromGid,
} from "./format";

describe("ageInDays", () => {
  it("returns null when the date is unknown", () => {
    expect(ageInDays(null, new Date())).toBeNull();
  });

  it("floors partial days", () => {
    const from = new Date("2026-09-20T12:00:00.000Z");
    const now = new Date("2026-09-25T11:00:00.000Z"); // 4 days 23 hours
    expect(ageInDays(from, now)).toBe(4);
  });
});

describe("formatDaysHoursSince", () => {
  it("returns an em dash when the date is unknown", () => {
    expect(formatDaysHoursSince(null, new Date())).toBe("—");
  });

  it("formats days and hours", () => {
    const from = new Date("2026-09-20T00:00:00.000Z");
    const now = new Date("2026-09-23T05:00:00.000Z");
    expect(formatDaysHoursSince(from, now)).toBe("3d 5h");
  });

  it("omits the day component when under a day", () => {
    const from = new Date("2026-09-20T00:00:00.000Z");
    const now = new Date("2026-09-20T05:00:00.000Z");
    expect(formatDaysHoursSince(from, now)).toBe("5h");
  });

  it("says just now for sub-hour gaps", () => {
    const from = new Date("2026-09-20T00:00:00.000Z");
    const now = new Date("2026-09-20T00:10:00.000Z");
    expect(formatDaysHoursSince(from, now)).toBe("just now");
  });

  it("never goes negative for a slightly-future timestamp (clock skew)", () => {
    const from = new Date("2026-09-20T00:00:10.000Z");
    const now = new Date("2026-09-20T00:00:00.000Z");
    expect(formatDaysHoursSince(from, now)).toBe("just now");
  });
});

describe("formatMoney", () => {
  it("returns an em dash when the amount is unknown", () => {
    expect(formatMoney(null, "USD")).toBe("—");
  });

  it("formats a decimal string amount with currency", () => {
    expect(formatMoney("84.5", "USD")).toBe("84.50 USD");
  });

  it("falls back to the raw string if it isn't numeric", () => {
    expect(formatMoney("not-a-number", "USD")).toBe("not-a-number USD");
  });
});

describe("numericIdFromGid", () => {
  it("extracts the trailing numeric id", () => {
    expect(numericIdFromGid("gid://shopify/Order/18906468024599")).toBe("18906468024599");
  });

  it("returns null for a non-GID string", () => {
    expect(numericIdFromGid("not-a-gid")).toBeNull();
  });
});

describe("buildAdminOrderUrl", () => {
  it("builds a legacy-style admin order URL", () => {
    expect(buildAdminOrderUrl("test-shop.myshopify.com", "gid://shopify/Order/123")).toBe(
      "https://test-shop.myshopify.com/admin/orders/123",
    );
  });

  it("returns null when the numeric id can't be extracted", () => {
    expect(buildAdminOrderUrl("test-shop.myshopify.com", "not-a-gid")).toBeNull();
  });
});
