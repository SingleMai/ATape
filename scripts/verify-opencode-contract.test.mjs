import { test } from "node:test"
import assert from "node:assert/strict"
import { requiredTest, verifyOpenCodeResult, verifyAllProviderResults } from "./verify-opencode-contract.mjs"
import "./freeze-claude-legacy.test.mjs"

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

import { requiredTest as grokTest, verifyGrokResult } from "./verify-grok-contract.mjs"
test("Grok acceptance cannot pass using another provider or a skipped subtest", () => {
  const event = { Test: grokTest, Package: "github.com/SingleMai/ATape/server/internal/adapters/httpapi" }
  assert.throws(() => verifyGrokResult([]), /missing or skipped/)
  assert.throws(() => verifyGrokResult([{ ...event, Action: "skip" }]), /missing or skipped/)
  assert.throws(() => verifyGrokResult([{ ...event, Action: "pass", Test: requiredTest }]), /missing or skipped/)
  assert.doesNotThrow(() => verifyGrokResult([{ ...event, Action: "pass" }]))
})

import { requiredTest as kimiTest, verifyKimiResult } from "./verify-kimi-contract.mjs"
test("Kimi acceptance cannot pass using only existing provider results", () => {
  const event = { Test: kimiTest, Package: "github.com/SingleMai/ATape/server/internal/adapters/httpapi" }
  assert.throws(() => verifyKimiResult([]), /missing or skipped/)
  assert.throws(() => verifyKimiResult([{ ...event, Action: "skip" }]), /missing or skipped/)
  assert.throws(() => verifyKimiResult([{ ...event, Action: "pass", Test: requiredTest }]), /missing or skipped/)
  assert.doesNotThrow(() => verifyKimiResult([{ ...event, Action: "pass" }]))
})

import { requiredTest as claudeTest, requiredLegacyTest as legacyClaudeTest } from "./verify-claude-contract.mjs"
test("combined acceptance requires Claude even when every source-capture provider passed", () => {
  const events = [requiredTest, codeBuddyTest, kimiTest, grokTest].map(Test => ({
    Test, Action: "pass", Package: "github.com/SingleMai/ATape/server/internal/adapters/httpapi"
  }))
  assert.throws(() => verifyAllProviderResults(events), /Claude.*missing or skipped/)
  const claude = { Test: claudeTest, Action: "pass", Package: events[0].Package }
  assert.throws(() => verifyAllProviderResults([...events, { ...claude, Action: "skip" }]), /Claude.*missing or skipped/)
  assert.throws(() => verifyAllProviderResults([...events, claude]), /Claude.*missing or skipped/)
  assert.throws(() => verifyAllProviderResults([...events, claude, { ...claude, Test: legacyClaudeTest, Action: "skip" }]), /Claude.*missing or skipped/)
  assert.doesNotThrow(() => verifyAllProviderResults([...events, claude, { ...claude, Test: legacyClaudeTest }]))
})
