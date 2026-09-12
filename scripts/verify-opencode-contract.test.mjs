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

import { requiredTest as codeBuddyTest, verifyCodeBuddyResult } from "./verify-codebuddy-contract.mjs"
test("CodeBuddy acceptance cannot pass using only existing provider results", () => {
  const event = { Test: codeBuddyTest, Package: "github.com/SingleMai/ATape/server/internal/adapters/httpapi" }
  assert.throws(() => verifyCodeBuddyResult([]), /missing or skipped/)
  assert.throws(() => verifyCodeBuddyResult([{ ...event, Action: "skip" }]), /missing or skipped/)
  assert.throws(() => verifyCodeBuddyResult([{ ...event, Action: "pass", Test: requiredTest }]), /missing or skipped/)
  assert.doesNotThrow(() => verifyCodeBuddyResult([{ ...event, Action: "pass" }]))
})
