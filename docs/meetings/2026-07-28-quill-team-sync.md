# Impromptu Zoom Meeting — Taylor, Fiona, Amber — July 28, 2026

**Recording:** https://fathom.video/share/bQY7Vyw5hftR_G4erZk-Wo6zpxkAWGE5 (22 min)

> Weekly Quill/CZI sync. The Writing Evaluator ask is at **7:02–13:05**: Amber
> wants a **new export type** that collapses scores to one row per `Feedback_ID`
> with the eight criterion scores as columns, for clean handoff to CZI. She
> screen-shared the current export (`scores-reconciled-2026-07-27`) and sent her
> hand-cleaned target template afterward:
> **`scores_reconciled_feedback_level_COLLAPSED.xlsx`**
> ([Drive](https://docs.google.com/spreadsheets/d/1x0RZtCzwzQgEqLqmnmdxG0CB6EdCYVQe/edit)).

---

## Action item for Writing Evaluator

### New export type: "Collapsed / Final Scores by Feedback_ID"

**Does not replace the existing exports.** Amber was explicit: "I still want
this. So it's not about changing the existing option." This is a *third* option
alongside Original and Reconciled.

**Shape:** one row per `Feedback_ID`, with each criterion's **final** score as
its own column (8 columns for the Quill rubric).

Today's Reconciled export emits *multiple* rows per `Feedback_ID` because rows
are keyed by `(feedbackItem, user)` — and with per-criterion team pairing, two
teams × two scorers means up to **4 rows per Feedback_ID**, each with only that
team's criteria populated. Amber's screenshot shows exactly this: F001 → S001–S004,
four evaluator emails, all "Scorer A"/"Scorer B". The new export merges those
across teams and scorers into a single row.

**"Final" score per criterion means:**
- double-scored batch → the reconciled value, or the adjudicator's value if it
  was escalated (Amber: "it would need to pull in either the final reconciled
  score if they agree or the adjudicator's score" — "we only really want that
  final answer");
- non-double-scored regular batch → the lone score.

**Target header row — verbatim from `scores_reconciled_feedback_level_COLLAPSED.xlsx`:**

```
Response_ID  Student_ID  Cycle_ID  Activity_ID  Conjunction_ID  Student_Text
Feedback_Source  Teacher_ID  Feedback_Text  optimal  feedback_type  Feedback_ID
Batch_Name  Batch_Type  Double_Scored
Manageable  ActionableRevision  AppropriateFeedbackDecision  NotAnswerGiving
TaskAlignedRevision  AnchoredinStudentResponse  AcknowledgesStrength  EmotionalPitch
```

That is A–L = item columns, **M/N/O = `Batch_Name`, `Batch_Type`, `Double_Scored`**,
**P–W = the 8 criteria**. The "columns P through W are all complete" line at 11:06
in the transcript lines up exactly with this layout.

**⚠️ Conflict to resolve with Amber:** her written notes list `Batch_Name`,
`Batch_Type`, and `Double_Scored` under "can drop," but she **kept all three** in
the actual file. The rest of the drop list is consistent with the file.

**Columns DROPPED in the file** (scorer/team-specific — meaningless once collapsed):
`Score_ID`, `Evaluator_Email`, `Scoring_Role`, `Team_Name`, `Notes`, `Timestamp`.

**Criterion column headers:** she uses de-spaced/shortened names
(`ActionableRevision`, `AnchoredinStudentResponse`, `EmotionalPitch`) — almost
certainly Stata-safe variable names she produced during cleaning, not what the
tool should emit. Live rubric labels are `Manageable`, `Actionable Revision`,
`Appropriate Feedback Decision`, `Not Answer Giving`, `Task Aligned Revision`,
`Anchored in Student Response`, `Acknowledges Strength`,
`Appropriate Emotional Pitch` (see `scripts/reorder-rubric-pairs.ts`). Column
**order matches** the live `sortOrder` exactly. Values are the 0/1 V12 scale.

### Nice-to-haves for this export type

1. **Export by Activity ID** — a dropdown, not a range. "Just pull activity one,
   which is all AI robots." (Note: the Export tab already has Activity /
   Conjunction filters; they need to apply to the new type too.)
2. **Export only feedback with a full set of scores** — "where columns P through W
   are all complete." Amber also framed this as batch-level: "only export the
   batches that are actually, like, complete, like, totally finalized across.
   Everyone did their reconciliations, adjudicators adjudicated if need be, and
   it's, like, closed out."

### Praise for existing behavior (keep it)

Amber called out that the current Reconciled export "tells you it pulled in the
auto-reconciled score. It verified that." Don't lose that in the new type.

### Resolved spec (Taylor's decisions, 2026-07-28)

- **Keep** `Batch_Name`, `Batch_Type`, `Double_Scored` — the file wins over the
  written notes. Column layout is exactly as in her template (criteria at P–W).
- **Criterion headers use the live rubric labels** (with spaces:
  `Actionable Revision`, `Appropriate Emotional Pitch`, …), consistent with the
  Original and Reconciled exports. Amber renames for Stata on her end as she
  already does.
- **Two independent completeness toggles**, not one:
  1. *Only items with a full set of scores* — all 8 criteria have a final value.
  2. *Only fully finalized batches* — every team/annotator done, all
     reconciliations and adjudications resolved and closed out.
- **Default scope (both toggles off):** only items in **released** batches.
  DRAFT/unassigned batches are excluded entirely; released-but-unscored items
  appear as rows with blank criterion cells.
- Activity / Conjunction filters on the Export tab apply to this type too.

### As built (2026-07-28)

The Export tab was reorganized rather than given a fourth card. The three score
tables differ only in row grain and raw-vs-final, so they became one question
with three answers, with the scope controls moved *inside* the block they govern
(previously the Activity/Conjunction filters floated above three cards and only
two of them honoured it). The Discrepancy Report is a different kind of artifact
— per-criterion, batch-scoped — so it keeps its own section.

Verified byte-identical to the previous output for both legacy export types
across all three projects on live data, including the 7,220-row / 3.7 MB Quill
files. Legacy `type=original` / `type=reconciled` URLs still resolve.

See the Export section of `CLAUDE.md` for the full contract.

### Timeline

Taylor: "I think I can do it this week." Amber will export for real once
annotators finish Activity 1 (AI Pet Robots) — hoping **~August 7**.

---

## Other notes from the call

- **Annotation status:** 43 batches released, covering two Quill activities. Most
  annotators still on "AI Pet Robots"; some have started the next activity. A few
  are falling behind (likely vacation / back-to-school). Reliability on
  double-scored batches "still looks great."
- Amber will upload + batch the **third Quill activity** later this week.
- **Feedback writing:** 5 individuals still pending (excluding Kim Zajac, presumed
  out). If they finish → ~6,700 feedback items. CZI is OK proceeding with the
  current volume; can ask Quill for extant data if more is needed.
- **Payments:** feedback writers paid at end of July; annotators paid once in
  August for July work, then again in the fall. School-partner Stripe payouts done;
  checks pending Michelle's confirmation.
- **Rapid Cycle Playbook:** initial draft done, Rachel reviews Monday; written
  product-agnostic. Annotation platform likely gets a light callout in the Rapid
  Cycle doc and fuller treatment in the Field-Ready case study — Taylor to supply
  a short write-up + link to the repo when Amber lands the final structure.

---

## Written notes (verbatim, from the shared doc)

* AW - request for additional export/data pull type on annotation platform
   * "Collapse" scores by Feedback_ID (i.e., each Feedback_ID only has one row,
     which each criterion score listed (8 columns)
      * Can drop from export:
         * Score_ID
         * Evaluator_Email
         * Scoring_Role
         * Team_Name
         * Batch_Name
         * Batch_Type
         * Double_Scored
         * Notes
         * Timestamp
   * "Nice to have" - for this type of export:
      * Ability to export by Activity ID
      * Ability to export only feedback with full set of scores (i.e., batch is
        officially "complete" across all teams/annotators)

---

## Transcript

0:01 - Taylor Haun (Haun Lab)
  Hey Fiona, how you doing?

0:05 - Fiona Eichinger
  Good.

0:11 - Taylor Haun (Haun Lab)
  Hello, check, check.

0:13 - Fiona Eichinger
  Yes, is it me?

0:15 - Taylor Haun (Haun Lab)
  Yeah, I don't know. It may have been me. I'm, like, copying something on my hard drive, but I think we're good.

0:23 - Fiona Eichinger
  Okay.

0:25 - Taylor Haun (Haun Lab)
  We're good now.

0:26 - Fiona Eichinger
  My video was kind of, like, staggered, right?

0:28 - Taylor Haun (Haun Lab)
  Mine too, yeah.

0:30 - Fiona Eichinger
  Okay. I can try switching.

0:32 - Taylor Haun (Haun Lab)
  I think we're good now, but.

0:34 - Fiona Eichinger
  Okay. How are you?

0:39 - Taylor Haun (Haun Lab)
  Doing good, doing good. Just, um, continuing to, A, actually follow up and talk to people, but B, get all the systems for following up and note taking and reporting and automations and all that stuff up and running.

0:56 - Fiona Eichinger
  Yeah. And I just had, um, this is for, for NSVF you're talking about, right?

1:03 - Taylor Haun (Haun Lab)
  Uh-huh.

1:04 - Fiona Eichinger
  Yeah, I just met with Deanna, Ryan, and Amber. Um, and it sounds like Deanna will be able to help with that as well. I don't know if you want to set up the systems and then she helps keep them updated, but.

1:20 - Taylor Haun (Haun Lab)
  Yeah. That's my idea. I'm gonna, I'm gonna talk to her on Thursday.

1:24 - Fiona Eichinger
  Okay.

1:26 - Taylor Haun (Haun Lab)
  Basically, whatever is, like, easy and dumb and should be automated will be automated, and then anything that needs, you know, a person to really dig in and look and make a judgment call, Deanna will be the, you know, first person that I have support.

1:43 - Fiona Eichinger
  Okay. Hey, Amber, I'm in. Jump into it. More Quill. Um, so, following up on our meeting on Friday with CCI and Quill, um, I sent to Michelle the activity nine that annotators are working on now, and Michelle also let me know she's checking her team's availability for the week of August 10th, so in two weeks, to start the bi-weekly meetings.  Um, moving on to recruitment. Um, I know Michelle was out last week and just got back today. Um, but I went into StudyFlow and it looks like there has not been any movement on the teacher and the grant checks. I don't know if Taylor, you otherwise have any other.  Updates.

2:52 - Taylor Haun (Haun Lab)
  Yeah, I talked to Nadia about this yesterday, trying to jog my memory, um, for feedback writers is what we're focused on right now, yeah?

3:05 - Fiona Eichinger
  Yeah. For the school partners.

3:12 - Taylor Haun (Haun Lab)
  Oh, for school partners, not for feedback writers?

3:15 - Fiona Eichinger
  Yeah, for school partners.

3:17 - Taylor Haun (Haun Lab)
  Classroom teachers. Uh, The Stripe people are paid. The checks are still pending. I've made it easier for Michelle to see those. And then she, there's even a notification that's gone out to her. I think she's just getting caught up with everything. My hope is that those were already sent and she just never went and marked them as sent because they were approved like 42 days ago. So probably she sent them and just hasn't marked them.  But we, I've asked her to be like, hey, please check on these. But we, I've asked her to be like, hey, please check on these.

3:55 - Fiona Eichinger
  Okay. Okay, I'll, I'll, I know she's getting back to it today, so maybe tomorrow I'll check in with her.

4:02 - Taylor Haun (Haun Lab)
  Okay, great.

4:08 - Fiona Eichinger
  Okay, um, and for feedback writers and annotators, we had already discussed that feedback writers would be paid out when they finish their work. End of this month.

4:21 - Taylor Haun (Haun Lab)
  Yep.

4:23 - Fiona Eichinger
  And annotators will pay out once in August for what they've completed through July and then we'll pay again in the fall.  Okay.

4:33 - Taylor Haun (Haun Lab)
  And Nadia is in the loop on that.

4:35 - Fiona Eichinger
  Okay. Perfect.

4:41 - Amber Wang
  Okay. Research section.

4:44 - Fiona Eichinger
  Sorry. What did you say, Amber?

4:46 - Amber Wang
  Oh, just a research section.

4:48 - Fiona Eichinger
  Yes.

4:50 - Amber Wang
  Uh, feedback writing, there are still five individuals pending. I did send out a nudge last week. I heard back from one saying she anticipates finishing tomorrow. The others, crickets. Um, but I will keep nudging. I think Kim Zajac, I'm not sure if I'm saying her name right, but I think she's definitely out because I have not heard from her at all. So, the five is excluding.  Um, Kim. If those five finish, um, as mentioned during the Quill CZI meeting, we should get around 6,700 feedback items. And if not, then it's just a little less than that, but we'll be fine. Um, it's great that CZI was okay with moving forward with the current number of feedback that we have. And if should we need more, then I think we can just ask Quill to pull extant data that they have.

5:49 - Fiona Eichinger
  Mm-hmm.

5:50 - Amber Wang
  I've been pulling, cleaning feedback that has been complete and just getting it ready for annotation platform upload. So that's just kind of on a rolling basis. Um, when it comes to annotation, I took a peek at the platform earlier today. Most annotators are still on AI pet robots. Some are definitely falling way behind others, but I assume, I mean, I think they're going to pick back up soon. They're probably on vacation or getting ready for school or something. Some have started on the next activity. So right now there are 43 batches released, which, um, is two, which reflects two Quill activities.  So I think later this week I'll start working on uploading and batching the third Quill activity just to get that going for folks who are ready and, um, reliability still looks great along the way in terms of, like, overall reliability of the double scored batches.

7:01 - Taylor Haun (Haun Lab)
  Okay.

7:02 - Amber Wang
  Taylor, I do have a request for an additional type of export data pool. So I want to be able to test, um, the export of, like, final scores and reconciled scores.

7:21 - Taylor Haun (Haun Lab)
  Okay.

7:21 - Amber Wang
  Um, I think an additional option would be great and super helpful for, like, when I'm pulling data to just quickly hand off to CZI.

7:31 - Taylor Haun (Haun Lab)
  Okay.

7:32 - Amber Wang
  For reference. So, I can share my screen real quick. That might actually be helpful. Uh, send request to share screen.  Okay. Let's talk. Okay. Um, so when, when I did that data pull, oh wait. Let me open this. What it does, and I, I do like this. I still want this. So it's not about changing the existing option.  Um, what it does is, like, you can see for, um, the, here we go here. Okay, like, for example, feedback ID one, it separates each team's  scores instead of, like, collapsing it by feedback ID. Um, I did play around with Stata and obviously Claude for code.  Um, and ideally, so I, I can do this myself, but it'll be great to have the option that just, like, does it for me, where.

8:47 - Taylor Haun (Haun Lab)
  Yeah, I bet it's easy.

8:49 - Amber Wang
  Yeah.

8:50 - Taylor Haun (Haun Lab)
  Once we have a spec.

8:51 - Amber Wang
  Or each feedback ID. Uh, for example, like, this is feedback ID 2475. It just go ahead, it, like, obviously these people didn't score yet, but it go ahead and, um, collapses it by feedback ID. So all eight criteria are just listed.

9:13 - Taylor Haun (Haun Lab)
  Yeah.

9:14 - Amber Wang
  For feedback. So, for example, like, that is where people, because this is activity nine, people started with activity one. So, here, it's, like, the full set. Where feedback one, it's all in one row. I think that's how it'll be easier for, um, handoff to CZI.

9:38 - Taylor Haun (Haun Lab)
  Is that file that, this file that's open right now, is that basically the template of what you want it to just export?

9:45 - Amber Wang
  Yeah, that would be great.

9:47 - Taylor Haun (Haun Lab)
  Okay, can you give me that file?

9:49 - Amber Wang
  Yes, totally. Um, the only thing I would also layer on as a nice to have, so basically I dropped these when I was cleaning it through the house.  One was made of GMB, but, um, because I think these things, these are, like, unique to each team, so we can just drop this from a collapsed export. The nice to haves would be, like, ability to export by activity ID, so, like, hey.

10:17 - Taylor Haun (Haun Lab)
  Like, a range of them?

10:19 - Amber Wang
  No, like.

10:20 - Taylor Haun (Haun Lab)
  Or a sorted one?

10:21 - Amber Wang
  Like, just pull activity one, which is all AI robots.

10:24 - Taylor Haun (Haun Lab)
  Uh-huh.

10:25 - Amber Wang
  Or, um, because, for example, once the annotators finish scoring all of activity one, AI pet robots, it would be nice to just export that and send it off to CZI. I mean, I could always do activity nine, but it's just, like, having those little dropdown options would be cool.  Okay. Also be a nice to have where I can, like, tell it to just export the feedback that has a full set of scores. So, kind of, like, what you saw.  Here, where it's like, hey, no need to pull these yet, because they're not done. Like, just pull the ones.

11:06 - Taylor Haun (Haun Lab)
  Where columns P through W are all complete.

11:09 - Amber Wang
  Yeah. The reconciled score. And I did like, I really appreciate how this one in the export, like the original export view, it's great that it, like, tells you, um, it, like, pulled in the auto-reconciled score.

11:30 - Taylor Haun (Haun Lab)
  Uh-huh.

11:31 - Amber Wang
  It verified that. And I was like, this is really nice.

11:35 - Taylor Haun (Haun Lab)
  Versus, I guess the other option would be if they had to do, um, uh, what is it called when we escalate to a?

11:46 - Amber Wang
  Oh, the adjudicator.

11:48 - Taylor Haun (Haun Lab)
  Yeah. Would that be the other option? It's like either auto-reconciled or it had to be adjudicated?

11:53 - Amber Wang
  Yeah, yeah. I don't feel like anyone has used that yet, but, but yes, if they do, that would, it would need to pull in either the final reconciled score if they agree or the adjudicator's score.

12:10 - Taylor Haun (Haun Lab)
  Because we only really want that final answer, whatever.

12:15 - Amber Wang
  So I think, like, oops, this is, yeah. So. Essentially, it's just gonna, like, an option to say, like, hey, only export the batches that are actually, like, complete, like, totally finalized across. I want to score, everyone did their reconciliations, adjudicators adjudicated if need be, and it's, like, closed out. Um, that would be nice to have.

12:37 - Taylor Haun (Haun Lab)
  Okay.

12:40 - Amber Wang
  Cool.

12:41 - Taylor Haun (Haun Lab)
  I think that all sounds pretty doable. If you can just, um, send me that file, that'll be a guide. And then probably what I'll do, I think I can do it this week. I'll send you, probably what I'll just do is I'll, I'll take it all in and then say, you know, I think it's done. Go look at the export page. The same thing we've done back and forth, but, um, I think I can work on that this week.

13:04 - Amber Wang
  Awesome. Thank you.

13:05 - Taylor Haun (Haun Lab)
  Sure.

13:07 - Amber Wang
  Cool, cool. Um, update on Rapid, Rapid, Suck Quill Playbook. I did finish an initial draft. Yesterday. It is here.  Next step is Rachel is gonna review it, um, and provide feedback when we meet on Monday. And I did want to note to the team that I drafted this playbook, um, with the intent of being as, like, product agnostic as possible because, like, the whole idea is to, like, present steps that, like, someone can then launch from for their own product AI evaluation.  Um, and I know I had mentioned this to, like, at a team meeting before, but just, like, to kind of reground, like, from the proposal, there's, like, two protocols listed. The Rapid Cycle, the Field Ready. Honestly, the bullets under the Field Ready make more sense for the Rapid Cycle. And then all the nuances seem more appropriate for our Field Ready case study protocol. That's when we can, like, go into detail about, like, what we specifically did with our Quill data and our analyses, all that good stuff.  Um, so I just wanted to name that. And, you know, I talked to Rachel about it too, and she thinks that's what makes sense as well, because again, Rapid Cycle is more like, can another product take this and apply the steps to their own, um, tool and, like, refine it or tweak the steps as needed. So, um, so.

15:00 - Fiona Eichinger
  I think those are two, our, our notes from earlier in the study, but I, because I know this was confusing a bit as well, like, with the difference was. From what I remember, the Rapid Cycle Evaluation Protocol was just documenting, like, what we did in this process, and then the field-ready protocol is, like, packaging it into how someone else could replicate it, like, taking what we did, but maybe refining it or making it better.

15:30 - Amber Wang
  Yeah, I remember Peter, it's, it was still a little confusing to me after that call, honestly, because Peter was like, the Rapid Cycle is, like, everything you just did. And then he's like, well, the field-ready is more about, like, MOUs and your data agreements with schools. I'm like, we don't need a whole protocol on that, you know? So, um, so, the way I've kind of approached this, and, you know, this is why I wanted to get it out to Rachel soon, because I'm like, maybe I'm wrong, but the Rapid Cycle is, like,  It is going through all the steps, but then there's, like, sections where it's, like, applied example, and it does, like, give a high-level overview of what we specifically did in our context to, like, help provide illustrative examples of the steps of a Rapid Cycle. Um, and then the case study, I think, is where, like, more of the, like, bringing the Rapid Cycle protocol to life. So it might be, like, a companion piece.  Or something. But then that, that's the one that gets more into the nitty gritty of what happened. So they both, they both cover what we have done up to date, but I just think, I think the field-ready, from my understanding, is more about all the nuances that we went through.  So. But yeah, it was a little confusing that, like, this is here when there's a whole protocol. So I think it's just, like, bringing it more to life.  But we shall see. So all that to say, um, Rachel and I will meet on Monday and, um, hoping to, like, maybe get it out to Peter, um, if she thinks he needs to review some sections, like, by mid-August, and then just kind of go from there, and, um, she'll help me think through if we think CZI needs to look at any sections as well, but, um, but the auto-evaluator is not really a piece that lives in this Rapid Cycle evaluation. According to the proposal, it's not really covering that step, so, yeah.

17:54 - Taylor Haun (Haun Lab)
  Amber, do you think we should include anything around the annotation platform? Like, here's what we did, here's the code if you want to access it.

18:04 - Amber Wang
  Yeah, I put a little comment in my rapid cycle draft of, like, to Rachel, like, hey, do you think this belongs more in the case study? Or if we do mention it in this playbook, this rapid cycle one, it's more like a callout box or like a footnote or something. But I think it will be highlighted more in the case study. So I think, I think it's definitely going to go somewhere.  In terms of the rapid cycle, it might just be, like, a lighter touch point. Because that one, that one is just going over, like, applied.  I mean, sorry, high-level overview. So, for, like, example, um, apply rubric step five. I have, like, the high-level steps, things to think about, callout, tip boxes, apply an example, here's what we actually did, but, like, not going into.  Crazy detail.

19:02 - Taylor Haun (Haun Lab)
  Mm-hmm.

19:03 - Amber Wang
  Um, our scoring approach, why we did it the way we did, things like that. Um, analyze, interpret scores, same things, like high-level things to think about when it comes to your own product, like what analyses you can potentially do. Another tip.  Apply an example. Here's what we did and why. Is it so specific to writing and, like, our approach of having eight writers per, uh, per student response and, like, our data? So this is, like, actual data, but, like, fake IDs. Um, example, like, analysis for us.  And so on. So, um, so I think the annotation piece could, platform could be mentioned here somewhere, but, like, lightly under applied examples.  Yeah.

20:17 - Taylor Haun (Haun Lab)
  Okay. Sounds good. Whenever you land on the final thing, just let me know. And it's a pretty low lift. I think we'll basically write a little bit about it and then say, you know, here's the link to it if you want to use it.

20:28 - Amber Wang
  Sounds good. That's, that's it for me.

20:39 - Taylor Haun (Haun Lab)
  I think I'm good.

20:40 - Fiona Eichinger
  And this other piece that you were talking about with Taylor for the export, that was for the AI pets. Whenever that is finished, that's, that's what you'll be pulling, that data export.

20:54 - Amber Wang
  Oh, like, yeah, so whenever, um, when Taylor, so the first step is Taylor to, uh, help create that specific export type in the annotation platform, and then I'll export the data when the annotators are actually done with that activity, which I'm hoping by August 7th, but you never know.  Yes. Yeah, that's, that is the hope. Yeah.

21:23 - Fiona Eichinger
  Okay, sounds good. Alright. Thanks, everyone. See you in a bit for MSVA.

21:32 - Amber Wang
  That's great. Thank you.
