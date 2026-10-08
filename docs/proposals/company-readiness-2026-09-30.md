# Company readiness audit — 2026-09-30

*Written against aegraph-ui's hosted edition (sign-in, server functions), which this edition removes.*

## Decision

**Suitable for a controlled internal pilot after the fixes in this audit, with the deployment gates below. Not approved as an unrestricted, confidential-data, multi-user company platform.**

The product is a local-first developer workspace. A project scopes views over one browser Library; it is not an authorization boundary between employees. Supabase sign-in gates the hosted assistant and administration, not a shared project database. Browser storage, local workspace files and exports remain the data system of record. A company must supply identity policy, managed devices, independent backups, approved network destinations and operational ownership.

This audit started at `9fb3a8a1` in an isolated worktree. It reviewed repository code and configuration, exercised synthetic data, checked current npm advisories, and tested the build. It did not inspect production credentials, modify cloud settings, deploy, or use the owner's personal Library.

## Verified defects and changes

| Priority | Finding and impact | Resolution and evidence |
| --- | --- | --- |
| P1 | *[Redacted in the public edition: notes on the hosted site's configuration.]* | |
| P1 | *[Redacted in the public edition: notes on the hosted site's configuration.]* | |
| P1 | `src/headless/workspaceTools.ts` bypassed the engine's destructive-operation policy: reload discarded pending edits, imports overwrote IDs and exports truncated existing files. | Refusal mode checks reload/import before mutation and uses `O_EXCL` for create-only exports. Regression tests assert pending edits and protected file contents survive, while new imports/exports still work. Tool descriptions explain the policy. |
| P1 | `src/headless/engine.ts` threw filesystem errors from its autosave timer, risking process termination with unsaved data. | Timer failures retain the running workspace and expose `saveError` alongside `unsaved`. Explicit save retries and clears the error. A filesystem-failure test checks the old disk file, live pending edit and successful retry. This does not make unsaved memory durable after process termination. |
| P1 | `src/core/entity/persistence.ts` deleted every old object store on an IndexedDB version upgrade. | Unsupported older databases are preserved by aborting the upgrade transaction. The error instructs users to export with the previous version. A test verifies both old data and database version survive. Automatic v1 migration is still unavailable. |
| P2 | Project switching did not swap Unigraph and other section host keys. A project inherited another project's session/filter and appeared empty. | All section hosts participate in project UI state. Unit tests check round trips and parity with the host registry. Browser project smoke reproduced the original failure; the final browser result is recorded below. Existing project/tool/docs contracts are updated together. |
| P2 | Shared browser smoke assertions printed `FAIL` but exited successfully, allowing automation to report a false pass. | Failed assertions now set a nonzero exit status while preserving cleanup. Two child-process tests verify pass/fail semantics. |

## Verification

- `npm run test:ci`: **293 unit files / 1,997 tests**, then **4 bridge files / 39 tests**, passed (2,036 total).
- `npx tsc -b --noEmit`: passed.
- `npm run lint`: passed with **175 existing warnings**; these remain maintenance debt, especially effect dependencies and render-time mutations. A passing lint command is not a warning-free codebase.
- `npx vite build`: passed. Large chunks and two ineffective dynamic imports remain bundling warnings.
- `npm audit --json`: **zero reported vulnerabilities**, 710 dependency entries, queried with the owner's explicit approval. This is a registry snapshot, not a guarantee that dependencies have no undiscovered flaws.
- `npm run smoke:headless`: passed creation, scoped search, relationships, graph analysis/layout, disk persistence, second-process reopen, version restoration and export/import.
- Chrome document smoke (`20-documents`): passed creation, editing, quote annotation and reload preservation; no thrown browser errors reported.
- Chrome project smoke (`10-projects`): all 15 assertions passed with fresh profile and downloads, including the previously failing session restoration and bundle deduplication. One unhandled `AbortError: Cancelled` was logged during GPU-engine teardown; that remains a follow-up, not an error-free-browser claim. One earlier rerun used an old same-name download; another Chrome instance became unresponsive before producing assertions. The final run isolated both profile and downloads.
- Chrome entity smoke (`19-entities`): all 18 assertions passed, including search, inspector editing and reload preservation; no thrown browser errors reported.
- Shared smoke exit-status regression: two new child-process tests passed after the full suite. Failed assertions now fail the command while allowing cleanup.
- Initial network-test failure was `listen EPERM` under the sandbox. The same bridge/public-fetch suites passed with loopback access; the final complete suite also passed with that access.

Source review also covered the bridge origin/token/child-process restrictions, headless path confinement and public-only fetch, SVG sanitization, opaque-origin script frames, import/decompression bounds, persistence retry queues, error boundaries, data commit/push guards, and CI security jobs. Existing tests cover these boundaries; this was not an exhaustive exploit assessment of every reachable path.

## Remaining rollout gates

| Area | Evidence / limitation | Required condition before company rollout |
| --- | --- | --- |
| Confidential data and untrusted content | `SECURITY.md` explicitly documents visual-script frame navigation that can send data, and rich-text remote images loaded on display. `RichReader.tsx` and `RichEditor.tsx` use the standard image extension. The third-party switch is a browser preference, not enforced company policy. | Pilot only with approved data and trusted scripts/documents; enforce outbound network policy. Sensitive/untrusted-content deployment needs stronger containment and network-observed tests before approval. |
| Access and tenancy | `EntityStore.get` is a Library lookup; projects scope presentation, not permissions. Hosted allowlisting protects model/API usage. | Separate managed browser profiles/workspaces per user. Do not promise project-level RBAC, tenant isolation or collaborative editing. Put a private deployment behind the company's access gateway if the site itself must be private. |
| Backup and recovery | Browser IndexedDB, localStorage and stashes share device/origin failure risks. A project export is not a complete browser backup. | Choose a backed-up, access-controlled export/workspace directory. Prove recovery of representative projects, history and important attachments on a second clean profile/device. Record recovery objectives and an owner. Do not rely on browser stashes alone. |
| Scale | Other active sessions report million-entity startup/simulation stalls and are changing graph performance. This audit uses small synthetic browser workflows and does not certify a million-node workload. | Benchmark the actual company dataset and target hardware, including editing, reload, simulation, memory pressure and save/recovery. Agree on acceptable latency and memory ceilings before broad rollout. |
| Hosted cost control | *[Redacted in the public edition: notes on the hosted site's configuration.]* | |
| Operational readiness | Repository CI contains types/tests/build, dependency audit, secret scanning, CodeQL and data guards. Production configuration and the status of remote branch protection/security jobs were not inspected. | Require CI and review on the release branch, restrict preview secrets, nominate patch/incident owners, keep a tested rollback/export procedure and verify identity-provider restrictions. |
| Graph teardown | Project switching logged an unhandled cancellation from the GPU engine’s termination path. Functional assertions passed. | Handle expected cancellation without an unhandled rejection and rerun the project workflow; coordinate with the active graph-performance work. |
| Browser/accessibility coverage | Chrome smoke covers selected workflows only. No comprehensive keyboard/screen-reader, Safari/Firefox, long-running soak or power-loss test was performed. | Declare supported browsers and run targeted accessibility and extended-session acceptance tests for the company workflow. |

## Release procedure

1. Review the fixes and this decision; export existing Libraries before upgrading.
2. Start with a small group, approved data and company-managed access/network/backup settings.
3. Exercise creation, editing, project switching, import/export and recovery with representative data on supported hardware.
4. Expand only after the applicable gates above have owners and passing evidence. Do not interpret unit-test counts as enterprise security or reliability certification.
