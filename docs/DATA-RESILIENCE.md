# Data Resilience & Backup Strategy — Writing Evaluator

> **Why this matters more than usual.** This app is a *labeling pipeline*. Its
> annotations are paid-for, human-generated gold data used to build and validate
> CZI's LLM-as-judge evaluators (Quill July GA) and to compare AI vs. human
> feedback. The data **cannot be cheaply regenerated** — people were paid to
> produce it. Losing it breaks the deliverable and the research. Treat the
> dataset as the crown jewel, not the code.

## What's at risk (in priority order)

1. **`Score` rows — especially reconciled/adjudicated finals** (`isReconciled=true`). The actual paid labels. Irreplaceable.
2. **`FeedbackItem`** — the source data (re-importable from the original CSVs, but provenance matters).
3. **Structure & provenance** — `EvaluatorTeam`, `Batch`, `TeamBatchRelease`, `Escalation`, `BatchAssignment`, rubric (`RubricDimension`). Needed to interpret the labels.
4. **Roster / accounts** — `User`, `ProjectEvaluator`.

## Recovery objectives (targets)

- **RPO (max tolerable data loss): ~0** for Score data. Every annotation is paid for; we want continuous protection, not nightly-only.
- **RTO (max tolerable downtime): hours, not days.** A stuck pipeline costs annotator time and momentum.

## Strategy: 3-2-1 + air gap (defense in depth)

≥3 copies, ≥2 storage types, ≥1 **independent/offsite**, plus 1 **offline/air-gapped** cold copy. Independence is the point — a copy inside the same Neon account does not survive account loss, accidental project deletion, or a compromised credential.

| # | Layer | Protects against | Mechanism | RPO | Status |
|---|-------|------------------|-----------|-----|--------|
| 1 | **Neon PITR** | accidental writes/deletes, bad migration | Neon history retention (LSN-granular, restore in seconds) | ~0 within window | enable |
| 2 | **Neon Snapshots** | longer-lived recovery beyond PITR window | scheduled snapshots (paid plans) | per schedule | enable |
| 3 | **Offsite logical dump** | Neon-level disaster, account loss, region outage | `pg_dump` → versioned + object-locked bucket in a **separate cloud account** | nightly (or hourly) | build |
| 4 | **Deliverable export archive** | schema corruption; "just give me the labels" | auto-archive the app's CSV exports (original/reconciled/discrepancy) | per schedule/release | build |
| 5 | **Offline air-gapped copy** | total cloud loss, credential compromise, ransomware | encrypted external drive, refreshed per milestone | per milestone | manual |
| 6 | **Guardrails** | self-inflicted loss (the most common cause) | soft-deletes, audit log, migrations, locked-down destructive access | n/a | build |

### Layer details

