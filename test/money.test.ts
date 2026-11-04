import { describe, expect, it } from "vitest";
import { decimalToMinor, minorToDecimal } from "../src/money.js";

describe("money (invariant I8)", () => {
  it("converts minor units to PayPal decimals", () => {
    expect(minorToDecimal(3800)).toBe("38.00");
    expect(minorToDecimal(5)).toBe("0.05");
    expect(minorToDecimal(1999)).toBe("19.99");
  });
  it("converts PayPal decimals back without float error", () => {
    expect(decimalToMinor("38.00")).toBe(3800);
    expect(decimalToMinor("0.1")).toBe(10);
    expect(decimalToMinor("19.99")).toBe(1999);
    expect(decimalToMinor("7")).toBe(700);
  });
  it("round-trips every cent from 0 to 100000", () => {
    for (let n = 0; n <= 100_000; n++) expect(decimalToMinor(minorToDecimal(n))).toBe(n);
  });
  it("rejects bad input", () => {
    expect(() => minorToDecimal(1.5)).toThrow();
    expect(() => minorToDecimal(-1)).toThrow();
    expect(() => decimalToMinor("1.234")).toThrow();
    expect(() => decimalToMinor("-3")).toThrow();
  });
});
