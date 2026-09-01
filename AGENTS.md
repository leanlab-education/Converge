# AGENTS.md — Converge

## What This Is

A standalone blinded, rubric-based scoring tool for evaluating written feedback quality (human vs AI-generated). Built for Leanlab's Quill/CZI project. External collaborators (Amber Wang at Quill, CZI) will use this tool.

**Not part of StudyFlow.** This is a separate repo with its own auth, database, and deployment. However, it has a **magic link integration** with StudyFlow — evaluators can launch Converge from a StudyFlow activity and be auto-signed in via a signed JWT.

**Renamed from "Writing Evaluator" to "Converge" (2026-09-01)** — cosmetic/docs done; UI text, emails, production domain, and the JWT `audience` claim are deliberately deferred to October so active users/links aren't disrupted mid-study. See the tracking note in [CLAUDE.md](CLAUDE.md).

## Git Commits

**Never add `Co-Authored-By` lines to commit messages.** Taylor is the sole author.

## Development Philosophy

Same as StudyFlow: **do it right the first time.** No bandaid fixes, no duplicated logic, no silent failures.

**Server/client boundaries matter.** This project was explicitly built with proper Next.js 15 server/client component separation:
- Server components handle auth checks + Prisma data fetching (no loading spinners, no API round-trips for initial page loads)
- Client components handle interactivity (forms, dialogs, scoring UI)
- Pages are thin server wrappers that pass data as props to client components
- Use `router.refresh()` after mutations to re-render server components with fresh data
- Use `<Link>` over `router.push` for navigation in server components

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Database**: Neon PostgreSQL via Prisma v7 + `@prisma/adapter-neon`
- **Auth**: Auth.js v5 (next-auth@beta) with Credentials provider, JWT strategy
- **UI**: Tailwind CSS v4 + shadcn/ui (Base UI)
- **Language**: TypeScript 5

## Commands

```bash
npm run dev          # Start dev server on port 3333 (uses doppler run to inject env vars)
npm run build        # Production build
npm run lint         # ESLint
npx prisma generate  # Regenerate Prisma client after schema changes
npx prisma db push   # Push schema changes to Neon (no migration files)
npx tsx scripts/seed.ts  # Seed admin + test evaluator users

# Running doppler CLI directly (outside npm scripts) requires project/config flags:
doppler run -p writing-evaluator -c dev -- <command>
```

## Database

- **Provider**: Neon (project: `writing-evaluator`, region: `aws-us-east-2`)
- **Host**: `ep-dark-moon-aedx88jy.c-2.us-east-2.aws.neon.tech`
- **DB name**: `neondb`, **User**: `neondb_owner`
- **Connection string**: In `.env` (gitignored)
- **Prisma schema**: `prisma/schema.prisma`
- **Prisma config**: `prisma/prisma.config.ts` (required for Prisma v7 — datasource URL configured here, not in schema)
- **Generated client**: `src/generated/prisma/` (gitignored, regenerate with `npx prisma generate`)

