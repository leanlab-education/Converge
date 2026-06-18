# Writing Evaluator — Behavioral Specification

> **Purpose.** This document is the authoritative behavioral spec for the Writing Evaluator tool. It is written to be the basis for a full professional test suite (unit + integration). Every claim is grounded in code; file paths and line references are cited inline. Where two layers enforce the same rule (server component + API, or page guard + route), both are noted so tests can target each independently.
>
> **App in one sentence.** A blinded, rubric-based scoring tool where annotators score written feedback items against configurable criteria; pairs double-score and reconcile discrepancies; unresolved criteria escalate to a peer adjudicator; inter-rater reliability (IRR) is tracked per criterion; and results export with the human/AI source unblinded only at export time.
>
> **Stack.** Next.js 16 App Router, React 19, Prisma v7 with `@prisma/adapter-neon`, Auth.js v5 (JWT strategy), TypeScript. Test runner: Vitest (`vitest.config.ts`), Node environment, coverage scoped to `src/lib/**`. A `test/setup.ts` exists and integration tests against a real DB opt in explicitly.

---

## 1. Domain Concepts & Data Model

Schema: `prisma/schema.prisma`. All IDs are `cuid()`. All models cascade-delete from `Project` unless noted.

### 1.1 User & Auth
- **`User`** (`schema.prisma:14`): `email` (unique), `hashedPassword` (nullable — magic-link users have none until they set one), `role` (`Role` enum: `ADMIN | EVALUATOR`, default `EVALUATOR`). Relations into scores, batch assignments, team memberships, adjudicated/scorer releases, escalations (created/resolved), and activity rows.
- **`Role`** (`schema.prisma:35`): global role only. `ADMIN` = full system; `EVALUATOR` = annotator. Project-scoped admin is a *separate* concept (see `ProjectEvaluatorRole`).
- **`AuthToken`** (`schema.prisma:40`): `email`, `token` (unique), `type` (`INVITE | RESET`), `expiresAt`, `usedAt`. Invite/reset flow.

### 1.2 Project
- **`Project`** (`schema.prisma:59`): `name`, `description?`, `status` (`ProjectStatus`: `SETUP | ACTIVE | RECONCILIATION | COMPLETE`, default `SETUP`), `discrepancyThreshold` (default 1), `studyflowStudyId?` (links to a StudyFlow study), `usePseudonyms` (default false).
- **`ProjectStatus`** is **display/organizational only** and **does not gate annotator access** (see Invariant I-12). Note: although the enum includes `RECONCILIATION`, the PATCH route deliberately rejects it — valid settable values are `SETUP | ACTIVE | COMPLETE` (`api/projects/[projectId]/route.ts:73`).

### 1.3 Rubric (configurable per project)
- **`RubricDimension`** (`schema.prisma:90`): `projectId`, `key`, `label`, `description?`, `sortOrder`, `scaleMin` (default 0), `scaleMax` (default 1), `scoreLabelJson?` (JSON keyed by score value), `guidanceJson?`. Unique on `[projectId, key]`.
- Rubric is **rows in the DB, not hardcoded columns** — fully configurable per project.
- **Default rubric** is the Quill Feedback Rubric V11 (`src/lib/rubric-templates.ts`): 8 criteria (`criterion_1` … `criterion_8`), each on a **0–1 scale** (`STANDARD_SCALE` min 0 / max 1). Score labels: `0 = "Does Not Meet Criterion"`, `1 = "Meets Criterion"`. Created at project creation from `DEFAULT_RUBRIC` (`api/projects/route.ts:50-61`). Keys are stable so existing scores/exports/team assignments remain valid across edits.
- **`sortOrder` drives criterion pairing** — teams are assigned adjacent criteria by sort order (per memory `project_criterion_irr_and_pairing.md`); the IRR per-dimension rollups all sort by `sortOrder`.

### 1.4 Feedback Item (imported from CSV)
- **`FeedbackItem`** (`schema.prisma:114`): `projectId`, `responseId?`, `cycleId?`, `studentId`, `activityId?`, `conjunctionId?` ("But"/"Because"), `studentText`, `feedbackId`, `teacherId?`, `feedbackText`, `feedbackSource` (`FeedbackSource`: `AI | HUMAN`), `optimal?`, `feedbackType?`, `batchId?` (null = unbatched), `importId?`, `displayOrder?`, `slotIndex?` (0 or 1). Unique on `[projectId, feedbackId]`.
- **`feedbackSource` is the blinding axis.** It is `AI` or `HUMAN`, **hidden during scoring** and **revealed only on export** (Invariant I-11).
- **`slotIndex`** (0/1): for non-double-scored regular batches, splits items ~50/50 between the two team members. Set once per batch by a CSPRNG shuffle (`src/lib/batch-slots.ts`).

### 1.5 FeedbackSource enum
- **`FeedbackSource`** (`schema.prisma:145`): `AI | HUMAN`.

### 1.6 Project membership & legacy assignment
- **`ProjectEvaluator`** (`schema.prisma:154`): join `[projectId, userId]` (unique), with per-project `role` (`ProjectEvaluatorRole`: `EVALUATOR | PROJECT_ADMIN`, default `EVALUATOR`).
- **`ProjectEvaluatorRole`** (`schema.prisma:189`): `PROJECT_ADMIN` grants full admin on that one project without global admin.
- **`Assignment`** (`schema.prisma:168`) + **`AssignmentStatus`** (`PENDING | IN_PROGRESS | COMPLETE`): per-item legacy assignment, unique `[evaluatorId, feedbackItemId]`. Largely superseded by batch assignments; the scores POST still flips matching `Assignment` rows to `COMPLETE` (`api/scores/route.ts:174`).

