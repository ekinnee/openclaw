## Follow-up validation and handoff

We prepared a reviewed refresh of this PR and pushed it to [ekinnee's handoff branch](https://github.com/ekinnee/openclaw/tree/handoff/pr191565-579aa20d). The application-code candidate is `579aa20dc9d9d2167c875de325d2c49435cfea79`, retaining original head `613212b` and adding pinned main `c9d9bace` plus reviewed Swift lint/helper cleanup. The proof-only commit on top does not alter that validated code and is not intended for inclusion in the product PR.

The branch's [`handoff/pr191565` evidence folder](https://github.com/ekinnee/openclaw/tree/handoff/pr191565-579aa20d/handoff/pr191565) contains the source-bound ledger, focused lint log, inspected before/after screenshot states, and remaining signed-device checklist. Verify that evidence follow-up has been pushed before posting these folder links.

Completed:
- 326 APNs/Gateway/schema tests and canonical schema artifact verification on the refresh parent; final Swift-only cleanup leaves the tested TS/schema source unchanged.
- Focused type-aware lint on final candidate: 14 changed TS files, zero warnings/errors.
- Mac build/test evidence on matching tracked source: iOS Simulator build, 28 focused Swift tests without failures/skips, Swift lint/format, and macOS compilation including all six affected files.
- Independent static integration/cleanup reviews found no actionable high-confidence regressions.
- Inspected Diagnostics screenshots show retry-needed, recovering, and published-with-delivery-unverified wording. Synthetic rendered states only; not a real recovery execution or APNs receipt. The before capture is pinned-main UI owner in candidate shell, not full pinned-main runtime.

Still pending: maintainer acceptance of the recovery/persistence contract, full hosted CI/current-head review, and an official-relay-capable signed candidate for physical-device rejection/recovery and actual receipt testing. The previous broad local scoped gate found an unrelated Doctor unused export reproduced on pinned main; that limitation is documented rather than hidden.

I have an iPhone available to test, but only Personal Team signing. Can someone with official signing access coordinate a TestFlight candidate and the remaining contract decision? This is a continuation of the existing PR, not a competing fix. We are not claiming restored notification delivery yet.
