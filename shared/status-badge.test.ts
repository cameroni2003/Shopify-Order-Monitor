import { describe, expect, it } from "vitest";
import { financialStatusTone, fulfillmentStatusTone } from "./status-badge";

describe("financialStatusTone", () => {
  it("returns success for PAID", () => {
    expect(financialStatusTone("PAID")).toBe("success");
  });

  it("returns null for null input", () => {
    expect(financialStatusTone(null)).toBeNull();
  });

  it("returns null (default badge) for an unrecognized value", () => {
    expect(financialStatusTone("SOME_FUTURE_VALUE")).toBeNull();
  });
});

describe("fulfillmentStatusTone", () => {
  it("returns success for FULFILLED", () => {
    expect(fulfillmentStatusTone("FULFILLED")).toBe("success");
  });

  it("returns critical for ON_HOLD", () => {
    expect(fulfillmentStatusTone("ON_HOLD")).toBe("critical");
  });

  it("returns null for an unrecognized value", () => {
    expect(fulfillmentStatusTone("SOME_FUTURE_VALUE")).toBeNull();
  });
});
