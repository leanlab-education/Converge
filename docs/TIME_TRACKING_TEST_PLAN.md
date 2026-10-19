# Time tracking — manual test plan

Purpose: validate that the platform's measured annotator time is accurate enough to spot-check against annotator self-reports. The goal isn't second-perfect — it's "ballpark close" so a 40h self-report vs 7h measured would be a clear flag.

## Setup

**Two people:**
- **Annotator** — logged in as a real annotator account, in a normal browser window. Has a real assigned batch with scoring work to do.
- **Observer** — logged in as admin in a separate browser (or a private window). Sits on the project's **Annotators** tab and refreshes between checks.

**Tools:** stopwatch (phone is fine). A blank notepad to log results.

**Before starting:** Observer notes the annotator's current "All time" hours in the Time column. That's the baseline — every test value below is measured *relative* to this baseline.

**Time required:** ~90 minutes for the full plan. Tests 1–3 + 7 take ~30 min and cover the most important cases.

**Expected variance:** measured time may be **up to ~20 seconds short** of stopwatch on any single test (heartbeats fire every 20s, so the tail of a session can be lost). Don't sweat sub-minute differences. **More than 10% off is the threshold worth flagging.**

**How time is booked (the rules the tests below check):**
- A session is open while the tab is visible and there has been mouse/keyboard/scroll input in the last 5 minutes. The browser sends a heartbeat every 20s.
- A session can never be booked more than **~30 seconds past its last heartbeat** (one heartbeat interval plus grace). Closing the laptop lid, or a frozen tab, therefore adds at most ~30s — never the whole gap.
- When the tab goes idle (5 minutes with no input), the session is booked back to the **last input event**, so the idle minutes themselves don't count. Tracking resumes on the first mouse move / key press after the pause.
- "Annotating" covers every page where review work happens: scoring (`/evaluate`), pair reconciliation (`/reconcile`), adjudication (`/adjudicate`) and re-opened-criterion revision (`/revise`). Everything else authenticated is "Other".
- Two tabs open at once never double-count: overlapping time is merged per bucket.

---

## Test 1 — Basic annotation accuracy (10 min)

**Goal:** time spent inside the annotation interface is measured correctly.

1. Annotator: log in, navigate to a batch's evaluate page, start the stopwatch.
2. Score items continuously for **10 minutes**. Move the mouse / type normally.
3. Stop the stopwatch when 10:00 is up. Click somewhere outside the annotation interface (e.g. back to "My Projects") so the session closes cleanly.
4. Observer: switch period to **This week**, refresh, note the new Time value.

**Expected:** new Time minus baseline ≈ **10:00 ± 30 seconds**. Hover the Time cell — the tooltip should show essentially all of it under "Annotating", with "Other" near 0.

**Fails if:** off by more than 1 minute, OR the time landed in "Other" instead of "Annotating".

---

## Test 2 — Other-platform time bucketing (5 min)

**Goal:** time on the rest of the platform (dashboard, batches view, etc.) lands in the "Other" bucket, not "Annotating".

1. Annotator: log in but **don't enter the annotation interface**. Start stopwatch.
2. Spend **5 minutes** clicking around the dashboard / batch list / project view. Don't open any annotation page (`/evaluate`, `/reconcile`, `/adjudicate`, `/revise`) — those all count as Annotating.
3. Log out.
4. Observer: refresh the Time cell. Hover for the tooltip.

**Expected:** "Annotating" is unchanged from baseline. "Other" is up by **~5 minutes ± 30s**.

**Fails if:** dashboard time shows up under "Annotating", or "Other" is significantly off.

---

## Test 3 — Walking away (idle handling) (10 min)

**Goal:** the system stops counting when the annotator is genuinely idle, even if the tab stays open.

1. Annotator: open the evaluate page, start stopwatch, score for **2 minutes**.
2. **Stop touching the keyboard and mouse for 8 minutes**. Leave the tab open and visible. Don't move the mouse, don't scroll. Set a separate timer so you don't go over.
3. After 8 idle minutes, score for **2 more minutes** of active work.
4. Stop. Total wall time: 12 min. Total *active* time: 4 min.
5. Observer: refresh the Time cell.

**Expected:** measured annotation time is **~4 minutes ± 1 minute**, NOT 12.

**Fails if:** measured time is closer to 12 min than 4 min — that means idle isn't being detected.

**Note:** the idle threshold is 5 minutes of no input. Once the tab is declared idle, the session is booked back to the **last input event**, so none of the 8 idle minutes count — not even the first 5. Tracking resumes on the first mouse move / key press, so the second 2-minute block starts counting right away. Expect ~4:00, with the usual ±20s per session boundary.

---

## Test 4 — Tab in background (5 min)

**Goal:** switching to another tab pauses tracking. Switching back resumes.

1. Annotator: open the evaluate page, start stopwatch, score for **1 minute**.
2. Switch to a **different browser tab** (Gmail, Google, anything). Wait **3 minutes**.
3. Switch back. Score for **1 more minute**.
4. Stop. Wall time: 5 min. Active time: 2 min.
5. Observer: refresh the Time cell.

**Expected:** measured time is **~2 minutes ± 30s**.

**Fails if:** closer to 5 min — tab-hidden detection is broken.

---

## Test 5 — Two tabs open at once (5 min)

**Goal:** opening the evaluate page in two tabs at once doesn't double-count.

