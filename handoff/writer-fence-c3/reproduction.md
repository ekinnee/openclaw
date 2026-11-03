# Reproduction inputs and commands

Fixtures are self-contained source, not installed dependencies or private runtime state. Exact historical scripts/receipts retain hashes and path substitutions in evidence/provenance.json. They are supplied for review and adaptation through recipient-owned launchers; they were not executed again during transfer. Historical README “prepared/unexecuted” text describes its creation-time status, superseded by C3 receipts.

## Source checks

Use the exact source verifier first. The full patch contains actual checked-in regression sources, descriptors, allocation and generated outputs. F2/static-results.json and regression-*-result.json record exact commands/configuration and reached results. Rewrite only operational absolute tsconfig/worktree locations to recipient-owned paths, retaining root files, tool versions, runner selection and assertions. The affected16-test file is src/state/openclaw-state-db-plugin-writer-fence.test.ts. Preserve the released predecessor DDL and full Doctor operation, not a reversed successor schema. F2 pre-fix red was C2, not a new defect on C3.

## Build and install boundary

Historical pinned versions: Node26.13.0, pnpm12.15.0, tsdown0.23.2, Rolldown1.2.15, TypeScript7.1.0-dev.20261016.1. Lock SHA256 101b4a2ffbf9dcd0ddaf00412655406de24ec219cb3595a80426f9c3cdf14f16. The included pinned lock is a verification input, not permission to overwrite another checkout. Integrated upstream toolchain changes require their own attribution and evidence.

From the task-owned exact source, historical canonical build command:

```sh
node scripts/package-openclaw-for-docker.mjs --allow-unreleased-changelog   --bundle-plugin codex --bundle-plugin matrix   --source-dir /absolute/task-worktree --output-dir /absolute/owned-package-output   --output-name openclaw-writer-fence-C3.tgz
```

Give HOME/state/config/TMPDIR/npm cache/Node cache fresh private directories; check disk-backed scratch, effective memory/shmem/pressure and concurrent build activity first. Do not use shared/production credentials or alter host limits. Build lock recovery must use the build owner's documented stale-owner procedure after verifying owner and descendants are gone; no blind lock deletion. The earlier memory-backed scratch incident and raw host logs are excluded. Disk backing is not a capacity guarantee.

For installed-entry proof, the actual successful preparation copied pinned registry bytes privately and used the package's own workspace artifacts (523-edge graph); it was NOT a fresh network install. Historical stager and workspace/promotion data are under fixtures/historical. Set sourceRoot and receipt/archive inputs to current verified recipient paths. Keep safe extraction, package lifecycle, workspace-owner/lock checks and dependency isolation. Do not borrow live node_modules targets or silently upgrade. Staging historical sourceSnapshot fields must be re-observed for a new build. Exact historical archive bytes are not included and a rebuilt archive gets its own identity.

## Normal CLI/Gateway flow

`fixtures/normal-entry/plugin` registers through api.registerCli and api.registerGatewayMethod, uses public api.runtime.state, and emits content-free boundary events. Preserve its loader provenance and actual authenticated RPC; do not replace with a mock server. Direct fixture/plugin directories must be0700, files0600 because artifact mounts can be world-writable. Use fresh loopback-only task configuration with channels/Bonjour off, provider credentials absent, task random token in0600 config/environment ONLY. Do not print it. Run from a private working directory outside an OpenClaw ancestor; use Node --no-global-search-paths.

1. Build predecessor at exact base and candidate separately. Hash original output and entry inputs. Historical old-built-output-manifest.json and old-entry-inputs.json document the original build, not a seal for different rebuilt bytes. A recipient rebuild needs a newly recorded complete output seal and explicit source/toolchain attribution, never removal of the integrity check.
2. Adapt the historical orchestrate.py using ONLY freshly admitted paths/seals. Its original hard-sealed paths and expected diagnostic wording are historical; it is NOT a drop-in portable green runner after redaction. Keep original wait/order/cleanup logic and all positive controls. No runtime test was run on an adapted script here.
3. Start `node OLD/openclaw.mjs writer-fence-proof`; wait for PRIMED with ordinary positives. Keep the process/owned native handles alive.
4. Run `node CURRENT/openclaw.mjs doctor --repair --non-interactive --yes --no-workspace-suggestions`; compare physical identity, guard/catalog, floor and all12 original rows read-only.
5. Only after successful Doctor send RELEASE_AFTER_DOCTOR to held old stdin. Require exactly13 INVOKED/REFUSED outcomes and exact rows; unexpected success or different refusal is a failed gate. Historical async reopening is distinguished from warm native statement evidence.
6. Cold old plugin CLI must refuse before PRIMED and preserve rows. C3 actual outcome is PLUGIN_STATE_WRITE_FAILED/ERR_SQLITE_ERROR at retired relation, NOT a schema diagnostic. Cold old `gateway run` must refuse selected store schema40/max39. For integrated version numbers assert the corresponding actual supported floor, not C3 literals.
7. Current normal `doctor --client-credentials` prepares task local auth. Start `gateway run --bind loopback --port PORT`. Use configured local target: `gateway call health --params '{}' --json`, then `gateway call writer-fence-proof.crud --params '{"phase":"prime"}' --json`. Do NOT pass --url without its required explicit credential contract; no guard bypass or secret argv. Stop/join and restart a fresh process; call once with `{"phase":"verify"}`. Require ordinary,persisted,cas,retainedMove true. Retry only non-mutating startup readiness; never replay uncertain mutation.
8. Preserve all output/identity/row hashes, join owned process groups, verify port closed, source/registry unchanged. Normal first-run package lifecycle removes only .openclaw-lifecycle-pending; do not restore it or patch generated outputs. Empty lock directory alone is not a retained active ownership claim.

Actual successful configured-target continuation source is fixtures/historical/C3-configured-gateway-continuation.py; it consumes old private state and is historical, not directly executable on another host. Do not transfer that state to make it run.

## Public SDK controls

Copy fixtures/normal-entry/built-sdk-future-binding.mjs into a fresh private script directory outside an OpenClaw checkout/package ancestor and run through its exported public contract:

```sh
node --no-global-search-paths /absolute/private-scripts/built-sdk-future-binding.mjs  --package-root /absolute/verified-installed-package --evidence-dir /absolute/fresh-evidence
```

Require legitimate managedV1/ordinary positives and overwrite/delete/clear/expiry/consume refusals with saved bytes intact. Synthetic future saved rows are explicitly operator fixtures, not native provenance or successful authorization mocks. The script's original isolation admissions remain mandatory.

## PostgreSQL / restore

Historical native/bridge runners and actual receipts are included under fixtures/historical/postgres and evidence/historical/postgres. Use a disposable supported PG16 peer with synthetic user/database and loopback-only connection; current resource admission is required. First512MiB peer failed; later state-store proof used2GiB. These are fixtures, not authority for a live database. Keep generic/custom cached-plan assertions, queued/active lock observations, uncertain COMMIT reconciliation and current/unrelated positives. For migration/port tests use source tests carried in the complete patch, canonical generated descriptors and actual supported upgrade/restore owners. Historical restore fixture under fixtures/historical/mutation-restore is supporting source-path proof, not a normal shipped entry point. Requalify relocated upstream caller targets during integration.
