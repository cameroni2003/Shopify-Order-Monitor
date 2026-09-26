import { describe, expect, it } from "vitest";
import {
  ageInDays,
  buildAdminOrderUrl,
  formatMoney,
  formatTimeSince,
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

describe("formatTimeSince", () => {
  it("returns an em dash when the date is unknown", () => {
    expect(formatTimeSince(null, new Date())).toBe("—");
  });

  it("says just now for sub-minute gaps", () => {
    const from = new Date("2026-09-20T00:00:00.000Z");
    const now = new Date("2026-09-20T00:00:30.000Z");
    expect(formatTimeSince(from, now)).toBe("just now");
  });

  it("shows minutes once at least a minute has passed", () => {
    const from = new Date("2026-09-20T00:00:00.000Z");
    const now = new Date("2026-09-20T00:01:00.000Z");
    expect(formatTimeSince(from, now)).toBe("1m");
  });

  it("keeps showing minutes right up to the last minute before an hour", () => {
    const from = new Date("2026-09-20T00:00:00.000Z");
    const now = new Date("2026-09-20T00:59:00.000Z");
    expect(formatTimeSince(from, now)).toBe("59m");
  });

  it("switches to hours at exactly one hour", () => {
    const from = new Date("2026-09-20T00:00:00.000Z");
    const now = new Date("2026-09-20T01:00:00.000Z");
    expect(formatTimeSince(from, now)).toBe("1h");
  });

  it("shows a single hours figure, not combined with minutes, right up to a day", () => {
    const from = new Date("2026-09-20T00:00:00.000Z");
    const now = new Date("2026-09-20T23:59:00.000Z");
    expect(formatTimeSince(from, now)).toBe("23h");
  });

  it("switches to days at exactly one day", () => {
    const from = new Date("2026-09-20T00:00:00.000Z");
    const now = new Date("2026-09-21T00:00:00.000Z");
    expect(formatTimeSince(from, now)).toBe("1d");
  });

  it("shows a single days figure for multi-day gaps", () => {
    const from = new Date("2026-09-20T00:00:00.000Z");
    const now = new Date("2026-09-23T05:00:00.000Z");
    expect(formatTimeSince(from, now)).toBe("3d");
  });

  it("never goes negative for a slightly-future timestamp (clock skew)", () => {
    const from = new Date("2026-09-20T00:00:10.000Z");
    const now = new Date("2026-09-20T00:00:00.000Z");
    expect(formatTimeSince(from, now)).toBe("just now");
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