### Prisma v7 Specifics
- The schema's `datasource db` block has NO `url` — the URL comes from `prisma.config.ts`
- `db.ts` uses `@prisma/adapter-neon` driver adapter (NOT the default Prisma engine)
- For standalone scripts, import from `../src/generated/prisma/client.js` (there's no `index.ts`)

### Schema Overview

```
User              — email, hashedPassword, role (ADMIN | EVALUATOR)
Project           — name, status (display-only, derived from batch states)
RubricDimension   — per-project scoring criteria with configurable scales
FeedbackItem      — imported from CSV (studentText, feedbackText, feedbackSource, teacherId, conjunctionId, optimal, feedbackType)
ProjectEvaluator  — M:M join between projects and evaluators
Assignment        — which evaluator scores which items
Batch             — groups of items with status (DRAFT → SCORING → RECONCILING → COMPLETE), type (REGULAR | TRAINING)
BatchAssignment   — evaluator ↔ batch with scoringRole (PRIMARY | DOUBLE)
EvaluatorTeam     — pairs of evaluators assigned to specific rubric criteria
EvaluatorTeamMember    — team ↔ user join
EvaluatorTeamDimension — team ↔ dimension join
Score             — individual dimension scores with timing data
AuthToken         — invite/reset tokens with expiry (type: INVITE | RESET)
```

Key relationships:
- `feedbackSource` is an enum: `AI` or `HUMAN` — hidden during scoring (blinded), revealed only on export
- Rubric dimensions are rows in the DB, not hardcoded columns — fully configurable per project
- `Score` has a unique constraint on `[feedbackItemId, userId, dimensionId, isReconciled]`

## Auth

- **Auth.js v5** with Credentials provider (email + bcrypt password)
- **JWT strategy** (no database sessions)
- **Auth callback** in `auth.ts` protects all routes except `/login`, `/invite/*`, `/reset-password/*`, and specific public API routes (`/api/auth/*`, `/api/invite/accept`, `/api/reset-password/*`)
- **Role check**: Server components use `const session = await auth()` then check `session.user.role`
- **Roles**: `ADMIN` (manages projects, imports data, configures rubrics) and `EVALUATOR` (scores items)
- **Magic link login**: StudyFlow sends users to `/login?studyflow_token=...&email=...` — the login page auto-verifies the JWT and creates/finds the evaluator account
- **Email invite flow**: Admin enters email → Resend sends invite → user clicks link → sets password at `/invite/[token]`
- **Password reset**: Email-based reset link at `/reset-password`

- **Session timeout**: 8 hours (JWT maxAge)
- **Password policy**: Minimum 8 characters
- **Security headers**: CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy (configured in `next.config.ts`)
- **Score validation**: Server-side validation of score values against rubric scale, dimensionId against project, and batch status (must be SCORING or RECONCILING)

### Test Accounts (dev-only — seed script refuses to run in production)
| Email | Password | Role |
|-------|----------|------|
| admin@leanlab.org | admin123 | ADMIN |
| evaluator@test.com | eval123 | EVALUATOR |

## Project Structure

```
src/
├── app/
│   ├── page.tsx                          # Server: evaluator dashboard (redirects ADMIN → /admin)
│   ├── login/page.tsx                    # Client: login form + StudyFlow magic link auto-login
│   ├── invite/[token]/page.tsx           # Client: accept invite + set password
│   ├── reset-password/page.tsx           # Client: request password reset
│   ├── reset-password/[token]/page.tsx   # Client: set new password
│   ├── layout.tsx                        # Root layout with SessionProvider
│   ├── admin/
│   │   ├── page.tsx                      # Server: admin project list + CreateProjectDialog
│   │   └── [projectId]/
│   │       ├── page.tsx                  # Server: project detail → ProjectDetailClient
│   │       └── import/
│   │           ├── page.tsx              # Server wrapper → ImportClient
│   │           └── import-client.tsx     # Client: CSV drag-and-drop import
│   ├── evaluate/
│   │   └── [projectId]/
│   │       ├── page.tsx                  # Server wrapper → EvaluateClient
│   │       └── evaluate-client.tsx       # Client: full scoring interface
│   └── api/
│       ├── auth/[...nextauth]/route.ts   # Auth.js route handler
│       ├── projects/route.ts             # GET (list) / POST (create)
│       ├── projects/[projectId]/
│       │   ├── route.ts                  # GET (detail with rubric) / PATCH (update status)
│       │   ├── evaluators/route.ts       # GET / POST (add evaluator)
│       │   ├── import-evaluators/route.ts # POST (import evaluators from StudyFlow)
│       │   ├── assignments/route.ts      # POST (assign all items to evaluators)
│       │   └── stats/route.ts            # GET (scored item count)
│       ├── feedback-items/route.ts       # GET (by projectId) / POST (bulk import from CSV)
│       ├── scores/route.ts              # GET (by projectId) / POST (save score) / PUT (auto-save upsert)
│       ├── export/route.ts              # GET (CSV export with unblinded feedbackSource)
│       ├── invite/route.ts              # POST (send invite email)
│       ├── invite/accept/route.ts       # POST (accept invite + set password)
│       ├── reset-password/route.ts      # POST (send reset email)
│       ├── reset-password/accept/route.ts # POST (set new password)
│       ├── my-projects/route.ts         # GET (evaluator's assigned projects)
│       └── users/route.ts               # GET (list evaluator users for admin)
├── components/
│   ├── app-shell.tsx                     # Client: sidebar layout wrapper
│   ├── app-sidebar.tsx                   # Client: collapsible left sidebar (replaces NavHeader)
│   ├── create-project-dialog.tsx         # Client: new project form dialog
│   ├── evaluator-dashboard.tsx           # Client: evaluator project cards with progress
│   ├── import-evaluators-dialog.tsx      # Client: import evaluators from StudyFlow
│   ├── project-detail-client.tsx         # Client: project tabs (Overview, Evaluators, Teams, Batches, Rubric, Export)
│   ├── providers.tsx                     # SessionProvider wrapper
│   └── ui/                              # shadcn/ui components
├── lib/
│   ├── auth.ts                           # Auth.js config (providers, callbacks, JWT, magic link verify)
│   ├── db.ts                             # Prisma client with Neon adapter
│   ├── csv-parser.ts                     # CSV parsing + validation for feedback item import
│   ├── email.ts                          # Resend email sending (invites, password reset)
│   ├── studyflow-client.ts              # StudyFlow API client (fetch participants via signed JWT)
│   ├── tokens.ts                         # Auth token creation/verification (invite, reset)
│   ├── rubric-templates.ts               # Default rubric (8 generic criteria, 1-3 scale)
│   └── utils.ts                          # cn() helper
├── types/
│   └── next-auth.d.ts                    # Augments Session type with role + id
└── generated/prisma/                     # Generated Prisma client (gitignored)
```

## Key Workflows

### Admin: Create Project → Import → Configure → Assign
1. Admin creates project at `/admin` → project starts in SETUP status
2. Admin imports CSV at `/admin/[id]/import` — CSV columns: `Response_ID, Student_ID, Cycle_ID, Activity_ID, Conjunction_ID, Student_Text, Feedback_Source, Teacher_ID, Feedback_Text, optimal, feedback_type, Feedback_ID`
3. Rubric auto-created from `DEFAULT_RUBRIC` template (8 generic criteria, 1-3 scale each)
4. Admin creates batches (filtered by activity/conjunction), adds evaluators to batches
5. Batches auto-transition to SCORING when evaluators are assigned — no global "activate" step
6. Admin manages each batch independently: DRAFT → SCORING → RECONCILING → COMPLETE
7. Export CSV at any time, optionally filtered by Activity ID / Conjunction ID

### Evaluator: Score Items
1. Evaluator logs in → sees assigned projects at `/`
2. Clicks "Start Evaluating" → goes to `/evaluate/[projectId]`
3. Split-pane UI: left shows student response + feedback text, right shows rubric scoring
4. Score all dimensions (1-3 scale per dimension) → Save & Continue → auto-advance
5. Navigation: numbered circles show scored / current / unscored (semantic color tokens)
6. Timing: records `startedAt` and `durationSeconds` per item

### Export
- Admin exports CSV from project detail page (Export tab)
- Export **reveals** `feedbackSource` (AI/HUMAN) — this is the unblinding step
- Output columns: all input columns in original order, then `Score_ID, Evaluator_ID, Criterion_1…Criterion_N` (dimension labels as headers)

## Default Rubric

8 generic criteria (`Criterion 1` through `Criterion 8`), all 1-3 scale.
Score labels: 1 = Not Present, 2 = Unclear, 3 = Present.
Criteria may be renamed to project-specific names via the Rubric tab.

## Design System

Full reference: `docs/DESIGN_SYSTEM.md`

**Key rules for all future development:**

1. **Never use hardcoded Tailwind colors** (no `zinc-*`, `blue-*`, `green-*`, etc.) — always use semantic tokens (`text-foreground`, `bg-background`, `text-muted-foreground`) or domain tokens (`bg-status-active-bg`, `bg-score-high-solid`, `text-success`, `text-destructive`)
2. **Status badges**: Import `statusColors` from `src/lib/status-colors.ts` — never define inline
3. **Scoring colors**: Use `getScoreColor()` / `getSelectedScoreColor()` in evaluate-client — they return semantic token classes
4. **Content cards**: Use `bg-content-student-*` / `bg-content-feedback-*` tokens for the split-pane evaluation view
5. **Dark mode is automatic** — just use semantic tokens and it works. Both `:root` and `.dark` are fully defined in globals.css
6. **All interactive elements**: Add `transition-all duration-200`
7. **All authenticated pages** use `<AppShell>` with collapsible sidebar (no NavHeader — it was replaced)
8. **Frosted glass nav**: `bg-background/80 backdrop-blur-lg supports-[backdrop-filter]:bg-background/60 border-b border-border`
9. **Page containers**: Use `py-10` consistent padding
10. **Card hover**: `hover:shadow-sm hover:ring-1 hover:ring-primary/10`

## Environment Variables

**Doppler is the single source of truth.** Project: `writing-evaluator`. Synced to Vercel via Doppler-Vercel integration.

- **Configs**: `prd` → Vercel Production, `stg` → Vercel Preview, `dev` → Vercel Development + local dev (via `doppler run`)
- **Local dev**: No `.env` file needed — `npm run dev` uses `doppler run` to inject secrets
- **To add/change a secret**: Update in Doppler, it auto-syncs to Vercel

```
DATABASE_URL                # Neon connection string
AUTH_SECRET                 # Auth.js session secret
STUDYFLOW_LINK_SECRET       # Shared secret for StudyFlow ↔ Converge JWT signing (same value in both projects)
STUDYFLOW_API_URL           # StudyFlow API base URL (for fetching participants)
RESEND_API_KEY              # Resend email service (invite + password reset emails)
APP_URL                     # This app's public URL (used in email links)
```

## StudyFlow Integration

**Study-specific** — only the Quill - Evaluators study uses this integration.

- **Magic link login**: StudyFlow signs a JWT with `STUDYFLOW_LINK_SECRET` containing `email`, `name`, `project_id`. Converge verifies the JWT at `/login` (requires `exp`, enforces 10-min `maxTokenAge`, validates `issuer: 'studyflow'` + `audience: 'writing-evaluator'`) and auto-creates evaluator accounts. **TODO**: StudyFlow side needs to add `.setIssuer('studyflow').setAudience('writing-evaluator')` to `generateWritingEvaluatorLink()` in `studyflow/src/lib/writing-evaluator.ts` — until then, magic link login will fail.
- **Participant import**: Converge can fetch active participants from StudyFlow via signed JWT to `STUDYFLOW_API_URL/api/studies/{studyId}/participants`. Admin uses "Import from StudyFlow" on the Evaluators tab.
- **Study linking**: Each project has an optional `studyflowStudyId` field (set in Overview tab) that connects it to a StudyFlow study.
- **Shared secret**: `STUDYFLOW_LINK_SECRET` must be the same value in both projects.

## Deployment

- **Platform**: Vercel (project: `writing-evaluator`)
- **Production URL**: `https://writing-evaluator.vercel.app`
- **Env vars**: Managed directly in Vercel (not Doppler — migration pending)

## Security

- **ASVS 5.0 Level 2 audit**: `docs/ASVS-L2-AUDIT-2026-04-06.md` — 65% PASS, 17% FAIL, 11% PARTIAL
- **CSV export**: Formula injection protection in `csvEscape()` (prefixes `=+-@\t\r`)
- **Blinding shuffle**: Uses `crypto.randomInt()` (CSPRNG), not `Math.random()`
- **API authorization**: All endpoints enforce auth at middleware level + role/membership checks per route
- **StudyFlow client**: `studyId` validated against `^[a-zA-Z0-9_-]+$` to prevent path traversal

## Remaining TODO

- [ ] Connect to Replit for non-engineer access
- [ ] **StudyFlow JWT iss/aud**: Add `.setIssuer('studyflow').setAudience('writing-evaluator')` to StudyFlow's `generateWritingEvaluatorLink()` — required before deploying this branch
- [ ] **Rubric editing UI**: Add an admin flow to create/edit/import a project-specific rubric in the UI so future users can configure criteria and answer options without code changes
- [ ] **MFA**: Build opt-in TOTP (deferred — ASVS L2 requirement, planned as opt-in per user)
- [ ] **Rate limiting**: Add to login, password reset, invite endpoints (use `@upstash/ratelimit` or similar)
- [ ] **Server-side logging**: Add pino with security event coverage (auth, authz failures, exports)
- [ ] **Audit logging**: AuditLog model for export/unblinding events and admin actions
- [ ] **Token revocation**: Add `tokenVersion` to User model for JWT invalidation on password change/account disable
- [ ] **Common password check**: Check against top 3000 passwords on password set
- [ ] **Breach password check**: HIBP k-anonymity API integration

## People

- **Taylor Haun** — building this tool (taylorhaun@leanlabeducation.org)
- **Amber Wang** — lead researcher for Quill/CZI studies (amberwang@leanlabeducation.org)
- **Katie Boody Adorno** — CEO, signs contracts (katie@leanlabeducation.org)
