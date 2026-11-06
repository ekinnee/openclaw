# Signed-device acceptance handoff — PR #191565

Candidate: `579aa20dc9d9d2167c875de325d2c49435cfea79`
Tree: `c73d8fc06bd5f1f458e0aa58fed3d49d1ea3243e`

## Scope and required owner

This stage requires an authorized official-relay-capable signed candidate build and a physical iPhone. The available tester has a physical iPhone and Xcode Personal Team signing, but no such candidate build. An official TestFlight candidate supplied by the signing owner is the preferred route; a tester need not purchase developer membership. An ordinary locally signed build or existing App Store release is not proof of this candidate's hosted-relay recovery.

Do not change distribution proof requirements, disable relay protections, upload a release, or alter production credentials/pairings merely to obtain evidence. Use a task-owned test Gateway/pairing and an authorized test device/enrollment. Official signing/publication and live operations need their owners' authorization.

## Already complete — do not repeat merely for handoff

- Simulator build and 28 focused tests on matching candidate source.
- Swift lint/format and macOS compilation.
- Four inspected Diagnostics screenshots with explicit delivery-unverified wording.
- Gateway/schema local boundary tests and static owner/lifecycle reviews.

These are separate contracts; none proves actual APNs delivery or the real application's recovery sequence.

## Device scenarios still to demonstrate

Record exact candidate SHA, Gateway SHA, device OS, distribution/APNs environment, and a sanitized scenario/outcome ledger. Bind each result to the tested build.

1. Establish the affected rejected-enrollment baseline: an authenticated paired device whose relay push returns typed `410 Unregistered`. Do not infer it from disconnected transport or a successful publication timestamp. Re-establish the rejected baseline between experiments; recovery can change the state under test.
2. Compare APNs token reacquisition alone, fresh relay enrollment with an unchanged token, and the combined candidate recovery path. Record only token-changed/unchanged observations, not token values. This separates the original incident's uncertain cause from the proposed recovery's actual effect.
3. Exercise automatic recovery after authenticated reconnect. Confirm the budget is bounded across relaunch/reconnect, same-enrollment republication does not erase the rejection, and a genuinely replaced enrollment is not poisoned by old feedback.
4. Exercise token-callback failure/timeout followed by the explicit manual retry, plus a disconnect or Gateway switch while token acquisition or enrollment is suspended. Ensure stale work does not publish to a retired route or overwrite another scope's enrollment.
5. Verify the visible states: needs retry/actionable guidance, recovering, and published with delivery explicitly unverified. Inspect sanitized before/after screenshots. Permission status must remain separate from enrollment and delivery health.
6. Separately observe an actual alert arriving on the device and the intended background-wake/reconnect behavior. A new relay handle, successful event result, or HTTP acceptance alone does not establish user-visible receipt.
7. Confirm a peer device/registration and the direct-token transport remain unaffected. Record any untested sibling path explicitly.

Keep reports free of full APNs tokens, relay handles, send grants, credentials, personal Gateway addresses, private node IDs, and App Attest material. No paid service, release, or destructive reset is authorized by this checklist.

## Maintainer decision remains separate

Accept or reject the proposed registration-scoped persistent rejection and recovery-budget contract. The local reviews and simulator evidence do not substitute for this decision. Keep the PR draft and preserve unresolved CI/proof gaps until its owner completes the applicable workflow.