### 1.7 Batch
- **`Batch`** (`schema.prisma:198`): `projectId`, `name`, `activityId?`, `conjunctionId?`, `type` (`BatchType`: `REGULAR | TRAINING`, default `REGULAR`), `isDoubleScored` (default false), `status` (`BatchStatus`: `DRAFT | SCORING | RECONCILING | COMPLETE`, default `DRAFT`), `size`, `isAssigned`, `sortOrder`, `isHidden` (default false — hide from annotators).
- **`BatchStatus`** (`schema.prisma:221`): `DRAFT` → `SCORING` → `RECONCILING` → `COMPLETE`. Batch status is **derived from its team releases** (`syncBatchStatus`, see §3.E).
- **`BatchType`** (`schema.prisma:228`): `REGULAR` (annotators see only their team's criteria) | `TRAINING` (every annotator scores every project criterion).
- Three operational batch modes (the matrix that drives most logic):
  1. **TRAINING** — every member scores every project dimension.
  2. **Double-scored REGULAR** (`isDoubleScored=true`) — both team members score every team criterion; reconciliation applies.
  3. **Single-scored REGULAR** (`isDoubleScored=false`) — either a 50/50 `slotIndex` split between two members, **or** one named scorer who sees all items; no reconciliation.

### 1.8 BatchAssignment
- **`BatchAssignment`** (`schema.prisma:233`): `[batchId, userId]` (unique), optional `teamReleaseId`, `scoringRole` (`ScoringRole`: `PRIMARY | DOUBLE`, default `PRIMARY`). One row per annotator who scores anything in the batch.
- **`ScoringRole`** (`schema.prisma:248`): only double-scored batches use the `PRIMARY`/`DOUBLE` distinction; for single-scored split, both members are `PRIMARY` for their own slot (`team-batch-releases.ts:300`).

### 1.9 BatchRange
- **`BatchRange`** (`schema.prisma:253`): `startFeedbackId`, `endFeedbackId`, `itemCount`, `sortOrder`. Records the feedback-ID ranges a batch was built from.

### 1.10 TeamBatchRelease (the central per-team unit of work)
- **`TeamBatchRelease`** (`schema.prisma:265`): `[batchId, teamId]` (unique), `scorerUserId?` (legacy named single-scorer), `adjudicatorId?` (per-team/criterion tiebreaker for this batch), `isVisible` (default false), `status` (`BatchStatus`, default `DRAFT`).
- One release per (team × batch). A batch's status is the rollup of its releases. Visibility (`isVisible`) is decoupled from assignment — releases are created hidden, then published.
- `scorerUserId` is **legacy**; new single-scored regular batches leave it null and rely on the slot split (`schema.prisma:269`, `batches/route.ts:644`).

### 1.11 EvaluatorTeam + criterion pairings
- **`EvaluatorTeam`** (`schema.prisma:290`): `[projectId, name]` (unique).
- **`EvaluatorTeamMember`** (`schema.prisma:304`): `[teamId, userId]` (unique). A user may be on **at most one team per project** (enforced in team create/update/membership routes).
- **`EvaluatorTeamDimension`** (`schema.prisma:315`): `[teamId, dimensionId]` (unique). A dimension is assigned to **at most one team per project** (enforced in team create/update).
- **Member ordering convention:** members are consistently ordered **by email ascending** everywhere it matters (IRR, slot assignment, reconciliation owner). `members[0]` (lowest email) is the **release owner** — the user under whom reconciled rows are written (`getReleaseOwnerUserId`, `team-batch-releases.ts:118`).

### 1.12 Score (incl. isReconciled)
- **`Score`** (`schema.prisma:330`): `feedbackItemId`, `userId`, `dimensionId`, `value` (Int), `rationale?`, `isReconciled` (default false), `reconciledFrom?` (comma-joined source score IDs), `notes?`, `startedAt?`, `scoredAt`, `durationSeconds?`.
- **Unique constraint:** `[feedbackItemId, userId, dimensionId, isReconciled]` (`schema.prisma:348`). **This is load-bearing:** because `isReconciled` is part of the key, a reconciled row (`isReconciled=true`) is a **separate row** from the original (`isReconciled=false`) — reconciliation never overwrites originals (Invariant I-1).
- Original score: `isReconciled=false`, written by the scoring annotator.
- Reconciled/adjudicated score: `isReconciled=true`, written under the **release owner's** `userId`, with `reconciledFrom` listing the source IDs and `notes` carrying the rationale.

### 1.13 Import
- **`Import`** (`schema.prisma:359`): `projectId`, `filename`, `itemCount`, `skippedCount`. Rolling-upload provenance; duplicates skipped via the `[projectId, feedbackId]` unique constraint.

### 1.14 Escalation
- **`Escalation`** (`schema.prisma:384`): `batchId`, `teamReleaseId`, `feedbackItemId`, `dimensionId`, `escalatedById`, `resolvedById?`, `resolvedAt?`. Unique on `[teamReleaseId, feedbackItemId, dimensionId]`.
- **Per-criterion scope:** escalation is per `(item, dimension)`, *not* per item ("each criterion is standalone"). The adjudicator resolves each by writing an `isReconciled` Score row under the release owner.

### 1.15 Activity tracking (platform time)
- **`ActivityBucket`** (`schema.prisma:419`): `ANNOTATION` (`/evaluate/*`) | `OTHER`.
- **`ActivitySession`** (`schema.prisma:424`): heartbeat-driven session with `startedAt`, `lastHeartbeatAt`, `endedAt?`, `endReason?`. Source of truth for measured time.
- **`ActivityDaily`** (`schema.prisma:444`): per-user-per-UTC-day rollup (`annotationSeconds`, `otherSeconds`); recomputed on heartbeat; overlapping multi-tab/device intervals merged at aggregation. (Secondary feature; covered lightly here.)

### 1.16 IRR (inter-rater reliability)
- Computed by `computeBatchIRRSummary` (`src/lib/irr.ts`). **Exact-match agreement, no tolerance band.** Defined **only for double-scored REGULAR batches**. See §3.G for full semantics. `IRR_READY_THRESHOLD_PCT = 80` (`irr.ts:19`) is a display "ready" flag, **not an automatic gate**.

---

## 2. Actors & Capabilities

Authorization helper: `src/lib/authorization.ts`.
- **`canAdminProject(userId, globalRole, projectId)`** (`authorization.ts:3`): returns true if `globalRole === 'ADMIN'` **or** the user's `ProjectEvaluator.role === 'PROJECT_ADMIN'` for that project. **Hits the DB per request** (not the JWT) so role changes take effect immediately.
- **`isGlobalAdmin(globalRole)`** (`authorization.ts:18`): `globalRole === 'ADMIN'`.
- **`getAdminProjectIds(userId)`** (`authorization.ts:22`): project IDs where the user is `PROJECT_ADMIN`.

### 2.1 Global ADMIN (`User.role = ADMIN`)
**Can:** everything project admins can do, on **all** projects, plus the global-only actions:
- Create projects — `POST /api/projects` (hard `role !== 'ADMIN'` check, `api/projects/route.ts:35`).
- List all projects — `GET /api/projects` (`route.ts:11`).
- Manage user accounts — `/api/users/*`, `/admin/accounts`.
- Send invites — `POST /api/invite`.
- See **all** open escalations system-wide — `GET /api/adjudicate` (`adjudicate/route.ts:24`).
- On sign-in lands on `/admin` (`app/page.tsx:14`).

### 2.2 Project Admin (`ProjectEvaluator.role = PROJECT_ADMIN`)
**Can (only on projects they admin):** rubric view, teams CRUD, batch CRUD, import, assignment, release/unpublish, exports, annotator management, escalation resolution as an implicit admin-for-that-project, set project status. All gated by `canAdminProject(...)`.
**Cannot:** create projects, manage accounts, send invites, see other projects.
**Sign-in landing** (`app/page.tsx:19-21`): exactly **one** admin project → `/admin/[projectId]`; **multiple** → filtered `/admin` list; **zero** → falls through to annotator dashboard.
**Note on adjudicate scope:** a project admin sees, in `GET /api/adjudicate`, escalations where they are the named adjudicator **OR** any escalation in their admin projects (`adjudicate/route.ts:27`).

### 2.3 Annotator / EVALUATOR (`User.role = EVALUATOR`, `ProjectEvaluator.role = EVALUATOR`)
**Can:**
- See only projects they're a member of; with exactly one project they're dropped straight into it — the "projects" concept is hidden (`app/page.tsx:43`, Invariant I-13).
- Score items in batches/releases they're assigned to, while the release is visible + `SCORING`.
- Reconcile discrepancies with their partner for double-scored releases in `RECONCILING`.
- Adjudicate escalations for **other** teams where they are the named `adjudicatorId`.
**Cannot:** access admin routes, see other members' raw scores (the scores GET filters to own `userId` for non-admins, `api/scores/route.ts:37`), see `feedbackSource` or `teacherId` during scoring, score items outside their slot/assignment.

### 2.4 Adjudicator (a role an annotator takes on)
- Not a global/role concept — it is `TeamBatchRelease.adjudicatorId` pointing at any project user (Amber/Rachel or a peer annotator). Set per team release by an admin.
- A user is an adjudicator **for a specific release** when `release.adjudicatorId === user.id`.
- Resolution path: `POST /api/adjudicate` — only the release's `adjudicatorId` (or an admin/project-admin for that project) may resolve (`adjudicate/route.ts:238-245`).
- **Escalation is blocked entirely until an adjudicator is assigned** (`escalate/route.ts:70`, Invariant I-9).

### 2.5 Authorization enforcement summary (where to test)
| Surface | Guard |
|---|---|
| Middleware (all routes) | `src/proxy.ts` + `auth.ts` `authorized` callback (§3.A) |
| Project-scoped API routes | `canAdminProject(...)` at top of handler |
| Global-only API routes | hard `role !== 'ADMIN'` |
| Scores write | project membership + batch/release scoreable state |
| Feedback-items read (annotator) | membership + batch assignment + slot scope |
| Adjudicate | `adjudicatorId` match or admin-for-project |

---

## 3. Flows (step by step) with Invariants

### 3.A Authentication & session
File: `src/lib/auth.ts`.
- **Credentials provider** with two paths in `authorize` (`auth.ts:45`):
  1. **StudyFlow magic-link:** if `studyflow_token` present, verify via `verifyStudyFlowToken` (`auth.ts:7`): JWT verified with `STUDYFLOW_LINK_SECRET`, `maxTokenAge: '10m'`, `issuer: 'studyflow'`, `audience: 'writing-evaluator'`, **must have `exp`**, and **`payload.email` must equal the supplied email**. On success, find-or-create the `EVALUATOR` user, then **auto-assign**: if `project_id` in JWT → upsert `ProjectEvaluator` for that project; else if `study_id` → upsert membership for **every** project with that `studyflowStudyId` (`auth.ts:72-100`).
  2. **Password:** email + bcrypt `compare` against `hashedPassword` (`auth.ts:106`). Email is `trim().toLowerCase()`d (`auth.ts:48`).
- **`authorized` callback** (`auth.ts:119`): public pages = `/login`, `/invite/*`, `/reset-password*`; public API = `/api/auth/*`, `/api/invite/accept`, `/api/reset-password`, `/api/reset-password/accept`, `/api/cron/*`. Logged-in user hitting `/login` is redirected to `/`. Everything else requires a session.
- **JWT/session callbacks** propagate `role` and `id` into the session (`auth.ts:143-156`).
- **Session maxAge:** 8 hours (`auth.ts:163`).
- **Login page** (`app/login/page.tsx`): on `studyflow_token` + `email` query params it auto-signs-in via `signIn('credentials', {... redirect:false})`, then `router.replace('/')` and **strips the token from history** (`login/page.tsx:46-49`); on failure shows manual login and `history.replaceState` to remove the token.

**Invariants to test:**
- A magic-link token whose `email` ≠ supplied email is rejected (`auth.ts:23`).
- A token without `exp` is rejected (`auth.ts:20`).
- A token older than 10 minutes is rejected even if `exp` is far out.
- Wrong `iss`/`aud` rejected.
- Password path: a user with `hashedPassword=null` cannot log in via password (`auth.ts:109`).

### 3.B Admin: create project → import → rubric → teams → batches → release → export

#### Create project
- `POST /api/projects` (global admin only). Creates project in `SETUP` and seeds the rubric from `DEFAULT_RUBRIC` (8 criteria, 0–1 scale) (`api/projects/route.ts:46-66`).

#### Import CSV
- Page guard: `/admin/[projectId]/import` (server) → `ImportClient`.
- Parse: `src/lib/csv-parser.ts` `parseCSV` — quote-aware, handles escaped quotes and multi-line quoted fields, normalizes CRLF/CR → LF, maps headers via `COLUMN_ALIASES` (supports legacy aliases incl. `Prompt_ID → Conjunction_ID`, `Annotator_ID → Teacher_ID`).
- Validate: `validateCSVRow` requires `Student_ID`, `Feedback_ID`, `Feedback_Text`, `Student_Text`; `Feedback_Source`, if present, must be `AI`/`HUMAN` (case-insensitive) (`csv-parser.ts:130`).
- Persist: `POST /api/feedback-items` (`api/feedback-items/route.ts:193`, `canAdminProject` gated):
  - Dedupes against existing `feedbackId`s in the project; inserts only **new** rows; tags new rows with the created `Import.id`; reports `imported`/`skipped`/`total` (`route.ts:229-300`).
  - `displayOrder` continues from current max (rolling-upload semantics, `route.ts:254-258`).
  - `feedbackSource` upper-cased to the enum (`route.ts:283`).

**Invariants:** re-importing the same `Feedback_ID` is skipped and counted in `skippedCount`; import never mutates existing rows; each upload creates exactly one `Import` row even when 0 new items.

#### Rubric config
- Rubric is created on project creation and displayed (read-only in the current Rubric tab — `project-detail-client.tsx:920+` renders labels/score options with no edit/PATCH; **there is no rubric-mutation API route**). Keys are stable. Tests should treat rubric as fixed-after-creation in the current build (a future rename route would need its own spec).

#### Create teams + adjacent criterion pairings
- `POST /api/projects/[projectId]/teams` (`teams/route.ts:47`, `canAdminProject`): body `{ name, memberUserIds[], dimensionIds[] }`.
  - Requires non-empty name, ≥1 member, ≥1 dimension.
  - **Team name unique per project** (409 on dup, `teams/route.ts:90`).
  - **A member may not already be on another team in the project** (409, `teams/route.ts:101`).
  - **A dimension may not already be assigned to another team** (409, `teams/route.ts:123`).
- `PATCH /api/projects/[projectId]/teams/[teamId]` (`teams/[teamId]/route.ts:10`): rename always allowed; **members/dimensions changes blocked once any score exists** for the team's members on the team's dimensions (409, `route.ts:53`). Same cross-team uniqueness checks on the new sets.
- `DELETE` team: blocked if scores exist for its members×dimensions (`route.ts:204`).
- Criterion pairing is **driven by `RubricDimension.sortOrder`** (adjacent criteria), per memory; the team simply holds the dimension set. There is a `scripts/` reorder helper referenced by memory for pairing.

#### Create batches
- `POST /api/projects/[projectId]/batches` (`batches/route.ts:340`, `canAdminProject`). Three creation shapes:
  - **`mode: 'auto'`** (legacy): groups unbatched items by `(activityId, conjunctionId)`, chunks by size (`handleAutoMode`, `route.ts:709`).
  - **TRAINING with `itemIds[]`**: creates a `Training Batch N`, assigns those items, creates a release for **every team**, wires assignments, optionally randomizes display order (`route.ts:381-442`).
  - **REGULAR/TRAINING from feedback-ID `ranges[]`** (`route.ts:444-671`):
    - Items sorted by `compareFeedbackIds` (prefix then numeric then raw, `src/lib/feedback-id.ts`).
    - Each range maps `startFeedbackId`/`endFeedbackId` to indices; **both must exist**, **start ≤ end**, **ranges cannot overlap**, and **no item already in another batch** (each 400, `route.ts:497-552`).
    - `activityId`/`conjunctionId` inferred when all selected items share one value (`inferSharedValue`, `route.ts:673`).
    - `isDoubleScored = REGULAR ? Boolean(body.isDoubleScored) : false` (TRAINING is never double-scored, `route.ts:378`).
    - **Slot split:** for REGULAR non-double, `assignBatchSlots(batch.id)` shuffles items and assigns `slotIndex` 0/1 ~50/50 (`route.ts:614`).
    - A `TeamBatchRelease` is created for every team (`route.ts:618-650`), then `syncBatchAssignmentsForRelease` wires `BatchAssignment` rows.
    - `visibleToTeams` controls initial `isVisible` and `status` (`SCORING` if visible else `DRAFT`).
  - Batch name auto-numbered `Batch N` / `Training Batch N` from `prisma.batch.count`.

**Invariants:**
- Overlapping ranges, missing IDs, reversed ranges, and already-batched items all reject (no partial batch created — validation happens before `batch.create`).
- TRAINING batches never get slots; double-scored batches never get slots; only single-scored REGULAR gets slots.
- Slot assignment is idempotent if all items already have a slot, otherwise re-shuffles the whole batch (`batch-slots.ts:21-23`).

#### Assignment rules per release
Source of truth: `src/lib/team-batch-releases.ts`.
- **`syncBatchAssignmentsForRelease(releaseId)`** (`team-batch-releases.ts:246`): deletes existing assignments for the release, then creates one `BatchAssignment` per expected user; double-scored marks index>0 as `DOUBLE`, else `PRIMARY` (`route.ts:300`); sets `batch.isAssigned=true`; calls `syncBatchStatus`.
- **`getExpectedReleaseUserIds(release)`** (`team-batch-releases.ts:38`):
  - Single named scorer (REGULAR non-double with `scorerUserId` set and on team) → just that user.
  - Otherwise → **all** team members (TRAINING, double-scored, and slot-split all assign every member).
- **`getExpectedScoresPerItemPerDimension(release)`** (`team-batch-releases.ts:83`):
  - TRAINING → `members.length`.
  - Double-scored → 2 (if ≥2 members).
  - Single-scored REGULAR → 1.
- **`getReleaseItemScope(release, userId)`** (`team-batch-releases.ts:61`): `'all'` | `'slot'` (with index) | `'none'`:
  - Single named scorer → `'all'` for the scorer, `'none'` for anyone else.
  - Slot-split → `'slot'` at the member's email-asc index; non-members `'none'`.
  - Otherwise members → `'all'`.
- **`isSlotSplitRelease`** (`team-batch-releases.ts:127`): REGULAR && !double && no `scorerUserId` && ≥2 members.
- **`releaseNeedsReconciliation`** (`team-batch-releases.ts:98`): TRAINING or double-scored.

#### Per-team adjudicator assignment
- `PATCH /api/projects/[projectId]/batches/[batchId]/releases/[releaseId]` (`releases/[releaseId]/route.ts:64`): body may set `isVisible`, `scorerUserId`, `adjudicatorId`.
  - `adjudicatorId`: validated to be an existing user (any project user is allowed, `route.ts:135`). Can be set to `null` to clear.
  - Cannot edit a `COMPLETE` release (400, `route.ts:98`).

#### Per-team single-scorer vs 50/50 slot split
- Same PATCH route: `scorerUserId` only meaningful for REGULAR non-double.
  - `scorerUserId = null` → 50/50 slot split.
  - `scorerUserId = <member>` → single named scorer who sees **all** items; must be a team member (400 otherwise, `route.ts:113`).
  - **Changing scorer assignment after scoring has begun is blocked** (400, `route.ts:124` via `hasReleaseScores`).
- After PATCH, `syncBatchAssignmentsForRelease` + `syncBatchStatus` run (`route.ts:168`).

#### Release / unpublish batch
- `POST /api/projects/[projectId]/batches/[batchId]/release` (`release/route.ts:13`, `canAdminProject`): body `{ release: boolean }`.
  - **Release true:** set `batch.isHidden=false`; every release `isVisible=true`; releases in `DRAFT` → `SCORING` (releases already further along are untouched) (`release/route.ts:57-71`).
  - **Release false (unpublish):** only pull back releases in `SCORING`/`DRAFT` → `isVisible=false`, `status=DRAFT`. **Releases in `RECONCILING`/`COMPLETE` are left untouched** so an in-progress reconciliation can't be yanked (`release/route.ts:73-84`).
  - 400 if the batch has no team releases yet (`release/route.ts:49`).
- Per-release visibility can also be toggled via the release PATCH `isVisible`.

#### Add evaluators / import from StudyFlow / team assignment / make-admin
- `POST /api/projects/[projectId]/evaluators` (`evaluators/route.ts:118`): add a user as `ProjectEvaluator` (409 if already on project).
- `PATCH /api/projects/[projectId]/evaluators/[userId]/role` (`role/route.ts:6`): set `EVALUATOR | PROJECT_ADMIN` for the project. (Note: this route is `canAdminProject`-gated — a project admin can therefore promote/demote within their own project.)
- `PUT /api/projects/[projectId]/evaluators/[userId]/team` (`team/route.ts:17`): set or clear team membership; **blocked if the user already has scores on any involved dimension** (current or destination team) (409, `team/route.ts:93`).

#### Manual project status
- `PATCH /api/projects/[projectId]` (`route.ts:52`): only `studyflowStudyId`, `usePseudonyms`, `status` are settable; `status` ∈ `{SETUP, ACTIVE, COMPLETE}` (`route.ts:73`); `studyflowStudyId` validated `^[a-zA-Z0-9_-]+$` (`route.ts:82`).

#### Exports — see §3.H.

### 3.C Annotator: scoring flow
Pages: `app/evaluate/[projectId]/page.tsx` (server guard) → `evaluate-client.tsx`.
- **Server guard** (`evaluate/[projectId]/page.tsx:22-72`): non-admins must have a `BatchAssignment` for the batch where `(teamReleaseId IS NULL) OR (teamRelease.isVisible AND status='SCORING')`, the batch must not be hidden, and `batch.projectId` must match — else `redirect('/')`. Without `batchId`, requires *some* scorable batch in the project or redirect home.
- **Data fetch** (`evaluate-client.tsx:190`): `GET /api/projects/[id]` (rubric), `GET /api/feedback-items?...` (blinded items), `GET /api/my-team` (team criteria).
- **Criteria selection** (`evaluate-client.tsx:236-244`): if a team exists and batch is **not** TRAINING, the active rubric is filtered to the team's `dimensionIds`; **TRAINING shows all** project dimensions. The full rubric is always preserved for the reference drawer (`fullRubric`).
- **Items are blinded:** `GET /api/feedback-items` selects everything **except `feedbackSource` and `teacherId`** (`api/feedback-items/route.ts:150-188`, comments at 167/172). The client never references `feedbackSource` (verified: no occurrence in `evaluate-client.tsx`).
- **Item scope for annotator** (`feedback-items/route.ts`):
  - With `batchId`: membership + visible assignment required; the release scope is computed via `getReleaseItemScope` — `'none'` → 403, `'slot'` → filter `slotIndex` (`route.ts:73-91`).
  - Without `batchId` (cross-batch): builds a per-batch `OR` over the user's accessible (visible, non-hidden) assignments; slot batches filter by slot; `'none'` batches match nothing (`slotIndex:-1`); **no accessible batch → empty list** (not the whole project) (`route.ts:92-145`).
- **Save** (`evaluate-client.tsx:371,475`): auto-save via `PUT /api/scores` (upsert) and explicit save; advances to next item.
- **Scores write guard** (`api/scores/route.ts` POST/PUT): for batched items, requires project membership, a visible assignment (or project-admin), batch not hidden (or project-admin), and the assignment's release `isVisible && status='SCORING'`; for non-release assignments requires `batch.status='SCORING'`. Each score's `dimensionId` must belong to the project and `value ∈ [scaleMin, scaleMax]` (`route.ts:138-151`).
- **Timing:** `startedAt`/`durationSeconds` recorded per item.

**Invariants:**
- Scoring an item in a non-`SCORING` release/batch → 403 (Invariant I-15).
- Score value outside the dimension's `[scaleMin, scaleMax]` → 400.
- A slot-split annotator never receives items from the other slot (Invariant I-7).
- A non-named-scorer on a single-scorer release receives **zero** items (`'none'` scope, Invariant I-8).

### 3.D Annotator: reconcile (sub-tab "Your team")
Pages: `app/reconcile/[projectId]` → `reconcile-client.tsx`; entry tasks computed in `app/projects/[projectId]/page.tsx:89-114`.
- A reconcile task exists for each of the user's assignments whose release is `RECONCILING`. Discrepancy/resolved counts come from `computeReleaseDiscrepancyStats` (`reconciliation.ts:288`).
- **Discrepancies API:** `GET /api/projects/[projectId]/batches/[batchId]/discrepancies?releaseId=...` (`discrepancies/route.ts`):
  - Annotator must have a `BatchAssignment` for that release (or be project admin) (`route.ts:27-39`).
  - Release must be `RECONCILING` (400, `route.ts:89`).
  - Returns items with **per (item, dimension)** pairs where exactly two distinct members scored; splits into `discrepancies` (values differ) and `agreements` (equal), attaches any open `Escalation`, and reports `hasAdjudicator` + summary counts.
- **Submit reconciliation:** `POST .../reconcile` (`reconcile/route.ts:13`):
  - Auth: assignment on the release **or** project admin.
  - Release must be `RECONCILING` (400).
  - Each score's dimension must be in the release's expected dimension set (TRAINING = all project dims; REGULAR = team dims) and within scale.
  - Writes/updates an **`isReconciled=true`** Score under the **release owner** (`getReleaseOwnerUserId`), with `reconciledFrom` = the two originals' IDs and `notes` = rationale (`route.ts:173-215`).
  - Calls `maybeCompleteReleaseReconciliation` (§3.E).
- **Escalate a criterion:** client `handleEscalate` → `POST .../escalate` (`escalate/route.ts:15`). See §3.F.
- Client treats a dimension as "done" if it has a final value **or** is escalated; escalated dims are excluded from the reconcile POST (`reconcile-client.tsx:344-352`) — the adjudicator writes those.

### 3.E State machines & auto-transitions

#### TeamBatchRelease status: `DRAFT → SCORING → RECONCILING → COMPLETE`
- `DRAFT → SCORING`: on release/publish, or on per-release `isVisible=true` from DRAFT (`release/route.ts:67`, `releases/[releaseId]/route.ts:154`).
- `SCORING → RECONCILING` **or** `SCORING → COMPLETE` (auto): `maybeAdvanceReleaseAfterScore(releaseId)` after each score write (`reconciliation.ts:168`):
  - Only acts if release status is `SCORING` and `isReleaseFullyScored` is true.
  - `isReleaseFullyScored` (`reconciliation.ts:54`): requires `isVisible`; expected count = `items × expectedDims × scoresPerItemPerDim`; counts non-reconciled scores by the expected users/dims; true when `actual ≥ expected`.
  - If `releaseNeedsReconciliation` (TRAINING or double) → set `RECONCILING` **and** `autoReconcileAgreedScoresForRelease` (writes reconciled rows for every agreed (item,dim) — see I-3). Else → `COMPLETE`.
  - Then `syncBatchStatus`.
- `RECONCILING → COMPLETE` (auto): `maybeCompleteReleaseReconciliation(releaseId)` (`reconciliation.ts:195`), called after each reconcile POST and each adjudication:
  - Recomputes discrepant `(item,dim)` keys from originals (two distinct members, differing values).
  - Computes reconciled keys (owner's `isReconciled` rows).
  - **Completes only when every discrepancy has a reconciled row AND there are zero open escalations** (`reconciliation.ts:256-269`). Otherwise no-op.

#### Batch status (derived): `syncBatchStatus(batchId)` (`team-batch-releases.ts:152`)
Given the release statuses:
- no releases → `DRAFT`
- all `COMPLETE` → `COMPLETE`
- any `RECONCILING` → `RECONCILING`
- any `SCORING` → `SCORING`
- else → `DRAFT`
- Also sets `batch.isAssigned = any release status !== 'DRAFT'`.
- Note: the `assign` route additionally flips a `DRAFT` batch to `SCORING` directly on first assignment (`batches/[batchId]/assign/route.ts:69`).

**Invariants:**
- A release with a partner who hasn't finished stays `SCORING` (not enough scores → `isReleaseFullyScored` false).
- A single-scored release goes straight `SCORING → COMPLETE` (no reconciliation) once its single expected score per (item,dim) is present.
- A release with open escalations cannot reach `COMPLETE` even if all non-escalated discrepancies are reconciled (I-10).

### 3.F Escalation & adjudication
- **Create:** `POST .../escalate` (`escalate/route.ts:15`):
  - Auth: assignment on the release **or** project admin.
  - Release must be `RECONCILING` (400).
  - **`release.adjudicatorId` must be set, else 400** with a "no adjudicator assigned" message (Invariant I-9).
  - `feedbackItem` must be in the batch; `dimension` must belong to the project.
  - Creates `Escalation` with `escalatedById = session user`. Duplicate `(release,item,dimension)` → 409 (`escalate/route.ts:131`).
- **Withdraw:** `DELETE .../escalate?releaseId&feedbackItemId&dimensionId` (`escalate/route.ts:143`): only the original escalator or an admin; only while unresolved (resolved → 400).
- **Adjudicate queue:** `GET /api/adjudicate` (`adjudicate/route.ts:12`): open escalations where the user is `adjudicatorId` (admins see all; project admins also see all in their projects). Enriches with both coders' original values + notes and the pair's reconciliation note.
- **Resolve:** `POST /api/adjudicate` (`adjudicate/route.ts:186`): body `resolutions[]`:
  - All referenced escalations must exist and be unresolved (`route.ts:229`).
  - For each, the user must be the release's `adjudicatorId` **or** admin/project-admin for that project (403 otherwise, `route.ts:240`); release must be `RECONCILING` (`route.ts:246`).
  - Value validated against the dimension scale.
  - Writes/updates an **`isReconciled=true`** Score under the **release owner** (with `reconciledFrom` = originals, `notes` = rationale), and marks the escalation resolved (`resolvedById`, `resolvedAt`) in one transaction (`route.ts:295-325`).
  - Calls `maybeCompleteReleaseReconciliation` per release.
- **Adjudication entry from project page** (`projects/[projectId]/page.tsx:117-161`): groups the user's open escalations by release into "as adjudicator" tasks; the project page also surfaces a notification badge/banner.

**Invariants:**
- Escalating before an adjudicator is assigned is impossible (I-9).
- The adjudicator's resolution produces exactly one reconciled row per `(item,dim)`, never overwriting originals (I-1, I-2).
- A non-adjudicator, non-admin cannot resolve another team's escalation (I-16).

### 3.G IRR semantics (`src/lib/irr.ts`)
- **Applicable only** when `batch.type === 'REGULAR' && batch.isDoubleScored` (`irr.ts:87`). Single-scored and TRAINING → not applicable; the summary returns all-null with `isApplicable:false` per team.
- A team release is IRR-applicable only if its team has **exactly 2 members** and **≥1 dimension** (`irr.ts:89-93`).
- **Pre-reconciliation only:** only `isReconciled:false` scores are considered (`irr.ts:138`).
- **Exact match:** for each `(item, dimension)` where **both** members scored, count agreement iff `value[0] === value[1]` (`irr.ts:210-213`). Pairs where only one member scored are ignored (`size !== 2` skip).
- **Per dimension:** `perDimension[]` per team and a **batch-level rollup** aggregating agreed/total across team releases, sorted by `sortOrder`.
- **`agreementPct = round(agreed/total*100)`**, null when total=0.
- **Team "ready"** iff `agreementPct >= 80` (`IRR_READY_THRESHOLD_PCT`) — display flag only, **no automatic gate**; admins decide when to release independent batches (`irr.ts:11-17`).
- **Batch summary:** `applicableTeamCount`, `computedTeamCount` (teams with non-null pct), `readyTeamCount`, `averageAgreementPct` (mean over computed teams), `lowestAgreementPct` (min over computed teams), `perDimension`, `teams`.
- IRR is surfaced in `GET .../batches` only when the batch is double-scored REGULAR and in `SCORING|RECONCILING|COMPLETE` (`batches/route.ts:139`); also fed to admin Overview for the **global rollup**.

**Invariants:**
- IRR ignores reconciled rows (I-5).
- IRR denominator counts only doubly-scored (item,dim) pairs (I-6).
- A team of size ≠ 2 yields `isApplicable:false`, pct null.

### 3.H Export semantics (`src/app/api/export/route.ts`)
- `GET /api/export?projectId&type&format?&activityId?&conjunctionId?&batchId?` — `canAdminProject` gated. `type ∈ {original, reconciled, discrepancies}`.
- **Unblinding:** all export rows include `Feedback_Source` (the AI/HUMAN value) written **raw, not escaped** (`route.ts:248`) — this is the unblinding step (I-11).
- **Original (`type=original`)** (`route.ts:84`): selects **all `isReconciled=false`** scores — one row per `(feedbackItem, evaluator)`, wide format with one column per dimension key. Includes `Score_ID` (synthetic `S001…`), `Evaluator_Email`, `Scoring_Role`, `Team_Name`, `Batch_Name`, `Batch_Type`, dimension columns (labels as headers, values keyed by dimension key), `Notes`, `Timestamp`.
- **Reconciled (`type=reconciled`)** (`route.ts:74-83`): the **final score per item** — `OR(isReconciled=true, (isReconciled=false AND batch is REGULAR non-double))`. I.e. reconciled/adjudicated rows for double-scored & training, **plus the lone original score for single-scored regular** (which never reconciles).
- **Discrepancy report (`type=discrepancies`, requires `batchId`)** (`handleDiscrepancyExport`, `route.ts:286`): groups originals by `(item,dimension)`, emits rows only where **exactly two evaluators disagree**; columns include both evaluators' email/score/notes, the reconciliation note (collapsed per item), and `Difference = |a-b|`.
- **CSV escaping** (`csvEscape`, `route.ts:443`): prefixes a leading `=+-@\t\r` with `'` (formula-injection defense, I-14), and quote-wraps values containing `,`/`"`/newline with `""` doubling. **`Feedback_Source` and numeric scores are intentionally not escaped** (controlled enum/int values).
- Filtering by `activityId`/`conjunctionId` narrows the item set (`route.ts:67-69`).

**Invariants:**
- Original export contains every raw score row (no dedupe across evaluators).
- Reconciled export yields exactly one effective value per `(item,dimension)`: the reconciled/adjudicated row for double/training, the lone original for single-scored.
- Discrepancy export only lists genuine 2-way disagreements.
- A `studentText`/`feedbackText` beginning with `=` is exported with a leading `'`.

---

## 4. Invariants & Edge Cases Tests MUST Guard

These are the high-value, regression-prone properties. Each cites the enforcing code.

- **I-1 Reconciled scores are separate rows that never overwrite originals.** The `Score` unique key includes `isReconciled` (`schema.prisma:348`); reconcile/adjudicate upserts target `isReconciled:true` under the owner (`reconcile/route.ts:187`, `adjudicate/route.ts:296`). Test: after reconciliation, both the two original rows (`isReconciled=false`) and the one reconciled row (`isReconciled=true`) coexist.
- **I-2 Reconciled rows are written under the release owner** = `members[0]` by email asc (`team-batch-releases.ts:118`). Test: owner determinism is stable regardless of who clicked reconcile/escalate.
- **I-3 Auto-reconcile of agreed pairs on entering RECONCILING.** `autoReconcileAgreedScoresForRelease` writes `isReconciled` rows for every `(item,dim)` where the two members agree, noted `"Auto-reconciled (scores matched)"` (`reconciliation.ts:85-166`). Test: agreed dims need no manual action; disagreed dims do not get auto rows.
- **I-4 Auto-reconciled agreed pairs do NOT count toward "X / Y reconciled" progress.** Progress counts only reconciled rows whose key is in the discrepant set (`batches/route.ts:196-202`, `reconciliation.ts:339-353`).
- **I-5 IRR uses pre-reconciliation scores only** (`irr.ts:138`).
- **I-6 IRR denominator = doubly-scored pairs only**; exact match required (`irr.ts:210-213`).
- **I-7 Slot-split annotator sees only their slot's items.** `getReleaseItemScope → slot` and the `slotIndex` filter in feedback-items (`team-batch-releases.ts:69`, `feedback-items/route.ts:88,154`). The other half is invisible.
- **I-8 Single named scorer sees all items; the partner is unassigned and sees none.** `usesSingleScorer` → scorer `'all'`, others `'none'`; `getExpectedReleaseUserIds` returns only the scorer (`team-batch-releases.ts:30,38,67`).
- **I-9 Escalation blocked until an adjudicator is assigned** — 400 with explicit message (`escalate/route.ts:70`).
- **I-10 A release with open escalations cannot reach COMPLETE** even if every other discrepancy is reconciled (`reconciliation.ts:256-269`).
- **I-11 Blinding: `feedbackSource` (and `teacherId`) are excluded from the scoring read API and never referenced in scoring/reconcile/adjudicate UI.** (`feedback-items/route.ts:167,172`; no `feedbackSource` occurrence in `evaluate-client.tsx` / `reconcile-client.tsx` / `adjudicate-client.tsx`.) It appears **only** in export (`export/route.ts:248`).
- **I-12 `project.status` does NOT gate annotator access.** It's set manually and is organizational only (`api/projects/[projectId]/route.ts:71-73` comment + valid set). Access is gated by batch/release visibility + status + assignment, never by project status. Test: a project in `SETUP` or `COMPLETE` with a visible `SCORING` release still lets the assigned annotator score.
- **I-13 The "projects" concept is hidden for single-project annotators.** Exactly one membership → redirect into the project; ADMIN → `/admin`; project-admin(s) → admin views (`app/page.tsx:14-45`).
- **I-14 CSV formula-injection escaping.** Leading `=+-@\t\r` prefixed with `'` (`export/route.ts:445`).
- **I-15 Scoring is rejected unless the batch/release is in a scoreable state.** Hidden batch, missing assignment, or release not (`isVisible && SCORING`) → 403; non-release batch not `SCORING` → 403 (`api/scores/route.ts:119-133`, both POST and PUT).
- **I-16 Adjudication authorization.** Only the release `adjudicatorId` or an admin/project-admin-for-that-project may resolve (`adjudicate/route.ts:240`); withdraw only by escalator or admin (`escalate/route.ts:197`).
- **I-17 CSPRNG shuffles.** Both `assignBatchSlots` (`batch-slots.ts:24`) and `randomizeDisplayOrder` (`batches/route.ts:688`) use `crypto.randomInt` (Fisher–Yates), never `Math.random`.
- **I-18 One team per project / one dimension per team.** Enforced on team create (`teams/route.ts:101,123`), update (`teams/[teamId]/route.ts:79,103`), and membership change (`evaluators/[userId]/team/route.ts`).
- **I-19 Structural edits locked after scoring begins.** Team members/dimensions (`teams/[teamId]/route.ts:53`), team delete (`route.ts:204`), team reassignment (`team/route.ts:93`), single-scorer change (`releases/[releaseId]/route.ts:124`), release delete (`route.ts:201`). Rename is always allowed. Batch type editability is reported via `canEditBatchType = scoreCount === 0` (`batches/route.ts:318`).
- **I-20 Import dedupe & provenance.** Existing `feedbackId`s skipped; only new rows inserted and tagged with the new `Import.id`; counts reported; existing rows never mutated (`feedback-items/route.ts:229-300`).
- **I-21 Batch range validation atomicity.** Overlap / missing-ID / reversed / already-batched all reject **before** the batch is created (`batches/route.ts:497-573`).
- **I-22 Unpublish protects in-progress reconciliation.** `release:false` only pulls back `SCORING|DRAFT` releases; `RECONCILING|COMPLETE` untouched (`release/route.ts:73-84`).
- **I-23 Cross-batch feedback read is scoped to assignments.** An annotator with no accessible batch gets `[]`, never the whole project; `'none'` scopes match nothing (`feedback-items/route.ts:120-145`).
- **I-24 Score value bounds.** Every score (initial, auto-save, reconcile, adjudicate) is validated `value ∈ [scaleMin, scaleMax]` for a dimension that belongs to the project (`scores/route.ts:143-151`, `reconcile/route.ts:147-167`, `adjudicate/route.ts:256-270`).
- **I-25 Magic-link safety.** Token email-binding, `exp` requirement, 10-min max age, `iss`/`aud` checks (`auth.ts:13-30`); token stripped from browser history on the client (`login/page.tsx:46-49`).
- **I-26 Pseudonyms.** When `project.usePseudonyms` is true, partner/coder names render as deterministic pseudonyms via `displayAnnotatorName`/`generateName` (`src/lib/generate-name.ts`); false → real names. Note: blinding of `feedbackSource` is independent of pseudonyms.
- **I-27 Member ordering is email-ascending everywhere** that derives owner/slot/IRR pairing (`orderBy: { user: { email: 'asc' } }` in IRR, reconciliation, slots, releases). Slot index = position in this ordering.
- **I-28 `ensureTeamReleasesForBatch` back-fills missing releases** (hidden, DRAFT) for teams added after batch creation, never removing releases for deleted teams (`team-batch-releases.ts:202-244`).

---

## 5. Test Surface Map (suggested)

**Pure unit (no DB) — highest leverage, matches coverage scope `src/lib/**`:**
- `team-batch-releases.ts`: `usesSingleScorer`, `getExpectedReleaseUserIds`, `getReleaseItemScope`, `getExpectedScoresPerItemPerDimension`, `releaseNeedsReconciliation`, `isSlotSplitRelease`, `getReleaseUserSlotIndex`, `getReleaseOwnerUserId`, `getExpectedReleaseDimensionIds`, `syncBatchStatus` rollup logic (table-driven over status arrays).
- `csv-parser.ts`: quoting, escaped quotes, multi-line fields, header aliasing, `validateCSVRow` required-field + source-enum cases.
- `feedback-id.ts`: `parseFeedbackId`/`compareFeedbackIds` ordering (prefix/numeric/raw, mixed).
- `generate-name.ts`: determinism, pseudonym on/off.
- `export` `csvEscape`: formula-injection + quoting matrix.

**Integration (real DB, opt-in) — state machines & invariants:**
- IRR (`computeBatchIRRSummary`) across the batch-type matrix and team sizes.
- Reconciliation transitions (`maybeAdvanceReleaseAfterScore`, `maybeCompleteReleaseReconciliation`, `autoReconcileAgreedScoresForRelease`) incl. open-escalation blocking.
- Batch creation range validation + slot assignment.
- Scores POST/PUT scoreable-state guards and value bounds.
- Feedback-items blinding + slot/scope filtering.
- Export original/reconciled/discrepancy row semantics + unblinding.
- Escalate/adjudicate authorization + per-criterion uniqueness.
- Auth `authorize` (magic-link + password) and `authorized` route gating.
