# Production-Readiness Audit — Writing Evaluator

**Date:** 2026-06-18
**Scope:** Full-stack review across 8 subsystems — auth/authorization, scoring & IRR, batch/release lifecycle, API consistency, database schema, security, code cleanup/refactor, and frontend.
**Raw findings reviewed:** 77 (deduplicated to 58 distinct issues below).
**Method:** Subsystem audits were merged; cross-dimension duplicates were collapsed into single canonical entries, and one documented contradiction (`scorerUserId` "legacy" vs. live) was reconciled against the code.

---

## 1. Executive Summary

Writing Evaluator is in good architectural shape — proper Next.js server/client separation, per-request project-scoped authorization (`canAdminProject`), a CSPRNG-backed blinding shuffle, and CSV formula-injection protection are all in place. The defects that matter cluster in three areas, and they are **operational and data-integrity risks, not architecture rewrites**.

First, **the scoring lifecycle has dead-end states**. A double-scored or training release where annotators *agree on everything* (a common, desirable outcome) never transitions out of `RECONCILING` because the only callers of `maybeCompleteReleaseReconciliation` are the reconcile/adjudicate routes, which never fire when there are zero discrepancies. There is no admin escape hatch. The same dead-end is reachable when a team has a member count other than 2. These bugs silently strand batches and block the entire workflow from reaching `COMPLETE`.

Second, **multi-tenant isolation has gaps**. Project-scoped admin routes (teams, batch-assign, release scorer/adjudicator) correctly check that the *caller* can admin the project, but then accept user and rubric-dimension IDs from the request body without verifying those IDs belong to the same project. A project admin for one collaborator can attach foreign users/dimensions into their project's teams and queue work to them. For a tool whose core promise to external collaborators (Quill/CZI) is project isolation, this needs closing before they get project-admin rights.

Third, **the auth/abuse surface is thin for an externally-facing tool**. There is no rate limiting anywhere (login, password reset, invite-accept are all brute-forceable / email-bombable), no token revocation (a password reset does not log out an already-compromised session for up to 8 hours, and a disabled/deleted account keeps working until token expiry), and no audit trail for the CSV *unblinding* export — the single most sensitive action in a blinded research tool.

Supporting these are several **missing database indexes** on the hottest analytics paths (`Score.userId`, `Score.dimensionId`, `FeedbackItem.batchId`) that already produce full sequential scans of ~17.7k rows and will degrade sharply at production corpus size, a cluster of **non-transactional multi-write paths** (batch creation above all) that can orphan state on partial failure, and a confirmed **dead-code / "legacy" contradiction**: the `scorerUserId` single-scorer model is documented as retired but is still live across UI, two API routes, and five branches in `team-batch-releases.ts` — and the two interpretations have already diverged into a real per-annotator miscount.

None of this blocks a *careful internal* run, but the items in Section 2 should be fixed before external collaborators are given project-admin/export access and before the production-scale Quill corpus is loaded.

### Findings by severity

| Severity | Count |
|----------|------:|
| High | 13 |
| Medium | 23 |
| Low | 18 |
| Nit | 4 |
| **Total (deduplicated)** | **58** |

*(77 raw findings → 58 distinct; 19 were cross-dimension duplicates of the same root cause — see Section 5.)*

---

## 2. Fix Before Production — Prioritized Shortlist

These are the critical/high items, deduplicated and ordered by risk × ease. The first three are trivial-to-small fixes for high-severity bugs and should go first.

| # | Issue | Severity | Effort | Why it's a blocker |
|---|-------|----------|--------|--------------------|
| **P1** | **Agreed-on-everything release stuck in RECONCILING forever** (`reconciliation.ts:168-193`) | High | Trivial | Blocks the entire workflow from reaching COMPLETE; no admin escape hatch. One-line fix: call `maybeCompleteReleaseReconciliation` after `autoReconcileAgreedScoresForRelease`. |
| **P2** | **Team size ≠ 2 silently bricks a double/training release** (`teams/route.ts:75-80`, `reconciliation.ts:92,205`) | High | Small | A 1- or 3-member team passes the fully-scored check, flips to RECONCILING, then auto-reconcile and completion both no-op forever. Enforce exactly-2 at team create/edit. |
| **P3** | **Cross-project IDOR on team members / dimensions / scorer / adjudicator** (`teams` POST/PATCH, `batches/.../assign`, `releases/[releaseId]` PATCH) | High | Medium | Breaks the core multi-tenant boundary. Validate every inbound user/dimension ID belongs to the project via `ProjectEvaluator` / `RubricDimension`. |
| **P4** | **No rate limiting anywhere** (login, `reset-password`, `invite/accept`, `reset-password/accept`, StudyFlow magic-link auto-create) | High | Medium | Online password brute-force (8-char min, no breach check), email-bombing, and unthrottled account auto-creation. Add `@upstash/ratelimit`, fail-open when Redis unset. |
| **P5** | **No audit trail for the unblinding CSV export** (`export/route.ts:248`) | High | Medium | External project-admins can unblind AI/HUMAN with zero record of who/when/what filters. Add an `AuditLog` row per export (+ role changes, invites, account disable). |
| **P6** | **No token/session revocation** (`auth.ts:143-165`; no `tokenVersion`/`isActive` on `User`) | High | Medium | Password reset does *not* invalidate a compromised session (≤8h); disabling/deleting a user does not cut off their JWT. Add `tokenVersion` + per-request check; bump on reset/role-change/disable. |
| **P7** | **`scorerUserId` "legacy" path is still live and already buggy** (`batch-creator.tsx:705`, both `releases` routes, `team-batch-releases.ts:30-67`, `evaluator-stats.ts:90`) | High | Medium | Docs say retired; code still reads/writes it. `evaluator-stats.ts:90` hardcodes `scorerUserId: null`, so a genuine single-scorer release is miscounted as a slot split → wrong per-annotator counts. Decide one model; remove or fix. |
| **P8** | **Batch creation does many dependent writes outside a transaction** (`batches/route.ts` TRAINING / range / `handleAutoMode` paths) | High | Medium | The most-hit multi-write path; partial failure orphans a half-wired batch (items batched, releases partial, no assignments) with no auto-repair. Wrap core writes in `$transaction`. |
| **P9** | **Orphaned legacy `/assign` route bypasses the team-release model** (`batches/[batchId]/assign/route.ts:42-78`) | High | Trivial | Creates `teamReleaseId=null` assignments (read as legacy "whole batch, no scoping") and flips batch status directly — the exact mutation batch PATCH forbids. Still routable for any project admin. Delete it. |
| **P10** | **Missing indexes on hot Score / FeedbackItem paths** (`schema.prisma` Score, FeedbackItem) | High | Small | Confirmed Seq Scans of ~17.7k Score rows on every IRR/reconciliation/scores-GET; FeedbackItem Seq Scan on every evaluate-page load. Add `@@index([userId])`, `@@index([dimensionId])` on Score; `@@index([batchId])` + `@@index([projectId,batchId,displayOrder])` on FeedbackItem. |
| **P11** | **Team membership/dimension changes don't re-sync existing batches** (`teams/[teamId]` PATCH, `evaluators/[userId]/team` PUT, `teams` POST) | High | Medium | Re-membering a team after batching leaves `BatchAssignment` pointing at the old members; new members can't score, removed ones still can, and slot→user mapping can flip. Only a batch-type toggle heals it, and no UI does that. |
| **P12** | **Discrepancy/reconciled counting duplicated in `batches/route.ts` with a real bug** (`batches/route.ts:174-203` vs `reconciliation.ts:288`) | High | Small | The inline admin-list copy omits the `userId !== userId` check the shared helper has, so TRAINING batches (3+ raters) mis-count discrepancies; admin summary disagrees with the reconcile UI. Delete the inline block; call the shared helper per release. |
| **P13** | **"Review Scores" button on the completion screen is dead** (`evaluate-client.tsx:332,597,616`) | High | Small | `allComplete` short-circuits before the scoring UI renders, so the button does nothing; annotators can never review finished work. Add a `reviewing` flag to gate the early return. |

> **Fast wins first:** P1, P9, P13 are trivial/small fixes for high-severity bugs — knock those out same-day. P3/P11 share a root cause (project-membership validation of inbound IDs); doing P3's helper first makes P11 cheaper. P4 and P5/P6 are the externally-facing security must-haves before collaborators get elevated rights.

---

## 3. All Findings — Grouped by Severity, then Dimension

### 3.1 HIGH

#### Auth / Authorization

**H-A1. Password reset / role change / account disable does not invalidate existing JWT sessions (no token revocation).**
*Files:* `src/lib/auth.ts:143-156`, `src/app/api/reset-password/accept/route.ts:24-31`, `prisma/schema.prisma:14-33`
*Problem:* Pure JWT strategy, 8h `maxAge`, no server-side session store and no `tokenVersion`/`isActive` on `User`. After a password reset (the canonical "account is compromised" case) an attacker holding a valid cookie keeps full access for up to 8h. Disabling/deleting a user or demoting a global ADMIN does not revoke the outstanding JWT. (Project-scoped role changes *do* take effect immediately because `canAdminProject` hits the DB per request; only the global-`role` and identity claims are stale.)
*Recommendation:* Add `tokenVersion Int @default(0)` (and optionally `isActive Boolean @default(true)`) to `User`. Embed `tokenVersion` in the `jwt` callback; compare against the DB in the `session`/`authorized` callback; bump on password-reset accept, admin password change, role change, and disable/delete. Minimally, bump-on-reset closes the highest-risk path.
*Effort:* Medium. *(Canonical entry; the `security` dimension reported the same issue — see §5.)*

