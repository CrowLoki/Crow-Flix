import { describe, expect, it } from "vitest";
import {
  appendZapDigit,
  MAX_ZAP_DIGITS,
  resolveZapNumber,
  zapTarget,
} from "./zap";

const KEYS = ["a", "b", "c", "d"];

describe("zapTarget", () => {
  it("moves to the next channel in the list", () => {
    expect(zapTarget(KEYS, "b", 1)).toBe("c");
  });

  it("moves to the previous channel in the list", () => {
    expect(zapTarget(KEYS, "c", -1)).toBe("b");
  });

  it("wraps past the end of the list", () => {
    expect(zapTarget(KEYS, "d", 1)).toBe("a");
  });

  it("wraps before the start of the list", () => {
    expect(zapTarget(KEYS, "a", -1)).toBe("d");
  });

  it("starts at the first channel when nothing is playing", () => {
    expect(zapTarget(KEYS, null, 1)).toBe("a");
  });

  it("starts at the last channel when channel-down arrives first", () => {
    expect(zapTarget(KEYS, null, -1)).toBe("d");
  });

  it("restarts from an edge when the playing channel left the list", () => {
    expect(zapTarget(KEYS, "removed", 1)).toBe("a");
    expect(zapTarget(KEYS, "removed", -1)).toBe("d");
  });

  it("returns null for an empty catalogue", () => {
    expect(zapTarget([], "a", 1)).toBeNull();
    expect(zapTarget([], null, -1)).toBeNull();
  });

  it("stays on the only channel of a single-channel list", () => {
    expect(zapTarget(["only"], "only", 1)).toBe("only");
    expect(zapTarget(["only"], "only", -1)).toBe("only");
  });
});

describe("appendZapDigit", () => {
  it("accumulates typed digits", () => {
    expect(appendZapDigit("", "4")).toBe("4");
    expect(appendZapDigit("4", "2")).toBe("42");
  });

  it("keeps only the most recent digits up to the limit", () => {
    const full = "9".repeat(MAX_ZAP_DIGITS);
    expect(appendZapDigit(full, "1")).toBe(`${"9".repeat(MAX_ZAP_DIGITS - 1)}1`);
  });

  it("ignores non-digit input", () => {
    expect(appendZapDigit("12", "x")).toBe("12");
  });
});

describe("resolveZapNumber", () => {
  it("maps typed 1-based numbers to list indexes", () => {
    expect(resolveZapNumber("1", 10)).toBe(0);
    expect(resolveZapNumber("10", 10)).toBe(9);
  });

  it("accepts leading zeros the way remotes do", () => {
    expect(resolveZapNumber("007", 10)).toBe(6);
  });

  it("rejects numbers outside the list", () => {
    expect(resolveZapNumber("0", 10)).toBeNull();
    expect(resolveZapNumber("11", 10)).toBeNull();
  });

  it("rejects empty input and empty lists", () => {
    expect(resolveZapNumber("", 10)).toBeNull();
    expect(resolveZapNumber("3", 0)).toBeNull();
  });
});
