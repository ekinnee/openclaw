# C3 writer-fence prerequisite — team handoff

This dedicated fork branch transfers the standalone prerequisite for team-owned integration. It is **not an upstream PR, integrated acceptance, schema allocation or activation**. No force-push is authorized. The sender retains dependent N1 and performs no parallel prerequisite integration.

## Exact identity and reconstruction

- Historical base: `9a1a7541d53f6e5f26e26b44a5806e0d09c81903`.
- Source-only transfer commit: `9a9eab182c87e2d2fc29b00f04ad9e10d80383f2`. Its parent is the exact base; its Git tree is **`f97339497ca0623794a30da4392370711a0a46b1`**, exactly the accepted local C3 review tree.
- Changed-source checksum: **`c12149b1de17ebcd9abf571a11e46c1ddd53719cbff100ba97980575b76978e9`**, the canonical compact sorted JSON of121 path→SHA256 facts, not a Git commit/full-tree checksum.
- Final branch head adds ONLY this `handoff/writer-fence-c3/` directory. Do not cherry-pick its handoff files into a production implementation unintentionally.
- `source/source-manifest.json` records every included path/hash/mode and original local review relationship. All121 source paths, five added files and generated inputs are present in the actual repository tree. `source/C3.patch` is the complete original base→C3 patch, SHA256 `9c37e11c4db3f4f3a7fc4844cca42b9cf7fc9270b2caecb6331798a2064c62f5`.

Fetch this branch from `https://github.com/ekinnee/openclaw.git`, verify the announced final head, and run from its checkout:

```sh
python3 handoff/writer-fence-c3/verify-source.py --root "$PWD"
(cd handoff/writer-fence-c3 && sha256sum -c SHA256SUMS)
git rev-parse 9a9eab182c87e2d2fc29b00f04ad9e10d80383f2^          # exact historical base
git rev-parse 9a9eab182c87e2d2fc29b00f04ad9e10d80383f2^{tree}  # exact accepted tree above
```

Alternatively apply `source/C3.patch` to an isolated clean exact-base worktree with `git apply --check` then `git apply`, and run the verifier. Git modes are recorded separately; the original workspace exposes synthetic filesystem executable bits and those bits are not authority over accepted Git modes. Full source-tree identity is the source-only commit tree; final head also contains handoff documents.

## Evidence and plan

Start with [proof/review index](evidence/PROOF-AND-REVIEW-INDEX.md), [claim matrix](evidence/C3/acceptance-matrix.json), [sanitized reached output](evidence/C3/sanitized-terminal.txt), [review disposition](evidence/reviews.json), and [limits](evidence/C3/evidence-limits.json).

Historical canonical archive: SHA256 `dd835bdab74c3df35346c1ab8d10dbcf521b3dc35cceb6f52d91a065c4ce8203`,113194006bytes, source c12149b1…. Actual normal predecessor CLI→corrected packaged Doctor→old retained calls/cold refusals→authenticated current Gateway/restart and public SDK controls completed. The archive, private state and credentials are NOT uploaded. Receipt-bound historical results are distinct from recipient proof. This handoff ran no new builds/reviews/runtime campaign.

[Concrete integration decision](decisions/historical/integration-delivery-decision-20261103.md) uses exact team assessment pin `8f9190485c615c025685b92d8ec1c5e9625cd987`; [dependency map](decisions/historical/local-dependency-map-20261103.md) documents the N1 boundary. Earlier “report pending/local lead” wording is historical; current ownership is team prerequisite / sender N1. The proposed12-hour local integration was not started; historical estimates are not newly approved team funding.

[Current transfer contract](decisions/TRANSFER-CONTRACT.md) states maintainer decisions, V1-only generic mutation restriction and exclusions. Reconcile merged #191357/#190875/#189827, exact descriptor/PG/restore/redaction/floor contracts and experimental-format collisions before integrated acceptance. Preserve official migration history; staging numbers are not reservations. Maintainer landing/interface acceptance and schema-number coordination remain explicit gates. No upstream PR, merge, production changes or native continuation is authorized by this handoff.

[Reproduction commands/fixtures](reproduction.md) retain actual normal-entry boundaries, positive controls and known observer corrections. Historical launchers have sanitized host-specific paths/seals; they are not newly qualified portable green runners. Rebind only operational inputs through recipient-owned launchers and record fresh build seals; never delete integrity/admission assertions. Ordinary baseline lock is at repository root. Source-identical historical proof is reusable only as qualified in the plan; integration must refresh affected contracts and the actual integrated package.

## Inspection and exclusions

Complete outgoing source matches the accepted tree; all handoff files are an explicit public whitelist with path sanitization and provenance hashes. No raw reviewer prompts/transcripts, private runtime/config/client credentials, state databases, native homes, dependencies/caches or full runtime archive are included. See [exclusions](EXCLUSIONS.md). `evidence/provenance.json` distinguishes original and sanitized bytes. No OpenClaw/agent attribution footer is added; verified human authorship is retained.