**H-A2. Cross-project IDOR: team member/dimension and release scorer/adjudicator accept arbitrary IDs from other projects.**
*Files:* `src/app/api/projects/[projectId]/teams/route.ts:100-145`, `.../teams/[teamId]/route.ts:78-125`, `.../batches/[batchId]/assign/route.ts:42-72`, `.../releases/[releaseId]/route.ts:135-146`
*Problem:* Routes are correctly gated by `canAdminProject(projectId)` but then trust `memberUserIds`, `dimensionIds`, `userIds`, `scorerUserId`, `adjudicatorId` from the body without checking they belong to this project. A project-A admin can put project-B users/dimensions into project-A teams/releases/assignments — granting a foreign user an adjudication/scoring role and queuing work to them, and polluting the team-dimension graph (corrupting IRR/reconciliation grouping). Downstream queries filter scores by `feedbackItem.projectId`, so this does not directly leak project-B *scored data*, but it violates project isolation.
*Recommendation:* Add `assertProjectMembers(projectId, userIds)` (require a `ProjectEvaluator` row each) and `assertProjectDimensions(projectId, dimIds)` (require `rubricDimension.findMany({where:{id:{in},projectId}})` count to match) and call them in teams POST/PATCH, assign POST, and releases PATCH. Reject 400/403 on mismatch.
*Effort:* Medium.

#### Scoring / IRR

**H-S1. Double-scored / training release with zero discrepancies gets permanently stuck in RECONCILING.**
*Files:* `src/lib/reconciliation.ts:168-193`, `src/app/reconcile/[projectId]/reconcile-client.tsx:416-429`, `src/lib/team-batch-releases.ts:152-188`
*Problem:* `maybeAdvanceReleaseAfterScore` flips SCORING→RECONCILING and runs `autoReconcileAgreedScoresForRelease`, but never calls `maybeCompleteReleaseReconciliation`. That function's only callers are the reconcile/adjudicate POST routes, which only fire when a discrepancy is resolved. When a pair agrees on every (item, dimension) — zero discrepancies — the reconcile UI shows "No Discrepancies Found", the reconcile POST never fires, and the release stays RECONCILING forever. `syncBatchStatus` then pins the whole batch in RECONCILING; scores never lock; **there is no admin escape hatch** (batch PATCH does not accept `status`). *Confirmed in code at `reconciliation.ts:178-193`.*
*Recommendation:* In `maybeAdvanceReleaseAfterScore`, after `autoReconcileAgreedScoresForRelease(releaseId)` in the RECONCILING branch, `await maybeCompleteReleaseReconciliation(releaseId)`. It is safe/idempotent. Add a regression test for full-agreement.
*Effort:* Trivial.

#### Lifecycle

**H-L1. Double-scored / training release whose team is not exactly 2 members gets permanently stuck in RECONCILING.**
*Files:* `src/lib/reconciliation.ts:92,205,168-193`, `src/app/api/projects/[projectId]/teams/route.ts:75-80`, `src/lib/irr.ts:91,156`
*Problem:* Team creation requires only ≥1 member and never enforces exactly 2; PATCH allows any non-empty list. But `autoReconcileAgreedScoresForRelease` early-returns when `userIds.length !== 2`, and `maybeCompleteReleaseReconciliation` returns false when `!== 2`. `maybeAdvanceReleaseAfterScore` only checks "fully scored" (expected = 2 for any ≥2-member team), so a 3-member team flips to RECONCILING then dead-ends; the discrepancy grouping (`group.length !== 2`) skips every triple, and IRR reports N/A. A misconfigured team size silently bricks the batch with no surfaced error.
*Recommendation:* Enforce exactly-2 members in teams POST and PATCH for any double-scoring project (the pairing model assumes it). Alternatively guard `maybeAdvanceReleaseAfterScore` to refuse advancing a non-2 team and surface an admin-visible error state.
*Effort:* Small. *(Closely related to the auth-dimension "team-size invariant" low finding — see §5.)*

**H-L2. Orphaned legacy `/assign` route bypasses the team-release model and mutates batch status directly.**
*Files:* `src/app/api/projects/[projectId]/batches/[batchId]/assign/route.ts:42-78`
*Problem:* Creates `BatchAssignment` rows with `teamReleaseId=null` and flips batch DRAFT→SCORING directly — the exact mutation batch PATCH explicitly forbids. `teamReleaseId=null` is read elsewhere as the legacy "whole batch, no release" case, so an annotator assigned this way bypasses team scoping, slot splitting, `isVisible` gating, and reconciliation. `syncBatchStatus` will then fight the status (reverting to DRAFT on next release sync). No UI/test/script calls it, but it is routable and authorized for any project admin.
*Recommendation:* Delete this route (and its DELETE handler). If a manual-assign escape hatch is ever needed it must create the assignment with a `teamReleaseId` and go through `syncBatchStatus`.
*Effort:* Trivial.

**H-L3. Team membership/dimension changes don't re-sync existing batch releases or assignments (silent desync).**
*Files:* `src/app/api/projects/[projectId]/teams/[teamId]/route.ts:127-170`, `.../evaluators/[userId]/team/route.ts:104-114`, `.../teams/route.ts:147-172`, `src/lib/team-batch-releases.ts:246-313`
*Problem:* `BatchAssignment` rows and the slot→user mapping are derived from team members at release-sync time, but none of the three team-mutation endpoints re-run `syncBatchAssignmentsForRelease`/`ensureTeamReleasesForBatch`. Re-membering a team (allowed when no scores yet) leaves every release's `BatchAssignment` pointing at the old members: new members can't score, removed members still can, and for slot-split releases the email-asc ordering can flip so a given `slotIndex` now maps to a different person. A team created after batching is invisible on existing batches. Only the batch-type PATCH heals it, and no UI triggers that.
*Recommendation:* Add `syncTeamAcrossBatches(teamId)` that, for every batch in the project, calls `ensureTeamReleasesForBatch` then `syncBatchAssignmentsForRelease` (and re-runs `assignBatchSlots` for non-double regular batches if ordering can change). Call it from all three mutation sites.
*Effort:* Medium.

#### API Consistency

**H-API1. Batch creation performs multiple dependent writes with no transaction — partial failure orphans the batch and half-migrates items.**
*Files:* `src/app/api/projects/[projectId]/batches/route.ts:389-435` (TRAINING), `:589-659` (range), `:709-774` (`handleAutoMode`)
*Problem:* All three creation paths run `batch.create → feedbackItem.updateMany (set batchId) → N× teamBatchRelease.create → N× syncBatchAssignmentsForRelease → assignBatchSlots → randomizeDisplayOrder` outside any transaction. A failure after `batch.create` leaves a half-wired batch (items batched, releases partial, no assignments, status DRAFT) with no rollback and no idempotent repair. This is the single most consequential and most-exercised multi-write path in the app.
*Recommendation:* Wrap `batch.create` + `feedbackItem.updateMany` + `teamBatchRelease.create` in `prisma.$transaction`. Either pass a `tx` client into the sync helpers or run them after commit but make them idempotent/retryable. At minimum the batch + item-migration + release rows must be atomic. (`scores` POST and `teams` PATCH already model the correct pattern.)
*Effort:* Medium. *(Canonical entry; the lifecycle dimension reported the same path twice — see §5.)*

#### Schema

**H-SC1. No index on `Score.userId` or `Score.dimensionId` — full Seq Scan of ~17.7k rows on every IRR/reconciliation pass and on every User/Dimension delete.**
*Files:* `prisma/schema.prisma:330-349`, `src/lib/irr.ts:132`, `src/lib/reconciliation.ts:71-101`, `src/lib/batch-progress.ts:90`, `src/app/api/scores/route.ts:33`, `src/app/api/export/route.ts:63`
*Problem:* `Score` has only the PK and the composite unique `[feedbackItemId, userId, dimensionId, isReconciled]`. That index is left-prefixed by `feedbackItemId`, so it cannot serve a filter on `userId` or `dimensionId` alone. EXPLAIN confirms `Seq Scan on Score` for both filters — the core of IRR, reconciliation discrepancy detection, batch-progress, and the scores GET (full scan of all 17,655 rows). `RubricDimension`/`User` delete cascades also scan the whole table. ~5ms today; far worse at production corpus size with IRR/reconciliation running repeatedly per batch.
*Recommendation:* Add `@@index([userId])`, `@@index([dimensionId])`, and `@@index([feedbackItemId, dimensionId, isReconciled])` to `Score`. Run `npx prisma generate && npx prisma db push` (additive). Re-run EXPLAIN to confirm Index Scan.
*Effort:* Small.

**H-SC2. No index on `FeedbackItem.batchId` — every evaluate-page load and every Batch delete Seq-scans all feedback items.**
*Files:* `prisma/schema.prisma:114-143`, `src/app/api/feedback-items/route.ts:150-188`, `src/app/api/projects/[projectId]/batches/route.ts:175-225`
*Problem:* `FeedbackItem` has only the PK and unique `[projectId, feedbackId]`. The most frequent annotator query (items in a batch, filtered `projectId+batchId` ordered by `displayOrder`) shows `Seq Scan ... Rows Removed by Filter: 4615` to return 50 rows. Bare `batchId` lookups and the `onDelete: SetNull` cascade also Seq-scan. On the critical scoring path external collaborators hit constantly; scales linearly with total project items.
*Recommendation:* Add `@@index([batchId])` and `@@index([projectId, batchId, displayOrder])` to `FeedbackItem`. Apply via `prisma db push`.
*Effort:* Small.

#### Cleanup / Refactor

