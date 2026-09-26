import { describe, expect, it } from "vitest";
import { isValidHexColor, resolveAgeColor, validateAgeRules, type AgeRule } from "./age-rules";

describe("isValidHexColor", () => {
  it.each(["#fff", "#FFFFFF", "#a1b2c3", "#000"])("accepts %s", (value) => {
    expect(isValidHexColor(value)).toBe(true);
  });

  it.each(["fff", "#ff", "#gggggg", "red", "", "#12345"])("rejects %s", (value) => {
    expect(isValidHexColor(value)).toBe(false);
  });
});

describe("validateAgeRules", () => {
  it("accepts an empty rule set", () => {
    expect(validateAgeRules([])).toEqual([]);
  });

  it("accepts valid, uniquely-thresholded rules", () => {
    const rules: AgeRule[] = [
      { id: "a", thresholdDays: 1, color: "#ffff00" },
      { id: "b", thresholdDays: 7, color: "#ff0000" },
    ];
    expect(validateAgeRules(rules)).toEqual([]);
  });

  it("flags a negative threshold", () => {
    const errors = validateAgeRules([{ id: "a", thresholdDays: -1, color: "#fff" }]);
    expect(errors).toHaveLength(1);
  });

  it("flags a duplicate threshold", () => {
    const rules: AgeRule[] = [
      { id: "a", thresholdDays: 5, color: "#fff" },
      { id: "b", thresholdDays: 5, color: "#000" },
    ];
    expect(validateAgeRules(rules).some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("flags an invalid color", () => {
    const errors = validateAgeRules([{ id: "a", thresholdDays: 1, color: "not-a-color" }]);
    expect(errors).toHaveLength(1);
  });
});

describe("resolveAgeColor", () => {
  const rules: AgeRule[] = [
    { id: "warn", thresholdDays: 3, color: "#ffff00" },
    { id: "critical", thresholdDays: 7, color: "#ff0000" },
  ];

  it("returns null when no rules are configured", () => {
    expect(resolveAgeColor(100, [])).toBeNull();
  });

  it("returns null when the age hasn't reached any threshold", () => {
    expect(resolveAgeColor(1, rules)).toBeNull();
  });

  it("returns the matching rule's color at the exact threshold", () => {
    expect(resolveAgeColor(3, rules)).toBe("#ffff00");
  });

  it("returns the highest-threshold rule reached, not the first one entered", () => {
    expect(resolveAgeColor(10, rules)).toBe("#ff0000");
  });

  it("is independent of the order rules are passed in", () => {
    const reversed = [...rules].reverse();
    expect(resolveAgeColor(10, reversed)).toBe("#ff0000");
    expect(resolveAgeColor(4, reversed)).toBe("#ffff00");
  });
});