1. Annotator: open `/evaluate/<project>` in **Tab A**.
2. Open the same URL in **Tab B**. Both tabs are loaded.
3. Switch back and forth, scoring in whichever tab is visible. Spend **5 minutes total** wall time, with both tabs alive the whole time.
4. Close both tabs.
5. Observer: refresh the Time cell.

**Expected:** measured time is **~5 minutes ± 30s** — NOT 10 minutes (which would mean we're summing both tabs).

**Fails if:** closer to 10 min — multi-tab dedup is broken.

---

## Test 6 — Bucket transitions during a session (5 min)

**Goal:** moving between annotation interface and the rest of the platform splits time correctly.

1. Annotator: log in, sit on the dashboard for **1 minute**.
2. Click into `/evaluate/<project>`, score for **2 minutes**.
3. Navigate back to the dashboard. Sit there for **1 minute**.
4. Log out.
5. Observer: refresh, hover the tooltip.

**Expected:** "Annotating" ≈ **2 min**, "Other" ≈ **2 min**. (The transition click counts as a heartbeat boundary; expect ±20s on each.)

**Fails if:** the split is dramatically off (e.g. annotation shows 4 min and other shows 0).

---

## Test 7 — End-to-end realistic session (30 min)

**Goal:** the most important test. Mimic a real annotator's session and see how close measured comes to actual.

1. Annotator: start a stopwatch. Work like a real annotator for **30 minutes**:
   - Log in, look at the dashboard
   - Click into a batch, score items
   - Take **one ~3-minute break** (close laptop / walk away — be honest about how long)
   - Come back, finish scoring
   - Log out
2. Throughout, keep an honest mental note of how much was *active scoring* vs *active dashboard* vs *break*. Write those down at the end.
3. Observer: pull up the Time cell tooltip after the session.

**Expected:** measured "Annotating" + "Other" is within **±10% of (wall time − break time)**. Annotating share roughly matches your mental note. A closed-lid break adds at most ~30 seconds (the session is capped one heartbeat past its last one); a walk-away break with the tab visible is cut back to your last input once the 5-minute idle threshold passes.

**Fails if:** off by more than 15%, or the annotation/other split feels obviously wrong.

This is the test that most resembles real billing-verification use.

---

## Test 8 — Period filters (1 min)

**Goal:** sanity-check the This week / This month / All time toggle.

1. Observer: with cumulative test data on the annotator's row, switch periods and note the value at each.
2. Verify: **This week ≤ This month ≤ All time**, always.

**Fails if:** a narrower period shows more time than a wider one — that's a bug.

---

## Test 9 — Browser crash / force-close (optional — 8 min)

**Goal:** if the browser dies without a clean logout, the orphaned session is closed by the server and booked through its last heartbeat — no more, no less.

The server closes any session whose last heartbeat is more than 2 minutes old in two places: the moment that annotator is next active *anywhere* on the platform (their first heartbeat sweeps their own stale sessions), and a daily backstop sweep at 04:00 UTC.

1. Annotator: open the evaluate page, score for **2 minutes**, then **force-quit the browser** (Cmd+Q, kill from Activity Monitor, etc.) — no clean logout.
2. **Wait at least 3 minutes** without doing anything else.
3. Annotator: log back in, go to the dashboard (that first page load is what closes the orphan).
4. Observer: refresh the Time cell.

**Expected:** the 2-minute session shows up at ~2:00 ± 20s — it must not keep growing while the browser was dead, and it must not be missing.

---

## Test 10 — Laptop sleep with the tab open (optional — 15 min)

**Goal:** closing the lid doesn't book the sleep as work.

1. Annotator: open the evaluate page, start stopwatch, score for **2 minutes**.
2. **Close the laptop lid** (or sleep the machine) for **10 minutes**. Leave the tab open.
3. Open it, score for **1 more minute**, then click back to "My Projects".
4. Observer: refresh the Time cell.

**Expected:** ~**3 minutes ± 1 minute**, NOT 13. The pre-sleep session is capped ~30 seconds past its last heartbeat regardless of when the browser wakes up and reports it.

**Fails if:** closer to 13 min — the end-of-session clamp isn't working.

---

## Test 11 — Reconciliation counts as Annotating (5 min)

**Goal:** paid review work outside the scoring screen lands in "Annotating", not "Other".

1. Annotator (one who has a reconciliation or revision task): start stopwatch, open the reconcile page and work on discrepancies for **3 minutes**. Then go back to the dashboard for **1 minute**.
2. Observer: refresh, hover the tooltip.

**Expected:** "Annotating" up by **~3 min**, "Other" up by **~1 min**.

**Fails if:** the reconcile minutes show under "Other".

---

## What to write down

For each test, note:
- Stopwatch / actual minutes
- Measured annotation minutes
- Measured other minutes
- Pass / fail
- Any weirdness

Anything off by **>10%** is worth flagging to Taylor with a screenshot of the tooltip and a description of what you did.

---

## What we're explicitly NOT testing here

- **Self-reported time vs measured** — that comparison is the *purpose* of this whole system; the test plan only validates that measured numbers are reasonable, not that annotators report correctly.
- **Per-item time** — we removed it; the tool only tracks platform-level time now.
- **Time on login / password-reset / invite pages** — those are unauthenticated and intentionally not tracked.
- **Window blur with tab still visible** — if you click on a Slack window while the evaluate tab stays visible behind it, time *keeps counting*. This is intentional (people glance at notes briefly), so don't flag it as a bug.