**H-CR1. Single-scorer (`scorerUserId`) code path is still live across UI + API despite CLAUDE.md declaring it legacy/unused — and the two interpretations have already diverged into a bug.**
*Files:* `src/components/batch-creator.tsx:705`, `src/app/api/projects/[projectId]/batches/[batchId]/releases/route.ts:76`, `.../releases/[releaseId]/route.ts:108`, `src/lib/team-batch-releases.ts:30`, `src/lib/evaluator-stats.ts:90`
*Problem:* CLAUDE.md says `scorerUserId` is legacy and "unused by the UI." The code contradicts this: `batch-creator.tsx` renders a scorer `<select>` that writes it via PATCH; both `releases` routes accept/validate/persist it; `team-batch-releases.ts` branches on it in `usesSingleScorer`/`getExpectedReleaseUserIds`/`getReleaseItemScope`/`isSlotSplitRelease`. The interpretations have diverged: `evaluator-stats.ts:90` hardcodes `scorerUserId: null`, so a genuine single-scorer release is counted as a slot split → **silently wrong per-annotator item/scored counts** on the dashboard. *Confirmed at `evaluator-stats.ts:90`.*
*Recommendation:* Pick one and make code + docs agree. If retired: remove the `<select>`, stop accepting `scorerUserId` in both routes, collapse the `team-batch-releases.ts` branches, and drop the column + `TeamBatchReleaseScorer` relation from the schema (destructive — confirm no production release depends on it). If supported: fix CLAUDE.md and fix `evaluator-stats.ts:90` to pass the real `scorerUserId`. Given new batches always slot-split, removal is the likely path.
*Effort:* Medium. *(Canonical entry consolidating the schema "legacy field still wired" and two lifecycle "scorerUserId" findings — see §5.)*

**H-CR2. Discrepancy/reconciled counting duplicated in `batches/route.ts` — and the duplicate has a latent correctness bug.**
*Files:* `src/app/api/projects/[projectId]/batches/route.ts:174-203`, `src/lib/reconciliation.ts:288-356`
*Problem:* `computeReleaseDiscrepancyStats` is the documented single home for the discrepancy math (used by the evaluator dashboard and project page). `batches/route.ts` reimplements the grouping + discrepant-key + reconciled-filter logic inline for the admin batch list, and it has drifted: the inline version flags a discrepancy on `values.length === 2 && values[0] !== values[1]` but never checks the two scores came from *different users*, whereas the helper additionally requires `values[0].userId !== values[1].userId`. In TRAINING batches (3+ scorers) or when one user has two non-reconciled rows, the inline count mis-counts; it also aggregates across the whole batch rather than per release, so the admin number disagrees with the reconcile UI.
*Recommendation:* Delete the inline block and call `computeReleaseDiscrepancyStats` per `teamRelease` (sum for the batch number). Removes ~30 lines and the divergence.
*Effort:* Small. *(Overlaps the scoring-IRR "batch-level discrepancy under-counts for multi-team TRAINING" medium finding, which is the same bug observed from the IRR side — see §5.)*

#### Security

**H-SEC1. No rate limiting on any endpoint — login, password reset, and invite are brute-forceable / abusable.**
*Files:* `src/app/api/reset-password/route.ts`, `src/app/api/invite/route.ts`, `src/app/api/reset-password/accept/route.ts`, `src/app/api/invite/accept/route.ts`, `src/lib/auth.ts:36-116`, `package.json`
*Problem:* No rate limiting anywhere (no `@upstash/ratelimit`, no limiter in `package.json`, no throttling in any route/middleware). Consequences: (1) `authorize()` runs `bcrypt.compare` on every attempt with no lockout — 8-char-min passwords (no breach/common check) are online-brute-forceable; (2) `POST /api/reset-password` sends a Resend email per request with no throttle → email-bombing + Resend quota/reputation burn; (3) `/invite/accept` + `/reset-password/accept` allow unthrottled token-guessing; (4) the StudyFlow magic-link path auto-creates a `User` on every token-bearing request. Flagged in the April ASVS doc (V2.4, V6.3.1) and confirmed deferred in `AUDIT-FOLLOWUP-2026-05-06.md`.
*Recommendation:* Add `@upstash/ratelimit` + `@upstash/redis` with a wrapper that fails open when `UPSTASH_REDIS_REST_URL` is unset (ships before infra). Apply IP+identifier limits to login (~10/min/IP and per-email), `reset-password` (~3/hour/email), `invite`, and both `/accept` endpoints. In-memory limiters are theater on Vercel serverless. Pair with a common-password/HIBP check on password set.
*Effort:* Medium. *(Canonical entry; auth-authz and api-consistency dimensions reported the same gap — see §5.)*

**H-SEC2. No audit trail for the unblinding CSV export (or any admin/auth action).**
*Files:* `src/app/api/export/route.ts:248`, `prisma/schema.prisma`, `src/lib/email.ts`
*Problem:* The export route reveals `feedbackSource` (AI/HUMAN) — the explicit unblinding step — and any global *or project* admin can trigger it (external collaborators are project admins). There is zero record of who unblinded what, when, with which filters. No `AuditLog` model, no logging library, only scattered `console.error`. The same absence means 403s, logins, role changes, and account disables are entirely unobservable.
*Recommendation:* Add an `AuditLog` model (`actorUserId, action, targetType, targetId, metadata JSON, createdAt, ip`) and write a row on every export/unblinding (projectId + filter params + row count), plus role changes, invites, and account disable/delete. Separately add structured logging (pino) for auth success/failure, authz denials, exports. Audit logging for unblinding is the must-have before external export of real data.
*Effort:* Medium.

#### Frontend

**H-FE1. "Review Scores" button on the scoring completion screen is dead — annotators cannot review their answers.**
*Files:* `src/app/evaluate/[projectId]/evaluate-client.tsx:332,597,616`
*Problem:* `allComplete` is derived purely from `scoredCount === totalCount` (line 332). When true, the component early-`return`s the completion screen (line 597) before the main UI renders. The "Review Scores" button (line 616) calls `setCurrentIndex(0)`, but `allComplete` is unaffected by `currentIndex`, so the early return still fires and nothing changes. The documented "Review Scores" workflow step is broken; the only escape is Back-to-Dashboard.
*Recommendation:* Add a `reviewing` boolean. The button sets `reviewing(true)` (+ `currentIndex(0)`); gate the completion screen on `if (allComplete && !reviewing)` so the main UI renders in review mode. Optionally show an "All items scored — reviewing" banner with a "Done" action.
*Effort:* Small.

---

### 3.2 MEDIUM

#### Auth / Authorization

**M-A1. Invite endpoint assigns users to any `projectId` without verifying it exists or that an admin owns it.**
*Files:* `src/app/api/invite/route.ts:7-55`
*Problem:* `POST /api/invite` is correctly global-ADMIN-only (not a privilege-escalation path), but accepts an arbitrary `projectId` and does an unconditional `projectEvaluator.upsert` with no existence check — a bad `projectId` throws a raw Prisma FK error surfacing as an unhandled 500. Structurally there is no invite path for a PROJECT_ADMIN at all (functional gap).
*Recommendation:* Validate `projectId` exists (400 otherwise); wrap body-parse + writes so bad input returns a clean 4xx. Decide whether project admins should invite into their own project; if so add a project-scoped path authorized by `canAdminProject` forcing role EVALUATOR.
*Effort:* Small.

**M-A2. Reconcile/escalate/discrepancy routes authorize by batch assignment but not by team ownership of the targeted release.**
*Files:* `src/app/api/projects/[projectId]/batches/[batchId]/reconcile/route.ts:37-49`, `.../escalate/route.ts:39-48`, `.../discrepancies/route.ts:27-39`
*Problem:* For non-admins these check the user has a `BatchAssignment` for the `releaseId` — sound for the normal 2-person model. Residual risk is narrow but real if a team ever has >2 members (team size is uncapped): every member could read every peer's raw scores/notes and reconcile on their behalf, and only `members[0]` is recorded as the reconciler (`getReleaseOwnerUserId`). There is no server-side guarantee a release/team is exactly two people.
*Recommendation:* Enforce the 2-person invariant server-side (ties into H-L1), or scope discrepancy/reconcile authorization to the specific pair. Consider recording the acting user for reconciliation (adjudication already records `resolvedById`).
*Effort:* Medium.

**M-A3. No rate limiting on login, password-reset, and invite-accept endpoints.**
*Files:* `src/lib/auth.ts:105-115`, `src/app/api/reset-password/route.ts:6-24`, `src/app/api/invite/accept/route.ts:6-31`, `src/app/api/reset-password/accept/route.ts:6-31`
*Problem:* Same surface as H-SEC1, viewed from the auth dimension: token brute-forcing is infeasible (32-byte hex), but the password login is fully unthrottled, enabling credential stuffing against known external-collaborator emails; 8-char-min policy with no common/breach check compounds it.
*Recommendation:* See H-SEC1 (consolidated). *(Duplicate of H-SEC1 — kept for the auth-specific framing; one fix resolves both.)*
*Effort:* Medium.

#### Scoring / IRR

