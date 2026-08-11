# Writing Evaluator

A blinded, rubric-based scoring tool for evaluating written feedback quality — built by [Leanlab Education](https://leanlabeducation.org) for research comparing human- and AI-generated feedback (the Quill/CZI rapid-cycle evaluation).

Annotators score student-feedback pairs against a configurable rubric without knowing whether the feedback came from a human or an AI. Admins manage projects, batches, double-scoring, reconciliation, and unblinded exports.

## How it works

1. **Import** — an admin uploads a CSV of feedback items (student text + the feedback being evaluated + a hidden `Feedback_Source` of `AI` or `HUMAN`).
2. **Configure** — each project gets a rubric of scoring criteria (fully configurable rows in the DB, not hardcoded), annotator teams, and batches of items.
3. **Score (blinded)** — annotators work through batches in a split-pane UI: student response and feedback on the left, rubric on the right. The feedback source is never shown. Batches can be **double-scored**: both members of a team score every item independently.
4. **Reconcile** — for double-scored batches, pairs resolve scoring disagreements item by item. Disagreements a pair can't settle are **escalated** to an assigned adjudicator whose decision is final. A concede-or-escalate rule prevents one annotator from silently "resolving" a disagreement by re-picking their own score: resolving it yourself always means conceding to your partner, and every reconciliation records who performed it.
5. **Export (unblinded)** — admins export CSVs that reveal `Feedback_Source`: raw scores per scorer (for inter-rater reliability), final scores per scorer, one collapsed row per item, or a discrepancy report. Per-criterion IRR is computed in-app.

Other features: per-batch locking (admin freeze), per-criterion re-opens for re-scoring, training batches for calibration, email invites and password resets, optional magic-link SSO from Leanlab's StudyFlow, project-scoped admin roles.

## Tech stack

- [Next.js 16](https://nextjs.org) (App Router) + TypeScript + Tailwind CSS v4 + [shadcn/ui](https://ui.shadcn.com)
- PostgreSQL ([Neon](https://neon.tech)) via Prisma v7 with the Neon driver adapter
- [Auth.js v5](https://authjs.dev) (credentials + JWT sessions)
- [Resend](https://resend.com) for transactional email
- [Vitest](https://vitest.dev) for tests
- Deployed on [Vercel](https://vercel.com); secrets managed with [Doppler](https://doppler.com)

## Getting started

Prerequisites: Node 20+, a Postgres database (Neon or any Postgres), and the [Doppler CLI](https://docs.doppler.com/docs/install-cli) (or export the env vars yourself).

```bash
npm install
npx prisma generate        # generate the Prisma client (src/generated/prisma/)
npx prisma db push         # push the schema to your database
npx tsx scripts/seed.ts    # seed an admin + test evaluator (dev only — refuses to run in production)
npm run dev                # start the dev server (wraps `next dev` in `doppler run`)
```

Required environment variables (names only — values live in Doppler/Vercel, never in the repo):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `AUTH_SECRET` | Auth.js session secret |
| `RESEND_API_KEY` | Invite + password-reset emails |
| `APP_URL` | Public URL used in email links |
| `STUDYFLOW_LINK_SECRET` | (Optional) shared secret for StudyFlow magic-link SSO |
| `STUDYFLOW_API_URL` | (Optional) StudyFlow API base URL for participant import |

Useful commands:

```bash
npm run build       # production build
npm run lint        # ESLint
npx vitest run      # test suite
```

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — the working reference: architecture, schema overview, auth model, workflows, and project conventions
- [`docs/SPEC.md`](docs/SPEC.md) — behavioral specification
- [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) — UI tokens and design rules
- [`docs/QUILL_CZI_DATA_MAP.md`](docs/QUILL_CZI_DATA_MAP.md) — how imported/exported columns map to the study's data

## Security notes

- Feedback source is blinded end-to-end during scoring; unblinding happens only at export, by admins.
- The batch blinding shuffle uses a CSPRNG (`crypto.randomInt()`), not `Math.random()`.
- CSV exports guard against formula injection.
- All API routes enforce authentication middleware plus per-route role/membership checks; see `docs/ASVS-L2-AUDIT-2026-04-06.md` for the most recent security audit.
