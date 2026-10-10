import { test } from "node:test"
import assert from "node:assert/strict"
import { requiredTest, verifyCursorResult } from "./verify-cursor-contract.mjs"

test("controlled Cursor acceptance requires its exact installed HTTP/PG subtest", () => {
  const event = { Test: requiredTest, Package: "github.com/SingleMai/ATape/server/internal/adapters/httpapi", Action: "pass" }
  for (const events of [[], [{ ...event, Action: "skip" }], [{ ...event, Action: "fail" }],
    [{ ...event, Test: "TestHTTPAuthenticationAndAuthorizationContract" }],
    [{ ...event, Test: "TestHTTPAuthenticationAndAuthorizationContract/native_Grok_Collector" }],
    [{ ...event, Package: "github.com/SingleMai/ATape/server/internal/adapters/postgres" }]]) {
    assert.throws(() => verifyCursorResult(events), /missing or skipped/)
  }
  assert.doesNotThrow(() => verifyCursorResult([event]))
})