**M-S1. Batch-level discrepancy count under-counts for multi-team TRAINING batches (and any item×dimension scored by >2 raters).**
*Files:* `src/app/api/projects/[projectId]/batches/route.ts:174-202`
*Problem:* The admin batch-list counter queries all non-reconciled scores in the batch with no userId/team-dimension scoping, groups by (item, dimension), and counts a discrepancy only when `values.length === 2 && values[0] !== values[1]`. Works for double-scored REGULAR (dimensions are mutually exclusive across teams) but the block also runs for TRAINING, where every member of every team scores every dimension: with ≥2 teams an item×dimension accrues 2×(#teams) scores, so `values.length !== 2` and the discrepancy is silently dropped. Also lacks the `userId` distinctness check the authoritative paths use.
*Recommendation:* Sum per-release `computeReleaseDiscrepancyStats` instead of one un-scoped batch query (this *is* H-CR2's fix), or scope per release with the userId check.
*Effort:* Small. *(Same root cause as H-CR2 — see §5.)*

**M-S2. Escalate-vs-complete race can strand an open escalation on a COMPLETED release.**
*Files:* `src/app/api/projects/[projectId]/batches/[batchId]/escalate/route.ts:50-127`, `src/lib/reconciliation.ts:195-277`, `src/app/api/adjudicate/route.ts:246-251`
*Problem:* Escalate reads `release.status !== 'RECONCILING'` then later inserts the Escalation, with no transaction binding the check to the insert. Concurrently, resolving the last discrepancy flips the release to COMPLETE. If the escalate read preceded the COMPLETE commit, the escalation is created against a now-COMPLETE release; adjudicate refuses it (`status !== 'RECONCILING'` → 400) and the `/adjudicate` queue (filters `resolvedAt: null`) shows it forever, unclearable except by manual DB edit or withdraw.
*Recommendation:* Make the escalate insert conditional on current status atomically (guarded `updateMany`/transaction; have `maybeCompleteReleaseReconciliation` re-count open escalations inside the same transaction as the flip). Or have adjudicate auto-dismiss escalations whose release is COMPLETE so the queue self-heals.
*Effort:* Medium.

#### Lifecycle

**M-L1. Orphaned "create single team release" POST route enforces the abandoned required-scorer model.**
*Files:* `src/app/api/projects/[projectId]/batches/[batchId]/releases/route.ts:75-113`
*Problem:* This POST *requires* `scorerUserId` for non-double-scored regular batches and creates a single-named-scorer release, contradicting the live creation flow (leaves it null, splits via `slotIndex`). It doesn't run `assignBatchSlots`, so a release created here diverges from every other release on the batch. No UI calls it; dead but routable.
*Recommendation:* Delete it (redundant with `ensureTeamReleasesForBatch`), or bring it in line (create with `scorerUserId=null`, rely on the slot split).
*Effort:* Trivial. *(Part of the H-CR1 scorerUserId cleanup.)*

**M-L2. Legacy `TeamBatchRelease.scorerUserId` is still actively settable via release PATCH, keeping a divergent single-scorer code path alive.**
*Files:* `src/app/api/projects/[projectId]/batches/[batchId]/releases/[releaseId]/route.ts:105-130,160-164`, `src/lib/team-batch-releases.ts:30-49,61-74`
*Problem:* The release PATCH accepts and writes `scorerUserId` for non-double regular batches. Setting it flips the release from slot-split to single-scorer, abandoning the `slotIndex` values assigned at creation and giving one annotator the whole batch — a live, reachable way to put one batch into a state the rest of the system treats as legacy. Compounds H-A1/revocation only indirectly; primarily a data-model footgun.
*Recommendation:* If single-scorer is retired, reject/ignore `scorerUserId` in the PATCH and treat it read-only legacy. If kept, document it and have setting it call `clearBatchSlots(batchId)` so the two models can't coexist.
*Effort:* Small. *(Part of the H-CR1 scorerUserId cleanup.)*

**M-L3. Batch-level republish forces unassigned/empty-team releases to SCORING, desyncing batch status from real assignability.**
*Files:* `src/app/api/projects/[projectId]/batches/[batchId]/release/route.ts:56-71`, `src/lib/team-batch-releases.ts:152-188`, `.../releases/route.ts:99`
*Problem:* Republish sets `isVisible=true` and DRAFT→SCORING on *every* release with no check that it has any `BatchAssignment` or that its team has members. `ensureTeamReleasesForBatch` creates a release per project team (including empty teams); an empty team yields zero assignments. After republish that release is SCORING+visible with nobody assigned; `syncBatchStatus` then derives the batch SCORING + `isAssigned=true`, and the empty release contributes 0 progress but blocks the batch from ever being all-COMPLETE. Same in the single-release POST/PATCH.
*Recommendation:* Only transition releases that have ≥1 `BatchAssignment` (or whose team has the expected members); keep empty releases DRAFT and warn. Alternatively have `syncBatchStatus` ignore zero-assignment releases when computing COMPLETE.
*Effort:* Small.

**M-L4. `assignBatchSlots` is only idempotent when ALL items have a slot; adding items to an existing non-double batch re-shuffles every slot.**
*Files:* `src/lib/batch-slots.ts:13-45`, `src/app/api/projects/[projectId]/batches/[batchId]/route.ts:113-121`
*Problem:* `assignBatchSlots` early-returns only if every item already has a `slotIndex`; otherwise it re-shuffles and re-splits the entire batch, reassigning slots to already-slotted items. The only re-shuffle caller (batch PATCH) is guarded by `scoreCount===0` so nothing is invalidated today, but any future path that introduces a null-slot item into a sliced batch (re-import, manual add, a slot left null by a prior failure) silently re-randomizes all slots — and post-scoring that re-routes items between annotators and orphans scores against the wrong slot.
*Recommendation:* Make `assignBatchSlots` only assign slots to items currently missing one (top up the smaller slot to keep ~50/50), leaving slotted items untouched. Add an assertion it never runs on a batch with existing non-reconciled scores.
*Effort:* Small. *(Reported as both a scoring-IRR low and a lifecycle medium — canonicalized here — see §5.)*

#### API Consistency

**M-API1. 26 routes call `request.json()` without try/catch — malformed/empty bodies produce unhandled 500 instead of 400.**
*Files:* `src/app/api/scores/route.ts:59`, `projects/route.ts:39`, `projects/[projectId]/route.ts:66`, `.../batches/route.ts:354`, `.../reconcile/route.ts:23`, `adjudicate/route.ts:192`, `invite/route.ts:13`, `users/route.ts:39`, `.../teams/route.ts:61` (and 17 more)
*Problem:* 26 unguarded `request.json()` sites; empty/non-JSON bodies throw before validation runs, yielding generic 500s with no `{error}` shape. Inconsistent: `activity/end`, `activity/heartbeat`, `evaluators/[userId]/team` *do* guard with `.catch(() => ({}))`.
*Recommendation:* Add `readJson<T>(req): Promise<T|null>` returning null on parse failure; every mutating route returns 400 `{error:'Invalid JSON body'}` on null. Pair with a Zod schema per route for consistent body validation.
*Effort:* Medium.

**M-API2. Escalate route catches duplicate via `err.message.includes('Unique constraint')` — fragile string match misses Prisma P2002, returning 500 instead of 409.**
*Files:* `src/app/api/projects/[projectId]/batches/[batchId]/escalate/route.ts:129-138`
*Problem:* Relies on the human-readable message text (not a stable API, varies by adapter — this uses `@prisma/adapter-neon`) to detect a re-escalation. If the phrase isn't present the intended 409 becomes a 500. `scores/route.ts:329` already does it correctly via `code === 'P2002'`.
*Recommendation:* Match on `(err as {code?:string}).code === 'P2002'`. Better, pre-check with `findUnique` on the composite key. Add a shared `isUniqueViolation(err)` helper and use it everywhere duplicates are expected (escalate, batch assign, project evaluators).
*Effort:* Trivial.

**M-API3. Reconcile route runs an N+1 query: `score.findMany` inside a nested per-item, per-dimension loop.**
*Files:* `src/app/api/projects/[projectId]/batches/[batchId]/reconcile/route.ts:173-215`
*Problem:* The write loop issues a separate `findMany` (originals for `reconciledFrom`) then an `upsert` per (item, dimension). A 100-item × 4-dimension reconciliation = ~400 sequential `findMany` + ~400 `upsert` against Neon, none in a transaction (partial failure leaves a half-reconciled release). The adjudicate POST has the same shape with smaller N.
*Recommendation:* Hoist one `findMany` over all (itemId, dimId) pairs into a Map keyed `${itemId}::${dimId}`, then loop in memory and batch the upserts in a single `$transaction`.
*Effort:* Medium.

**M-API4. Batches GET fans out per-release score counts and per-batch IRR/discrepancy queries — heavy N+1 on the most-loaded admin endpoint.**
*Files:* `src/app/api/projects/[projectId]/batches/route.ts:104-336`
*Problem:* Per batch it runs `computeBatchIRRSummary`, up to two `score.findMany` scans for RECONCILING counts, a `score.count` per release, and a final `score.count` per batch. Dozens-to-hundreds of aggregations per page load, called on every Batches-tab open and every `router.refresh`. Becomes the slowest endpoint as score volume grows.
*Recommendation:* Replace per-release/per-batch counts with a couple of grouped `groupBy` aggregates computed once, derived in memory. Gate IRR behind an explicit query param / lazy compute so the default load is cheap. Perf-only; behavior unchanged. *(This refactor also subsumes H-CR2/M-S1.)*
*Effort:* Large.

#### Schema

**M-SC1. No index on `Assignment.feedbackItemId` (or `Assignment.projectId`) — deleting one FeedbackItem Seq-scans all 16.6k Assignment rows.**
*Files:* `prisma/schema.prisma:168-181`
*Problem:* Unique `[evaluatorId, feedbackItemId]` is left-prefixed by `evaluatorId`, so a `feedbackItemId` filter can't use it; EXPLAIN confirms Seq Scan. `FeedbackItem onDelete: Cascade` triggers a full scan of 16,623 rows per deleted item (re-import/wipe flows). `projectId` FK is likewise unindexed.
*Recommendation:* Add `@@index([feedbackItemId])` and `@@index([projectId])` to `Assignment`. *(Note: the cleanup audit recommends removing the entire `Assignment` model — see M-CR3 — which would moot this. Decide M-CR3 first; index only if the model stays.)*
*Effort:* Trivial.

**M-SC2. `BatchAssignment.teamReleaseId` uses `onDelete: SetNull`, but a null `teamReleaseId` means "no team release" to the scope logic — a release deletion would silently orphan assignments into a wrong-but-valid state.**
*Files:* `prisma/schema.prisma:233-246`, `src/lib/team-batch-releases.ts:67`, `src/app/page.tsx:51`, `src/app/api/feedback-items/route.ts:47`, `.../releases/[releaseId]/route.ts:208-213`
*Problem:* Every `BatchAssignment` is created with a non-null `teamReleaseId`, and the access-scope logic treats `teamReleaseId === null` as the distinct meaning "training/no-release, member sees everything." With `SetNull`, deleting a release without first removing its assignments would leave them with `teamReleaseId=null` and be reinterpreted as visible training assignments — a correctness bug. Today the delete paths defensively `deleteMany` assignments first (0 orphans live), but the schema encodes a contract the app must remember everywhere.
*Recommendation:* Change the relation to `onDelete: Cascade` (matches intent, removes the latent hazard, makes the explicit `deleteMany` redundant-safety rather than required-correctness). Metadata-only migration. Apply via `prisma db push`.
*Effort:* Trivial.

#### Security

**M-SEC1. CSV import trusts client-parsed items — server-side validation is bypassed; `feedbackSource` can crash or inject an invalid enum.**
*Files:* `src/app/api/feedback-items/route.ts:193-301`, `src/app/admin/[projectId]/import/import-client.tsx:59-119`, `src/lib/csv-parser.ts:130-145`
*Problem:* `validateCSVRow` runs only client-side. The POST route does `item.feedbackSource.toUpperCase()` with no guard (missing/non-string → unhandled 500) and casts the result `as FeedbackSource` with no enum check; required fields (`studentId, studentText, feedbackText, feedbackId`) are likewise unvalidated server-side. A direct API caller (privileged-but-not-fully-trusted external project admin) can crash or partially import garbage.
*Recommendation:* Add a Zod (or reuse `validateCSVRow`) schema in the POST handler: require the four fields as non-empty strings and assert `feedbackSource ∈ {AI,HUMAN}` (case-insensitive) before the cast, returning 400 with the offending row index. Also fixes the 500.
*Effort:* Small. *(Canonical entry; api-consistency dimension reported the same import-validation gap — see §5.)*

**M-SEC2. No server-side size/count limit on CSV import payload (client-only 10MB cap is bypassable).**
*Files:* `src/app/api/feedback-items/route.ts:198-209`, `src/app/admin/[projectId]/import/import-client.tsx:48-50`, `next.config.ts`
*Problem:* The 10MB cap is browser-only. The POST does `await request.json()` then maps/inserts an arbitrarily large array with no length cap and no `bodyParser` size config — an authenticated project admin can POST a multi-hundred-MB body / huge array, forcing a large in-memory parse + giant `createMany` (memory/DoS + DB cost on serverless).
*Recommendation:* Reject `items.length` over a sane max (e.g. 50k) with 413/400 right after the `Array.isArray` check; configure the platform request-size limit.
*Effort:* Trivial.

**M-SEC3. No session/token revocation; no account-disable mechanism.**
*Files:* `src/lib/auth.ts:143-165`, `src/app/api/reset-password/accept/route.ts:24-29`, `src/app/api/invite/accept/route.ts:24-29`, `prisma/schema.prisma`
*Problem:* Same as H-A1 from the security dimension: stateless JWTs (8h), no `tokenVersion`/`isActive`. Password reset doesn't invalidate pre-reset sessions; there is no way to immediately cut off an external project-admin's export/unblinding access.
*Recommendation:* See H-A1 (consolidated). ASVS V7.4.2 / V9.3.1.
*Effort:* Medium. *(Duplicate of H-A1 — one fix resolves both.)*

#### Cleanup / Refactor

**M-CR1. Dead module: `batch-progress.ts` / `isBatchFullyScored` is never imported.**
*Files:* `src/lib/batch-progress.ts:17`
*Problem:* The whole file (86 lines) exports one function with zero importers; superseded by release-based `isReleaseFullyScored`. It encodes an older batch-level "fully scored" model that no longer matches how completion is computed — a re-wiring trap. *(Note: H-SC1 lists `batch-progress.ts:90` among the unindexed-Score consumers; once this module is deleted that reference disappears, but the Score indexes are still required for the live consumers.)*
*Recommendation:* Delete `src/lib/batch-progress.ts`.
*Effort:* Trivial.

**M-CR2. Dead helper `clearBatchSlots` — and its body is duplicated inline at the one place it should be called.**
*Files:* `src/lib/batch-slots.ts:51`, `src/app/api/projects/[projectId]/batches/[batchId]/route.ts:117`
*Problem:* `clearBatchSlots(batchId)` is never called, while `batches/[batchId]/route.ts:117-120` re-inlines the identical `updateMany`. Dead helper + hand-rolled copy side by side.
*Recommendation:* Replace the inline `updateMany` with `await clearBatchSlots(batchId)` and keep the helper.
*Effort:* Trivial.

**M-CR3. Legacy per-item `Assignment` model is effectively dead: route + writes have no readers.**
*Files:* `prisma/schema.prisma:168`, `src/app/api/projects/[projectId]/assignments/route.ts:56`, `src/app/api/scores/route.ts:174`
*Problem:* The pre-batch `Assignment`/`AssignmentStatus` model is vestigial. Outside generated code it's touched in two places: `POST /assignments` (no caller anywhere) and `scores/route.ts:174` `tx.assignment.updateMany(... status:'COMPLETE')` whose `status` is never read. All real progress runs off `Score` + `BatchAssignment` + `TeamBatchRelease`. CLAUDE.md still lists `/assignments` as live, masking that it's dead.
*Recommendation:* Remove `POST /assignments` and the `tx.assignment.updateMany` block in `scores/route.ts`; drop the `Assignment` model + `AssignmentStatus` enum and relations from the schema; `prisma db push`; update CLAUDE.md. Verify no historical data needs preserving. *(Mooting M-SC1.)*
*Effort:* Small.

**M-CR4. `~45-line "batch scoreability" guard block copy-pasted verbatim between scores POST and PUT.**
*Files:* `src/app/api/scores/route.ts:81`, `:225`
*Problem:* The membership lookup + `Promise.all([batch, batchAssignment])` + four identical guard checks + the dimension/value validation loop are duplicated character-for-character in POST (81-151) and PUT (225-297); only create-vs-upsert differs. Two copies of an authz/validation gate is exactly what drifts into a security gap.
*Recommendation:* Extract `assertScoreable(userId, role, feedbackItemId)` (returns `{releaseId}` or an error Response) and `validateScoreValues(scores, projectId)`; call from both. ~80 lines saved, single-source authz.
*Effort:* Small.

**M-CR5. `project-detail-client.tsx` is a 1254-line client component holding all 7 admin tabs.**
*Files:* `src/components/project-detail-client.tsx:204`
*Problem:* 7 tabs rendered inline, 33 hooks; Annotators (~250 lines incl. add/role/team mutations), Rubric, and Data/Export tabs still inlined. Largest component in the repo; a velocity/readability drag pre-open-source.
*Recommendation:* Extract `AnnotatorsTab`, `RubricTab`, `ExportTab/DataTab` mirroring the existing `OverviewTab`/`FeedbackItemsTab` pattern; target <300 lines for the shell.
*Effort:* Medium.

**M-CR6. Two committed `prisma.config.ts` files; CLAUDE.md documents the non-authoritative one.**
*Files:* `prisma.config.ts:1` (root), `prisma/prisma.config.ts:1`
*Problem:* Both are git-tracked and define the same datasource. Prisma v7 resolves `./prisma.config.ts` from the root, so the root file is authoritative and `prisma/prisma.config.ts` is an unused duplicate — yet CLAUDE.md and AGENTS.md tell contributors the config lives at `prisma/prisma.config.ts`, i.e. the file Prisma does *not* load. An actively misleading footgun for an open-source tool. *Both files confirmed present on disk.*
*Recommendation:* Keep root `prisma.config.ts`, delete `prisma/prisma.config.ts`, update CLAUDE.md + AGENTS.md to the root path; verify `npm run build` still resolves the datasource.
*Effort:* Trivial.

#### Frontend

**M-FE1. `GET /api/scores` returns reconciled rows, polluting the annotator scoring view with reconciled values (and notes).**
*Files:* `src/app/api/scores/route.ts:33`, `src/app/evaluate/[projectId]/evaluate-client.tsx:272,279`, `src/lib/reconciliation.ts:131`
*Problem:* The scores GET filters by project + `userId` but not `isReconciled`. Reconciled scores are written with `userId = ownerUserId` and `isReconciled: true`, so for the release owner the endpoint returns both the original and the reconciled score for the same (item, dimension). In evaluate-client the existing-scores loop (orderBy `scoredAt asc`) lets the later reconciled row overwrite `dimScore.value` with the reconciled/adjudicated value, and loads the reconciliation note as if it were the annotator's own. Reachable via "Preview Annotator View" for an admin who is also a team owner, or any re-render of the evaluate view for the owner after reconciliation. A blinded owner can be shown post-reconciliation values mislabeled as their original scoring.
*Recommendation:* Add `isReconciled: false` to the scores GET `where` for the annotator use case. Gate any reconciled-row access behind an explicit query param.
*Effort:* Trivial.

**M-FE2. Reconciliation completion screen shows "Reconciliation Complete" when every item was only escalated, not resolved.**
*Files:* `src/app/reconcile/[projectId]/reconcile-client.tsx:190,197,432`
*Problem:* `allDiscrepanciesScored` treats a discrepancy as done if escalated OR finalized; `handleSaveAndContinue` marks the item `saved`; `resolvedCount` counts `saved` items. When all discrepancies are escalated, `resolvedCount === items.length` triggers "Reconciliation Complete — All N discrepant items have been reconciled" — but nothing was reconciled; the server correctly refuses COMPLETE (open escalations). The pair is told they're done when they're waiting on adjudication, and may abandon the batch.
*Recommendation:* Distinguish "resolved by us" from "escalated, awaiting adjudicator." Only show the celebratory state when zero escalations are outstanding for the release; otherwise show "N criteria are awaiting the adjudicator."
*Effort:* Small.

**M-FE3. Role-toggle and several optimistic mutations swallow failures silently, leaving the UI out of sync with the server.**
*Files:* `src/components/project-detail-client.tsx:781,799`, `src/components/batch-creator.tsx:260`
*Problem:* The "Make Admin" toggle updates local state only inside `if (res.ok)` and has an empty `catch {}` ("silently fail") — a failed PATCH (403/network) shows no change and no error. `handleUpdateTeamRelease` rolls back on `!res.ok` but shows no message, so a failed visibility/adjudicator/scorer toggle silently snaps back. Violates the project's stated "no silent failures."
*Recommendation:* Surface failures with an inline error/toast on non-ok/catch; mirror the sibling `handleBatchTypeChange` alert. Consider a shared toast utility (several handlers only `console.error`).
*Effort:* Small.

---

### 3.3 LOW

#### Auth / Authorization

**L-A1. StudyFlow magic-link auto-creates accounts and silently assigns project membership from a self-asserted JWT claim.**
*Files:* `src/lib/auth.ts:7-103`
*Problem:* Token verification is solid (signature, iss/aud, exp, 10-min maxTokenAge, email match), but on success it upserts `ProjectEvaluator` using `project_id` from the payload with no check that the project is associated with that `study_id`. Anyone with `STUDYFLOW_LINK_SECRET` can enroll an arbitrary email into an arbitrary project. Risk is low (signature required) but the `project_id` claim is trusted on a weaker invariant than the adjacent study-scoped path.
*Recommendation:* When `project_id` is present, verify the project's `studyflowStudyId` matches the token's `study_id` before upserting. Document `STUDYFLOW_LINK_SECRET` rotation.
*Effort:* Small.

**L-A2. Team membership/dimension/release-pair authorization assumes exactly-2 teams but the invariant is not enforced (peer score/notes exposure if >2).**
*Note:* This is the data-exposure facet of H-L1/M-A2; enforcing exactly-2 members at team create/edit (H-L1) closes it. *(Consolidated — see §5.)*

#### Scoring / IRR

**L-S1. `discrepancies` route `summary.reconciledCount` counts auto-reconciled agreements, diverging from the authoritative stats.**
*Files:* `src/app/api/projects/[projectId]/batches/[batchId]/discrepancies/route.ts:345-360`, `src/lib/reconciliation.ts:339-353`
*Problem:* `reconciledCount` is a raw count of all `isReconciled` rows by the owner over the team dimensions, including auto-reconciled *agreement* rows — so it can far exceed `totalDiscrepancies`. The authoritative `computeReleaseDiscrepancyStats` filters reconciled rows to genuine discrepant keys. Not user-visible today (reconcile-client renders `resolvedCount`/`totalDiscrepancies`, not this field), but the API returns a wrong value — a trap for future consumers.
*Recommendation:* Scope `reconciledCount` to discrepant keys, or have the route reuse `computeReleaseDiscrepancyStats`.
*Effort:* Small.

**L-S2. `countForAssignment` hardcodes `scorerUserId: null`, mis-counting legacy single-scorer releases on the dashboard.**
*Files:* `src/lib/evaluator-stats.ts:82-107`, `src/lib/team-batch-releases.ts:127-150`
*Problem:* Same hardcode as H-CR1, viewed from the stats side: a legacy single-scorer release is classified as a slot-split, so the dashboard returns only the user's slot half when the single scorer owns *all* items → under-reported counts. Only affects pre-existing single-scorer rows. *Confirmed at `evaluator-stats.ts:90`.*
*Recommendation:* Pass the real `scorerUserId` into the release context (resolved by H-CR1's "fix" branch).
*Effort:* Small. *(Same root cause as H-CR1 — see §5.)*

**L-S3. `assignBatchSlots` re-shuffles the entire batch when any item lacks a slot — corruption footgun.**
*Note:* Same issue as M-L4; canonicalized there. *(See §5.)*

**L-S4. Release status transitions are read-then-write without atomicity (Neon HTTP adapter holds no locks).**
*Files:* `src/lib/reconciliation.ts:168-193,195-277`, `src/lib/db.ts:6-11`
*Problem:* Each statement is a separate round-trip; no row lock spans read+update. Concurrent final-score submissions or concurrent reconcile/adjudicate can both observe the same status and both attempt the same transition. Benign today (updates + auto-reconcile upserts are idempotent), but the same gap enables M-S2's escalate-vs-complete orphan.
*Recommendation:* Guard status flips with conditional writes (`updateMany where:{status:<expected>}`, act only if `count===1`) or a serializable transaction. Also closes M-S2 if the escalation insert is made conditional within the same guarded write.
*Effort:* Medium.

#### Lifecycle

**L-L1. `syncBatchStatus` derives `isAssigned` from release status, not from actual assignments — can report `isAssigned=true` with zero assignments.**
*Files:* `src/lib/team-batch-releases.ts:181-187,152-163`
*Problem:* `isAssigned: statuses.some(s => s !== 'DRAFT')`. A release can be SCORING with zero `BatchAssignment` rows (M-L3 empty-team republish, or a single-scorer release whose scorer was removed). The batch is then flagged `isAssigned=true` + SCORING though nobody is assigned; `isAssigned` is documented as "locked after first assignment" and gates UI/IRR, so a false positive misleads admins.
*Recommendation:* Derive `isAssigned` from an actual `BatchAssignment` count > 0, independent of release status.
*Effort:* Trivial.

#### API Consistency

**L-API1. Inconsistent 403-vs-404 leaks project existence and diverges across routes.**
*Files:* `src/app/api/projects/[projectId]/route.ts:20-47`, `.../batches/route.ts:39-46`, `src/app/api/scores/route.ts:22-31`
*Problem:* Some routes return 403 for a non-member before loading the project (so a nonexistent project reads as 403), others load then 404. No consistent rule for "no access" → 403 vs 404. For a blinded research tool the 404-everywhere posture is preferable; the codebase mixes both.
*Recommendation:* Standardize via the shared auth helper: 404 for both "not found" and "not authorized to see this project" on project-scoped GETs; 403 only where a known member lacks a specific elevated right. Document in CLAUDE.md.
*Effort:* Small.

**L-API2. CSV import (feedback-items POST) trusts client-supplied row shapes — no per-field validation, enum guard, or array-size cap.**
*Note:* Same as M-SEC1 + M-SEC2 from the API dimension; canonicalized under Security. *(See §5.)*

**L-API3. Bulk-create routes swallow all errors in a per-item try/catch, masking real failures as "duplicate skipped."**
*Files:* `src/app/api/projects/[projectId]/batches/[batchId]/assign/route.ts:48-61`, `.../import-evaluators/route.ts:79-99`
*Problem:* `assign` maps userIds to `create` inside `try{...}catch{return null}` and treats every failure as an "already assigned" skip — an FK violation, connection error, or any fault is silently swallowed and reported as a successful skip. `import-evaluators` loops with no error isolation and `p.email.trim()` throws on a non-string. *(Note: `assign`'s host route is slated for deletion under H-L2/H-L9 — if removed, only `import-evaluators` remains.)*
*Recommendation:* Narrow the catch to `code==='P2002'` and rethrow else; or pre-validate membership and use `createMany({skipDuplicates:true})`. In `import-evaluators`, validate each `email` is a non-empty string and return per-row results.
*Effort:* Small.

**L-API4. No rate limiting on auth-adjacent public endpoints.**
*Note:* Duplicate of H-SEC1/M-A3 from the API dimension. *(See §5.)*

**L-API5. Repeated auth + project-membership boilerplate across ~35 routes invites drift; recommend a shared guard layer.**
*Files:* `src/app/api/scores/route.ts:7-31`, `.../batches/route.ts:32-46`, `src/app/api/feedback-items/route.ts:8-40`, `src/lib/authorization.ts:1-28`
*Problem:* Nearly every route hand-rolls `auth()` → 401 → params → `canAdminProject` / `projectEvaluator.findUnique`, with subtle per-route variations. This is the root cause behind L-API1, M-API1, and M-API2 (no single place enforces the pattern, so each drifts).
*Recommendation:* Introduce `requireSession()`, `requireProjectMember(projectId)`, `requireProjectAdmin(projectId)` (each returns the session or a typed Response), plus `readJson()` and `withErrorHandling()`. Route bodies then read guard → parse → validate → mutate, and 403/404/parse/duplicate behaviors become uniform by construction. Document the canonical route shape in CLAUDE.md.
*Effort:* Large.

#### Schema

**L-SC1. Dead enum value `ProjectStatus.RECONCILIATION` — never settable, retained only in a color map (enum drift).**
*Files:* `prisma/schema.prisma:79-84`, `src/app/api/projects/[projectId]/route.ts:71-73`, `src/lib/status-colors.ts:4`
*Problem:* The only write path hardcodes `VALID_STATUSES = ['SETUP','ACTIVE','COMPLETE']` (RECONCILIATION intentionally omitted — it's batch-level), so no project row can hold it; it survives only in `status-colors.ts`. Benign drift that misleads readers.
*Recommendation:* Remove `RECONCILIATION` from the enum and its `status-colors.ts` entry (confirm `SELECT DISTINCT status FROM "Project"` first), or at minimum add a `// not used` comment.
*Effort:* Trivial.

**L-SC2. Legacy `TeamBatchRelease.scorerUserId` still partially wired into read paths despite being declared dead.**
*Note:* Same field as H-CR1; the schema-level recommendation (drop the column + `TeamBatchReleaseScorer` relation, destructive) is the end-state of the H-CR1 "remove" path. *(See §5.)*

**L-SC3. `FeedbackItem.feedbackSource` has no DB distribution guard and `Score.value` has no DB scale constraint — research-validity integrity is app-code-only.**
*Files:* `prisma/schema.prisma:126,335`, `src/app/api/scores/route.ts:290-296`
*Problem:* `Score.value` is a bare `Int` with no CHECK against the dimension's `scaleMin`/`scaleMax` (API validates it; 0 live violations). A Postgres CHECK can't reference another table's columns, so no simple column CHECK is possible; the only net is remembering to validate in every write path.
*Recommendation:* Low priority given clean data. Add a regression test asserting all scores are in range; if a DB net is wanted, add a trigger validating against the dimension scale. Do not add a naive `CHECK(value BETWEEN 0 AND N)` (scales are per-dimension).
*Effort:* Small.

**L-SC4. No index on `AuthToken.email` — invite/reset issuance Seq-scans the token table on every request.**
*Files:* `prisma/schema.prisma:40-48`, `src/lib/tokens.ts:14-15`
*Problem:* `createToken()` runs `authToken.updateMany({where:{email,type,usedAt:null}})` per invite/reset; `AuthToken` has only PK + unique(token), so this is a Seq Scan. Tiny today, but on the auth surface and compounds under the abuse the planned rate-limiting addresses.
*Recommendation:* Add `@@index([email, type])`. Apply via `prisma db push`.
*Effort:* Trivial.

**L-SC5. Missing FK indexes on remaining child tables (Escalation, BatchAssignment, FeedbackItem.importId, BatchRange).**
*Files:* `prisma/schema.prisma:384-403,233-246,90-108,129-137,253-263`
*Problem:* Essentially no FKs are indexed beyond PKs/uniques/the two Activity indexes. Cheap today (small tables) but real at scale and during cascades: `Escalation.batchId/feedbackItemId/resolvedById`, `BatchAssignment.userId/teamReleaseId` (release-delete `deleteMany` Seq-scans), `FeedbackItem.importId`, `BatchRange.batchId`. (`RubricDimension.projectId` is already covered by `[projectId,key]`.)
*Recommendation:* Add `@@index([userId])` + `@@index([teamReleaseId])` on `BatchAssignment`; `@@index([batchId])`, `@@index([feedbackItemId])`, `@@index([resolvedById])` on `Escalation`; `@@index([importId])` on `FeedbackItem`; `@@index([batchId])` on `BatchRange`. All additive. *(Batch these with H-SC1/H-SC2/L-SC4 into one migration.)*
*Effort:* Small.

#### Security

**L-SEC1. No in-app change-password flow and no MFA for admins/external collaborators.**
*Files:* `src/app/api/`, `src/lib/auth.ts`
*Problem:* No authenticated change-password endpoint (only reset/invite-accept write `hashedPassword`); a logged-in user must use the email-reset flow, with no current-password re-auth gate. No MFA anywhere (TOTP deferred per CLAUDE.md). For accounts that can unblind a dataset, single-factor with no step-up is the weak point. No common/breached-password check on set.
*Recommendation:* Pragmatic: (a) add an authenticated change-password endpoint requiring the current password and bumping `tokenVersion` (ties to H-A1); (b) add a HIBP k-anonymity breached-password check at password-set (small, high value, no infra). Treat opt-in TOTP as documented follow-up, but decide explicitly before external project-admin/export rights.
*Effort:* Medium.

**L-SEC2. Invite/StudyFlow display name is interpolated unescaped into invite email HTML.**
*Files:* `src/lib/email.ts:24-54`, `src/app/api/invite/route.ts:29-47`, `.../import-evaluators/route.ts:81-87`
*Problem:* `sendInviteEmail` injects `name` raw into the HTML template with no escaping. The value comes from a trusted admin or signed-StudyFlow source and mail clients sanitize heavily, so impact is limited to email-client-context HTML injection, not app XSS. Worth fixing for defense-in-depth.
*Recommendation:* HTML-escape interpolated values (`& < > " '`) for `name` and `projectName`; optionally cap length / strip control chars at the API boundary.
*Effort:* Trivial.

#### Cleanup / Refactor

**L-CR1. Dead helper `getMemberSlotIndex` in `batch-slots.ts` (superseded by `getReleaseUserSlotIndex`).**
*Files:* `src/lib/batch-slots.ts:62`
*Problem:* Exported, never imported; the live lookup is `getReleaseUserSlotIndex`. Two functions computing "which slot does this user occupy" invites drift.
*Recommendation:* Delete `getMemberSlotIndex`.
*Effort:* Trivial.

**L-CR2. Orphaned endpoint: `GET /api/projects/[projectId]/stats` has no caller.**
*Files:* `src/app/api/projects/[projectId]/stats/route.ts:6`
*Problem:* Returns `{scoredItemCount}`; no fetch/component references `/stats`. Same pre-batch generation as the `Assignment` model. (Sibling `unbatched-stats` and `annotator-time` are distinct and still used.)
*Recommendation:* Delete the route.
*Effort:* Trivial.

**L-CR3. Orphaned endpoint: `GET /api/projects/[projectId]/imports` (import history) has no caller.**
*Files:* `src/app/api/projects/[projectId]/imports/route.ts:9`
*Problem:* A fully built admin endpoint returning per-CSV import history; no component fetches it. Looks like a near-future feature rather than legacy.
*Recommendation:* Either wire it into the Items/Data tab (the data shape is clearly intended for an import-history table) or remove it before open-sourcing. Decide by roadmap.
*Effort:* Trivial.

**L-CR4. AGENTS.md is a stale near-duplicate of CLAUDE.md (205 of ~220 lines identical).**
*Files:* `AGENTS.md:1`, `CLAUDE.md:1`
*Problem:* AGENTS.md is the older, smaller copy, missing recent sections (criterion-IRR/pairing, batch-type editing). Two overlapping instruction files keep diverging; a contributor reading AGENTS.md gets outdated guidance.
*Recommendation:* Make AGENTS.md a thin pointer to CLAUDE.md (or symlink / single-line include) so there is one source of truth.
*Effort:* Trivial.

**L-CR5. Recurring notes-collapsing map pattern duplicated across export, discrepancies, and adjudicate routes.**
*Files:* `src/app/api/export/route.ts:320`, `.../discrepancies/route.ts:153`, `src/app/api/adjudicate/route.ts:141`
*Problem:* The "collapse `Score.notes` into one entry per key" idiom is hand-written three times with slightly different keys. Softer DRY issue than the scores/batches duplication.
*Recommendation:* Add `collapseNotes(rows, keyFn): Map<string,string>` in `reconciliation.ts` (or a notes util) and reuse in all three.
*Effort:* Small.

#### Frontend

**L-FE1. Auto-save effect omits `dimensionId`/team-scope changes; `fetchData` useCallback is missing `batchType` dependency.**
*Files:* `src/app/evaluate/[projectId]/evaluate-client.tsx:190,310`
*Problem:* `fetchData` reads `batchType` (to filter the rubric to the team's dimensions for non-training batches) but its deps are `[projectId, batchId]` (ESLint exhaustive-deps warning). A stale `batchType` on a soft transition between a training and a regular batch would show the wrong rubric scope. Stable per navigation today; latent. Also flags unused `teamInfo` state and an unused `durationSeconds` local (per-item timing computed but never sent in the PUT body).
*Recommendation:* Add `batchType` to the deps; remove `teamInfo` or wire `durationSeconds` into the save payload (timing is a documented feature).
*Effort:* Trivial.

**L-FE2. Browser-native `confirm()`/`alert()` used for destructive admin actions.**
*Files:* `src/components/batch-creator.tsx:191,217`, `src/app/admin/accounts/team-client.tsx:110,133`
*Problem:* Destructive ops (delete batch, unpublish, change global role, delete account "removes all their scores/assignments/memberships") gate on `window.confirm()` and report via `window.alert()`. Native dialogs are visually inconsistent with shadcn/ui and can be *suppressed entirely* in embedded/iframe contexts (the planned Replit embed) — letting a destructive action fire with no confirmation or blocking a confirm.
*Recommendation:* Replace with the existing `Dialog` (AlertDialog-style confirm) for destructive/irreversible actions — at minimum account-delete and batch-delete. Also fixes the suppressed-dialog risk in embeds.
*Effort:* Medium.

**L-FE3. `theme-toggle` and `app-sidebar` set theme state inside an effect — flicker risk and ESLint set-state-in-effect errors.**
*Files:* `src/components/theme-toggle.tsx:10`, `src/components/app-sidebar.tsx:71`
*Problem:* Both init `dark=false` then read `document.documentElement.classList` in `useEffect` and `setDark` (ESLint `react-hooks/set-state-in-effect`). A dark-mode user briefly sees the Moon icon until the effect flips it — a one-frame flash, and the kind of cascading render React 19 rules forbid; a lint build with error rules fails on it.
*Recommendation:* Use `useSyncExternalStore` (as `app-shell.tsx` does) or lazy `useState(() => ...)` guarded by `typeof document !== 'undefined'` to read the initial theme synchronously. Consolidate the two duplicated toggles into one component.
*Effort:* Small.

**L-FE4. Reconcile auto-advance uses a 300ms `setTimeout` with no cleanup — can jump the user after they navigate away.**
*Files:* `src/app/reconcile/[projectId]/reconcile-client.tsx:393`
*Problem:* After a save, `setTimeout(() => setCurrentIndex(nextUnresolved), 300)` has no stored handle/cleanup. Clicking a nav circle or Back within 300ms still fires the timer, overriding deliberate navigation; it can also fire during unmount.
*Recommendation:* Store the id in a ref and clear it on next save / manual nav / unmount, or advance immediately (the "saved" flash can be shown via the existing `saveStatus` badge).
*Effort:* Trivial.

**L-FE5. `FeedbackItemsTab` filter-change fetches race with no cancellation.**
*Files:* `src/components/feedback-items-tab.tsx:56,82`
*Problem:* `fetchItems` fires from a filter-change effect and pagination with no AbortController or ordering guard; quick filter changes race and the last-resolved response wins, possibly not matching the current filters. An `eslint-disable exhaustive-deps` hides that `fetchItems` isn't memoized.
*Recommendation:* AbortController per fetch (abort previous) or a sequence counter ignoring stale responses; wrap `fetchItems` in `useCallback` and drop the disable.
*Effort:* Small.

**L-FE6. Reconcile shows no error if the discrepancies fetch fails — annotator sees a false "No Discrepancies" success state.**
*Files:* `src/app/reconcile/[projectId]/reconcile-client.tsx:148,175,416`
*Problem:* In `fetchDiscrepancies` any failure is only `console.error`-ed; `items` stays `[]` and the render falls through to "No Discrepancies Found — All scores match." A transient API/auth error is presented as "everything matched, nothing to do," with no retry. The adjudicate-client and team-management share this pattern.
*Recommendation:* Add an explicit error state (mirroring `evaluate-client.tsx:541-569`) with a "Try Again" button; apply to adjudicate-client and team-management too.
*Effort:* Small.

---

### 3.4 NIT

**N-1. IRR batch average uses macro-average of rounded per-team percentages while the per-dimension rollup uses pooled (micro) counts.** — `src/lib/irr.ts:299-312,281-293`. `averageAgreementPct` is the mean of pre-rounded per-team rates (weights teams equally, compounds rounding) while `perDimension` pools `agreedPairs/totalPairs` (micro-average). Two batch-level numbers, two methodologies; few-pair teams swing the headline. **Fix:** pool across teams for a micro-average consistent with `perDimension`, or document it as an unweighted mean. *Effort: trivial.*

**N-2. `reconciledFrom` stores comma-joined Score IDs as a soft reference to rows that cascade-delete — audit trail can silently dangle.** — `prisma/schema.prisma:338`, `src/app/api/adjudicate/route.ts:293-317`, `src/lib/reconciliation.ts:137-158`. Intentional denormalized breadcrumb; referenced originals cascade with parents, so low risk. **Fix:** document it as a soft, non-enforced reference consumers must tolerate missing; if stronger provenance is needed, model a `ReconciledScoreSource` join table. *No action required pre-production.*

**N-3. `PATCH /api/projects/[projectId]` builds its update object with `Record<string, any>` (eslint-disabled) instead of a typed accumulator.** — `src/app/api/projects/[projectId]/route.ts:93-97`. The three fields are whitelisted (not an over-posting hole today), but the `any` accumulator invites future drift and stands out against typed update objects elsewhere. **Fix:** type it `Prisma.ProjectUpdateInput`, drop the disable. *Effort: trivial.*

**N-4. Internal naming inconsistency: tab/route/API keys use "evaluator", UI says "Annotator".** — `src/components/project-detail-client.tsx:585`, `src/app/api/projects/[projectId]/batches/route.ts:326`. User-facing strings are fully renamed, but the batches API returns the list under JSON key `evaluators` and the tab `value="evaluators"`. Cosmetic; partly unavoidable (Prisma `ProjectEvaluator`/`EvaluatorTeam` are baked in). **Fix (optional):** rename the API key and tab value to `annotators`; leave Prisma models and CSV headers (an external data contract) as-is; note in CLAUDE.md that "evaluator" persists at the data layer intentionally. *Effort: small.*

**N-5. `MyTimeCard` initial period renders "0.0 hours" until the async fetch returns, with no loading affordance.** — `src/components/my-time-card.tsx:18,60`. Starts `data=null` → `formatDuration(0)` until fetch resolves, so an annotator briefly sees "0.0 hours" (looks like a reset). Same pattern as the admin Annotators "Time" column. **Fix:** show a skeleton/em-dash while `data===null`. *Effort: trivial.* *(Gated behind `NEXT_PUBLIC_SHOW_ANNOTATOR_TIME` today.)*

---

## 4. Defer / Nice-to-Have

Not blockers for a careful internal run; schedule post-launch or as part of the open-source hardening pass. (Cross-references point at the canonical entry above.)

**Worth doing soon, low cost:**
- **L-SC1** Remove dead `ProjectStatus.RECONCILIATION` enum value (trivial).
- **L-SC4 / L-SC5** Remaining FK indexes (`AuthToken.email`, Escalation/BatchAssignment/FeedbackItem.importId/BatchRange) — batch into the same migration as the P10 indexes.
- **M-CR1, M-CR2, L-CR1** Delete dead `batch-progress.ts`, dead `getMemberSlotIndex`; use `clearBatchSlots` instead of the inline copy (all trivial).
- **M-CR6** Delete the duplicate `prisma/prisma.config.ts` and fix the docs (actively misleading; trivial).
- **L-CR2 / L-CR3** Delete orphaned `/stats`; decide `/imports` (wire-up or delete).
- **L-CR4** Collapse AGENTS.md into a pointer to CLAUDE.md.
- **L-FE1, L-FE4** Auto-save deps + reconcile timeout cleanup (trivial, removes lint errors / a "page jumped" surprise).
- **L-SEC2** HTML-escape the invite email name (trivial defense-in-depth).
- **N-1, N-3** IRR micro-average consistency; type the project PATCH accumulator.

**Larger refactors — schedule deliberately:**
- **M-API4** Batches GET perf refactor (large) — subsumes H-CR2/M-S1; do once IRR/discrepancy counting is consolidated.
- **L-API5** Shared route-guard layer (large) — the root-cause fix behind L-API1, M-API1, M-API2; high leverage for the open-source codebase.
- **M-CR3** Remove the dead `Assignment` model + enum (small but schema-destructive; verify no historical data; moots M-SC1).
- **M-CR5** Split the 1254-line `project-detail-client.tsx` into tab components (medium).

**Genuinely deferrable / decision-gated:**
- **L-SEC1 (MFA)** Opt-in TOTP — keep as documented follow-up, but make an explicit go/no-go before external project-admin/export rights.
- **L-FE2/L-FE3 consolidation** Merge the two theme-toggle implementations into one component while fixing the flicker.
- **N-2** `reconciledFrom` soft-reference — document only; no action.
- **N-4** "evaluator" vs "annotator" internal naming — cosmetic; touch only if already in the area. Do **not** change CSV export headers (external contract).
- **L-FE5, L-FE6, M-FE3** Request-cancellation, error-state, and silent-failure UX cleanups — fold into a single "frontend robustness" pass (add a shared toast + error-card pattern, then apply across reconcile/adjudicate/team-management/feedback-items).

---

## 5. Deduplication & Reconciliation Notes

The 8 subsystem audits independently reported several of the same root causes from different angles. These were collapsed to avoid double-counting (77 raw → 58 distinct):

| Root cause | Canonical entry | Raw duplicates folded in |
|------------|-----------------|--------------------------|
| Token/session revocation | **H-A1** | M-SEC3 (security) — same `tokenVersion`/`isActive` gap |
| No rate limiting | **H-SEC1** | M-A3 (auth), L-API4 (api) — same four endpoints + login |
| `scorerUserId` "legacy" still live | **H-CR1** | M-L1, M-L2 (lifecycle: orphan POST route, settable via PATCH), L-SC2 (schema: drop column), L-S2 (scoring: `evaluator-stats.ts:90` miscount). All trace to the one undecided field. |
| Discrepancy counting duplicated/buggy | **H-CR2** | M-S1 (scoring: TRAINING under-count) — same inline block missing the `userId` check; M-API4's refactor also subsumes both |
| Batch creation non-transactional | **H-API1** | Lifecycle reported it twice (range path + all-three-paths) — single canonical |
| `assignBatchSlots` re-shuffle footgun | **M-L4** | L-S3 (scoring) — identical |
| Team-size ≠ 2 invariant | **H-L1** | M-A2 / L-A2 (auth: peer score exposure if >2) — enforcing exactly-2 closes both |
| CSV import server-side validation + size cap | **M-SEC1 / M-SEC2** | L-API2 (api) — same import route |
| Cross-project IDOR vs. team re-sync | **H-A2** (validate inbound IDs) + **H-L3** (re-sync on team change) | Related but distinct: H-A2 is "reject foreign IDs at write," H-L3 is "propagate valid changes to existing batches." Both kept. |

**One contradiction reconciled:** CLAUDE.md states `TeamBatchRelease.scorerUserId` is "legacy … unused by the UI." The code disagrees — `batch-creator.tsx:705` renders a scorer `<select>`, both `releases` routes write it, and `team-batch-releases.ts` branches on it; `evaluator-stats.ts:90` hardcodes it to `null`, producing a real per-annotator miscount. **Resolution:** treated as a live-but-buggy path (H-CR1), not dead code — the fix must either remove it everywhere (likely, since new batches always slot-split) or correct the docs *and* `evaluator-stats.ts`. The docs are the stale artifact, not the code.

**Positive findings worth recording (no action):** reset-password correctly returns success to avoid email enumeration; `verifyToken` enforces type/usedAt/expiry with single-use semantics; login returns a generic error; the StudyFlow JWT verification (signature, iss/aud, exp, 10-min maxTokenAge, email match) is solid; the CSPRNG blinding shuffle and CSV formula-injection escaping are correct; `Score.value` and `feedbackSource` have 0 live integrity violations under the current app-level guards.