**1. Neon PITR.** Move off Free (6h/1GB) to a paid plan and set retention to the max your plan allows — **Launch = 7 days**, **Scale = 30 days**. Given the data is irreplaceable, **Scale / 30-day** is the recommendation; Launch / 7-day is the acceptable minimum. Restores are LSN-granular and take seconds. (Neon: [PITR](https://neon.com/blog/announcing-point-in-time-restore), [plans](https://neon.com/docs/introduction/plans).)

**2. Neon Snapshots.** Enable scheduled snapshots (weekly; retain ~3 months) for recovery points beyond the rolling PITR window, without it counting against manual-snapshot limits. (Neon: [Snapshots](https://neon.com/blog/announcing-neon-snapshots-a-smoother-path-to-recovery).)

**3. Offsite logical dump — the real redundancy.** A scheduled job runs `pg_dump` and writes a compressed dump to a bucket **in a different account/cloud** (e.g. AWS S3 or GCS), with **object versioning + object lock / WORM** so backups can't be overwritten or deleted (even by our own credentials) within the retention window. Rotation: GFS — keep ~30 daily, 12 weekly, 12 monthly. Implementation options: a scheduled GitHub Action, a small Cloud Run / Lambda cron, or Neon's own [pg_dump automation](https://neon.com/docs/manage/backup-pg-dump-automate). Encrypt in transit and at rest. (Neon: [backups overview](https://neon.com/docs/manage/backups).)

**4. Deliverable export archive.** The app already produces the canonical CSVs (the research deliverable). Archive them automatically (nightly, and/or on batch completion) to the same/another immutable bucket. These are schema-independent and human-readable — the most robust "even if everything else is gone" copy of the labels.

**5. Offline air-gapped copy.** A **modest, encrypted** external drive (the data is small — capacity is not the point; the air gap is). Refresh on a cadence tied to value created — **per cohort milestone / monthly** — by copying the latest `pg_dump` + CSV exports onto it, then disconnecting and storing it physically separate. Encrypt at rest (FileVault / VeraCrypt / LUKS) — it holds student writing + the dataset. This is cold, worst-case insurance, **not** the primary RPO mechanism (it depends on human discipline). Keep a couple of rotating generations.

**6. Guardrails against self-inflicted loss** (statistically the likeliest cause):
- **Soft-delete** high-value rows (Score, FeedbackItem) — mark deleted instead of hard-deleting, so in-app mistakes are recoverable.
- **Audit log** for exports/unblinding and destructive admin actions (already a known TODO).
- **Reviewed migrations.** The project currently uses `prisma db push` (no migration files) — risky in production (an unreviewed schema change can drop/alter data). Move to `prisma migrate` with reviewed migration files before heavy production use.
- **Lock down destructive access**: separate prod credentials, protect the Neon project from deletion, no casual `--force-reset`.

## Restore runbook

> A backup you have never restored is a hope, not a backup.

- **Accidental write/delete (most common):** Neon PITR/branch-restore to the timestamp just before the incident; verify row counts/checksums on a branch first, then promote. Seconds–minutes.
- **Schema corruption / bad migration:** restore latest good Neon snapshot or PITR point; if logical needed, restore the most recent `pg_dump` into a fresh Neon branch/DB and re-point the app.
- **Neon account/region loss:** provision a new Postgres, `pg_restore` the latest offsite dump, re-point `DATABASE_URL`. RTO ≈ time to restore a small dump (minutes).
- **Total cloud loss / "everything is gone":** restore from the offline drive's latest `pg_dump`; worst case, reconstruct labels from the archived CSV exports.

**Verification after any restore:** compare `SELECT count(*)` per critical table and a checksum of `Score` (esp. `isReconciled=true`) against the last known-good backup manifest.

## Restore drills

Run a restore drill **quarterly and before each major cohort milestone**: restore the latest offsite dump into a throwaway branch, run the verification checks, time it (record actual RTO), and update this runbook with anything that surprised you.

## Phased rollout

**Upfront (this week — cheap, high-leverage):**
- Neon → paid plan, max PITR retention (Scale/30d recommended), enable scheduled snapshots.
- Stand up the offsite `pg_dump` → versioned + object-locked bucket (separate account). Nightly to start.
- Buy + encrypt the offline drive; take the first cold copy.

**Soon (this hardening push):**
- Auto-archive CSV exports to immutable storage.
- Guardrails: soft-delete for Score/FeedbackItem; AuditLog for export/unblinding/destructive actions.
- First restore drill + record RPO/RTO.

**Ongoing:**
- Move to reviewed Prisma migrations.
- Quarterly restore drills; refresh the offline drive each milestone.

## Sources
- Neon PITR: https://neon.com/blog/announcing-point-in-time-restore
- Neon Snapshots: https://neon.com/blog/announcing-neon-snapshots-a-smoother-path-to-recovery
- Automate pg_dump: https://neon.com/docs/manage/backup-pg-dump-automate
- Backups overview: https://neon.com/docs/manage/backups
- Plans/retention: https://neon.com/docs/introduction/plans
