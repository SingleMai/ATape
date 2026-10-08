import { test } from "node:test"
import assert from "node:assert/strict"
import { requiredTest, verifyClaudeResult } from "./verify-claude-contract.mjs"

test("Claude acceptance requires its actual non-skipped PostgreSQL subtest", () => {
  const event = { Test: requiredTest, Package: "github.com/SingleMai/ATape/server/internal/adapters/httpapi" }
  assert.throws(() => verifyClaudeResult([]), /missing or skipped/)
  assert.throws(() => verifyClaudeResult([{ ...event, Action: "skip" }]), /missing or skipped/)
  assert.throws(() => verifyClaudeResult([{ ...event, Action: "pass", Test: "native_OpenCode_Collector" }]), /missing or skipped/)
  assert.throws(() => verifyClaudeResult([{ ...event, Action: "pass", Package: "another-package" }]), /missing or skipped/)
  assert.doesNotThrow(() => verifyClaudeResult([{ ...event, Action: "pass" }]))
})
