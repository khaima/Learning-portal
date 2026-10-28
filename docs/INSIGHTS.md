# Key findings — what the figures say

A short "Key findings" panel sits on the impact dashboards. Each finding is
one sentence **worked out from the records by a fixed rule** — never written
freely, never estimated. Code: `supabase/functions/api/insights.ts` (the
rules), `insights-ui.js` (which few are shown, and how). Added 28 October 2026.

## Where they show

| Page | Read from | What's shown |
| --- | --- | --- |
| Executive overview | `GET /impact/insights` | Up to 5, under the key figures |
| Reach, Learning, Teacher development, Field operations, Digital resources | the same read | Up to 3 of that dashboard's own, above its charts; none at all when there are none |
| M&E overview | the same read | Up to 3 about M&E reporting and untagged indicators |
| Administration overview | `GET /admin/overview` → `insights` | Up to 4, under the six results — leaving out gaps (Needs attention, just below, has them) and anything a card above already says |
| Administration → In detail | the same | Every finding, grouped by what it's about |

`GET /impact/insights` needs `intelligence.view` (M&E, Super Admin). Both
reads stay inside the caller's area and the county / school chosen above. The
findings are for one reporting term: the one the chosen period ends in, else
the one under way — the panel says which.

## Every finding carries

- **its period** ("2026 Term 3 so far", "Due 24 Oct 2026", "2025 to 2026 Term 2");
- **what it rests on** — how many schools, people or records ("7 of 13 teachers", "6 schools with an approved target");
- **its source** — the records it was worked out from ("M&E indicator L1: verified actual", "field visits filed on the portal");
- where needed, **a caveat** that stops it being over-read;
- **what it is about** — Reach, Taking part, Resource use, Skills, Learning outcomes, Implementation, Reporting — so taking part is never read as learning;
- where it is something to act on, **a link to the page that already deals with it**, shown only to someone who may open that page.

## The rules, kind by kind

| Kind | Said when | Source |
| --- | --- | --- |
| Against target | An M&E indicator has an approved target **for this place and period** (a county or school is never set against the whole programme's target) and a value. "Met" from 100%, "close" from 80% | M&E targets; the value is the verified or recorded actual, else worked out live — the finding says which |
| Across schools | Work handed in, among **3 or more** schools with 10 or more pieces set, when the highest and lowest are **20 points or more** apart. Schools against their own M&E targets: how many have results, how many met it, the furthest from it | Assignments and work handed in; M&E school targets and actuals |
| Change | A programme result against **the same day of the term before**: 5 points or more on a share, or for a count 3 or more and a fifth of what it was, and never on fewer than 5 people or schools. An M&E indicator between two **recorded** term values | The results (admin_impact.ts); M&E recorded actuals |
| Baseline to follow-up | An M&E indicator with a recorded baseline and a later **recorded** actual — the whole programme's only (the baseline is the programme's, never one county's or school's) | M&E baseline and actuals |
| Overdue or missing | A form past its due date (this term or the last) that some of those it was sent to haven't answered — a head's form counted by school; field visits filed without all their forms; for the last term that ended: indicators with a target and no recorded actual, actuals waiting to be verified, and no final M&E report (only once reports are made at all) | Forms and responses; visits and visit forms; M&E targets, actuals and reports |
| Gap | Schools with no field visit this term, schools with learners but no work set, schools with learners but no active teacher | Field visits, assignments, accounts |
| Evidence | Said once: no learning assessment has both a baseline and a follow-up, so no change in learning can be reported | M&E indicators about learning |

## What is never said

- **A cause.** No "because", "led to", "improved learning". A baseline-to-follow-up
  finding says so: "this alone doesn't show what caused the change".
- **A learning change from classwork marks.** Different work is set each term,
  so the average mark is never compared term to term in a finding (the card's
  own trend stays, as before), and handing work in is called taking part.
- **Anything missing filled in.** No value is "no value", never 0; an indicator
  without a value is listed as such.
- **A new task or reminder.** Findings make none. Overdue forms are already
  reminded by the portal (notifications.ts) — the finding says so — and each gap
  links to the page where it's dealt with: Forms, Field visits, Indicator
  results, M&E reports, Teachers, the school list.

## Which few are shown

Each finding has a rank: overdue reporting and targets furthest from being met
first, then falls, gaps and differences, then rises and targets met. A panel
takes one of each kind before a second of any (so five findings aren't five
targets), then fills by rank; the evidence note only when there's room.
