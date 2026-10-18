# Auditor Explanation Pilot

## Purpose

Run a five-person formative pilot before committing to the Phase 2 study. The
pilot checks whether the explanation surface helps non-engineers answer audit
questions accurately and find supporting receipts. It is a usability pilot,
not evidence that the full study threshold has been met.

The primary comparison is **auditor explanation + evidence handles** versus
**raw tool trace**. Keep the database actions, outcomes, and evidence identical
between conditions. Change only how the information is presented.

## Readiness gate

Do not run this against a narrated mock as if it were the product. Before
recruitment, prepare two inspectable views for each scenario:

1. The raw trace with tool name, arguments, role/policy decision, result, and
   receipt identifier.
2. The auditor explanation with its because-clause and links/IDs resolving to
   the same `evidence_ledger` receipts.

The current browser prototype has generic per-tool explanation text and no
real MCP transport. Label the pilot material as a prototype. Do not imply that
it evaluates HTTP routing, transport conformance, or production authorization.

## Pilot sample and session

- **Participants:** 5 people who do not build or maintain AgentDB. Prefer
  compliance, audit, risk, or operations experience; record role, not employer.
- **Duration:** 20–25 minutes per person.
- **Format:** One facilitator, one participant, one screen. No coaching during
  scored tasks. Ask the participant to think aloud after each answer.
- **Exposure:** Each person completes all 3 scenarios. Use a mixed sequence of
  explanation and raw-trace views; counterbalance the order across participants
  so neither view always comes first. Do not show both views for the same event
  before the participant answers.
- **Recording:** Record only with the participant's permission. Prefer notes
  and answer scores; do not collect names, employer details, or sensitive
  operational data.

## Facilitator opening

> We are testing whether this audit view helps someone understand what an
> agent did. We are testing the interface, not you. Please answer only from
> what is on screen. You can say “I can’t tell.” I will not explain the trace
> until you have finished the task.

Give the participant the following instruction before each task:

> Review this event and answer the questions. Point to the evidence you used.

## Scenario cards and answer key

Use synthetic data with stable IDs. Replace the example receipt IDs with IDs
from the actual fixture when the pilot build is prepared.

### A. Write refused in a read-only session

**Event:** An agent attempted `memory_store` while its effective role was
`read`. The policy denied the call; no memory was written. The call and denial
were recorded in the ledger.

**Questions:**

1. What did the agent try to do, and did it succeed?
2. Why was the action refused?
3. What receipt or result supports your conclusion that no memory was stored?

**Scoring key:** Attempted to store a memory (1); denied/failed and no write
occurred (1); read-only role lacked write permission, supported by the denial
receipt/result (1). Do not award credit for inferring “no write” from a generic
error with no outcome evidence.

### B. Clarification before choosing a table

**Event:** A request matched more than one table. The agent paused and asked
which table to use. No query ran before the user answered.

**Questions:**

1. What was ambiguous?
2. What choice is needed before the agent can continue?
3. Did the agent query either table already? What evidence shows that?

**Scoring key:** Multiple table matches (1); user must select the intended
table (1); no query ran before clarification (1), supported by the
input-required receipt and absence of a completed query receipt in the run.

### C. Read query completed

**Event:** A read-only hybrid search completed for a synthetic query. The
explanation names the search and the reason the returned items ranked; the
receipt records the tool, parameters hash, outcome hash, and run ID.

**Questions:**

1. What did the agent search for?
2. Why were these results returned or ranked?
3. Which receipt lets you verify the event and its result?

**Scoring key:** Correct query/task (1); identifies the actual ranking basis
shown by the fixture (1); points to the matching run/receipt and its result
summary/hash (1). Do not accept a reason absent from the trace.

## Score sheet

Score each answer `1` only when it is correct and supported by visible
information; otherwise `0`. Record “can’t tell” as `0` and treat it as useful
diagnostic feedback, not participant failure.

| Participant | Scenario | View | Correct / 3 | Time (sec) | Confidence (1–5) | Evidence cited | Misread / question |
|---|---|---|---:|---:|---:|---|---|
| P1 | A/B/C | explain/raw |  |  |  |  |  |

Also note:

- Whether the person can distinguish attempted, denied, completed, and
  clarified actions.
- Whether the because-clause states a reason supported by the evidence.
- Whether an evidence handle opens the receipt that supports the sentence.
- Any moment where the explanation suggests more certainty than the receipt.
- Terms that required translation into plain language.

## Pilot decision rules

The five-person pilot is for finding wording and navigation failures. Do not
apply the Phase 2 kill criterion to this sample.

- Fix any fabricated, contradictory, or unsupported explanation immediately.
- Revise a template if 2 or more of 5 participants independently misread the
  same phrase, or if 2 or more cannot find its supporting receipt.
- Keep both views in the full study. A pilot preference is not a success result.
- Run one template iteration, then repeat targeted pilot tasks with fresh
  participants where possible.

## Full study boundary

The Phase 2 claim remains a separate, pre-registered study with **at least 30
participants** and a raw-trace control. Before recruiting, freeze:

1. The unit of randomization (participant or task).
2. The denominator for “task success” and the answer key for every question.
3. Whether “3 scenarios × 10 questions” means 10 questions per scenario or 10
   questions total. These produce different workloads and denominators.
4. The success threshold (at least 85% correct) and the kill threshold (below
   60% after two template iterations).
5. How missing answers and “can’t tell” responses count.

Recommended primary metric: percentage of participants who answer every
required fact in a scenario correctly and cite the supporting receipt. Report
per-scenario and per-condition results, a confidence interval, time-to-answer,
and common misreadings. Do not let a high pooled score hide a scenario or
audience variant that fails.

For the first full study, test the **auditor** variant only against raw trace.
Test engineer, end-user, and regulator variants separately after the auditor
surface clears its gate; otherwise the study will not tell us which audience
template caused the result.

## Recruiting and launch checklist

- [ ] Explanation and raw-trace screens use the same frozen synthetic events.
- [ ] Every because-clause resolves to one or more visible ledger receipts.
- [ ] The answer key is frozen before the first session.
- [ ] Five participants meet the non-engineer criterion.
- [ ] Condition/order assignments are prepared in advance.
- [ ] Consent, recording choice, and note-taking are explained.
- [ ] No participant is coached before answers are scored.
- [ ] Pilot observations are reported separately from full-study statistics.
