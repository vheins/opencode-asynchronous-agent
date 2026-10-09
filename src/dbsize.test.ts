import { expect, test } from "bun:test"
import { humanBytes } from "./dbsize"

test("humanBytes returns a placeholder for a missing or invalid count", () => {
  expect(humanBytes(undefined)).toBe("—")
  expect(humanBytes(-1)).toBe("—")
  expect(humanBytes(Number.NaN)).toBe("—")
  expect(humanBytes(Number.POSITIVE_INFINITY)).toBe("—")
})

test("humanBytes renders bytes without a decimal", () => {
  expect(humanBytes(0)).toBe("0 B")
  expect(humanBytes(1)).toBe("1 B")
  expect(humanBytes(1023)).toBe("1023 B")
})

test("humanBytes steps up the unit at each 1024 boundary", () => {
  expect(humanBytes(1024)).toBe("1.0 KB")
  expect(humanBytes(1024 * 1024)).toBe("1.0 MB")
  expect(humanBytes(1024 ** 3)).toBe("1.0 GB")
  expect(humanBytes(1024 ** 4)).toBe("1.0 TB")
})

test("humanBytes keeps one decimal and carries a rounding boundary up a unit", () => {
  expect(humanBytes(1536)).toBe("1.5 KB")
  expect(humanBytes(12.4 * 1024 * 1024)).toBe("12.4 MB")
  expect(humanBytes(1024 * 1024 - 1)).toBe("1.0 MB")
})
