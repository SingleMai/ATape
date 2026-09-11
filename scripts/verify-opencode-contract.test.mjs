import { test } from "node:test"
import assert from "node:assert/strict"
import { requiredTest, verifyOpenCodeResult } from "./verify-opencode-contract.mjs"

test("OpenCode acceptance requires the actual named subtest to pass", () => {
  const event = { Test: requiredTest, Package: "github.com/SingleMai/ATape/server/internal/adapters/httpapi" }
  assert.throws(() => verifyOpenCodeResult([]), /missing or skipped/)
  assert.throws(() => verifyOpenCodeResult([{ ...event, Action: "skip" }]), /missing or skipped/)
  assert.throws(() => verifyOpenCodeResult([{ ...event, Action: "pass", Test: "some-other-test" }]), /missing or skipped/)
  assert.doesNotThrow(() => verifyOpenCodeResult([{ ...event, Action: "pass" }]))
})
