import vectors from "../../../testdata/tool-values.json"
import { expect, it } from "vitest"
import { isBoundedToolValue } from "./toolValues.ts"

it("admits the same finite JSON vectors as the Go ingestion Interface", () => {
  for (const { json } of vectors) {
    const value: unknown = JSON.parse(json)
    expect(isBoundedToolValue(value)).toBe(true)
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  }
})

it("rejects values outside the shared bounds without coercion or unbounded recursion", () => {
  const cycle: unknown[] = []; cycle.push(cycle)
  let nested: unknown = null
  for (let i = 0; i < 33; i++) nested = [nested]
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), () => 0, cycle, nested, Array(10_000), Array(10_000).fill(0), "x".repeat(65536)]) {
    expect(isBoundedToolValue(value)).toBe(false)
  }
})
