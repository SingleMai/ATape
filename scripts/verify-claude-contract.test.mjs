import { test } from "node:test"
import assert from "node:assert/strict"
import { requiredTest, requiredLegacyTest, requiredTests, verifyClaudeResult } from "./verify-claude-contract.mjs"
import "./freeze-claude-legacy.test.mjs"

test("Claude acceptance requires its actual non-skipped PostgreSQL subtest", () => {
  const event = { Test: requiredTest, Package: "github.com/SingleMai/ATape/server/internal/adapters/httpapi" }
  assert.throws(() => verifyClaudeResult([]), /missing or skipped/)
  assert.throws(() => verifyClaudeResult([{ ...event, Action: "skip" }]), /missing or skipped/)
  assert.throws(() => verifyClaudeResult([{ ...event, Action: "pass", Test: "native_OpenCode_Collector" }]), /missing or skipped/)
  assert.throws(() => verifyClaudeResult([{ ...event, Action: "pass", Package: "another-package" }]), /missing or skipped/)
  assert.throws(() => verifyClaudeResult([{ ...event, Action: "pass" }]), /missing or skipped/)
  assert.throws(() => verifyClaudeResult([{ ...event, Action: "pass", Test: requiredLegacyTest }]), /missing or skipped/)
  assert.throws(() => verifyClaudeResult([{ ...event, Action: "pass" }, { ...event, Test: requiredLegacyTest, Action: "skip" }]), /missing or skipped/)
  assert.doesNotThrow(() => verifyClaudeResult(requiredTests.map(Test => ({ ...event, Test, Action: "pass" }))))
})
