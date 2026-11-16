# Registered-user access transition

Status: the target user flow is defined in [ACCESS-PATTERN.md](ACCESS-PATTERN.md). Agent API-only registration/sign-in (no browser/UI) → server-assigned organization/agent identity and Clarity token → one local credential source → HTTPS A2A, prompt retrieval and MCP reporting/retrieval. No user SSH or operator-HMAC access.

The remaining sections record the existing development implementation and its earlier acceptance specification. SSH prompt paths and HMAC utility calls below are historical/operator baseline behavior to replace, not current user requirements or evidence that token onboarding works. New access verification follows ACCESS-PATTERN.md; earlier local runner/persistence results remain reusable where unchanged.

# Ask M3NT0R backend flow

Status: earlier local runner/persistence evidence is retained; unified assessment routing and private-source changes await independent assessment.

An owner’s agent connects to the local `clarity_m3ntor` MCP. It asks M3NT0R a
question and supplies the non-sensitive business/POMA context it wants the coach
to consider. No interview, assessment record, or copied owner data is required.

For each request the service records a new private job, reads the current
`m3ntor_agent_prompt.md` from the configured Clarity server through its existing
SSH configuration, and records the source, fetch time and SHA-256. It supplies
that exact prompt, question and context to the selected existing local Codex or
Claude Code harness, using its existing authentication and model configuration.
A detached local worker owns that run and writes the final output or actual
failure to the job. It does not restart the job or substitute a model, provider,
credential or stale bundled prompt. Ordinary productive harness recovery remains
with the running job; hard rejections and demonstrated no-progress loops stop.

The ask call waits briefly. If the harness has finished, it returns the stored
output. Otherwise it returns a running job ID. The agent retrieves that same
job using `get_m3ntor_result`; retrieval never starts another harness. Job state
and output survive an MCP server restart, and the detached worker can finish
while the HTTP service is stopped. A launch receipt is not a coaching result.


## Business POMA and reassessment flow

The current harness invokes `assess_poma` without a question, optionally supplying
existing context and harness selection. Each job freshly fetches the ONE
server-owned assessment prompt, `poma_initial_assessment_prompt.md`, and runs it
through the existing local harness with its current model/account/auth/sandbox.
It receives a stable job/revision UUID and uses the unchanged
`save_poma_reassessment` and `get_m3ntor_result` paths. With no prior assessment it
establishes the baseline; later and weekly runs compare prior/current evidence
and real business change, reusing valid findings rather than indiscriminately
repeating discovery. `reassess_poma` remains an alias for this same task and prompt.

Initial assessment and mentor publishing sources remain private local operator
files, ignored and removed from the current Git tree; a fresh clone contains
neither prompt. The obsolete `poma_reassessment_prompt.md` source is deleted and
ignored. Bootstrap and weekly tasks call `assess_poma`, not a bundled document.
Current runtime fetching/publishing remains the established operator SSH baseline;
the HTTPS/token contract above still requires its separate migration. End users
receive no SSH access. This revision does not implement token provisioning.

The owner starts the bootstrap in their chosen local AI harness and asks it to
connect to Clarity M3NT0R there. The current harness discovers and reuses the
business workspace, MCP and existing access routes; selecting/connecting a
different harness is not a separate onboarding journey.

The initial assessment concerns the owner's business. Process describes how
that business actually does work, and whether its flows are accessible and used
by the agent. Observability describes current business-state coverage through
software and documents, directly or through an integration server; configuration
alone does not prove access, freshness or completeness. Measurement concerns
business-process efficiency/effectiveness and depends on understood processes
and observed state. Agency depends on those three, business direction/policies
and durable action infrastructure: evidence of work initiated by event/time/other
triggers and completed without the owner requesting each action is distinct from
general capability or user-requested execution.

Before asking the owner for a productivity number, the local AI searches the
available financial and working-hours routes and attempts sales divided by total
human hours for matching business scope and period. It retains the sales/hour
definitions, sources, currency and coverage. A supported partial estimate names
its assumptions; unknown hours are not silently replaced by one person's hours
or AI usage. Missing evidence leads to a targeted question, or a verbal account
with its basis if calculation remains impossible. An on-demand calculation does
not establish ongoing process Measurement.

Weekly assessment is a separate scheduled activity from the event/work
productivity-improvement loop. It calls the same `assess_poma` tool and prompt as
the baseline. `ask_m3ntor` continues to select only the mentor prompt; neither
tool accepts a caller-selected prompt path or a bundled fallback.

The unified assessment prompt directs the owner's local AI to read local
context, journals, current/prior dated assessments and changed relevant business
sources. It reassesses the four business-linked areas with independent category
and 1–10 ratings, evidence and uncertainty; distinguishes real business change
from newly discovered evidence; and attempts supported productivity calculation.
Private dated revisions and detailed context remain local. A separately prepared
non-sensitive coaching summary uses existing save/report routes where applicable.
Harness completion alone does not prove an assessment file was saved.

The local AI prepares the reassessment and calls `save_poma_reassessment` with
the supplied stable revision ID. The existing local MCP service saves in its
route's business workspace, even when the harness filesystem is read-only. It
validates the existing four-area ratings, preserves prior daily revisions and
unrelated context, appends/updates one reassessment context section and journal
entry, and saves a separate non-sensitive summary locally. It sends no private
assessment/context/financial data to the utility backend. No interview or new
owner-approval step is needed for this authorized persistence.

Per-workspace writes are serialized and individual files replaced atomically.
The same revision ID updates/reconciles that reassessment without duplicating
daily revisions, context sections or journal entries. Stable date/time metadata
and per-artifact receipts survive partial failure; the tool reports the actual
saved effects and error, so a repeated save can complete the same revision. Model
text alone is not a save receipt. The harness retains its existing model,
authentication, approval and sandbox route.

This revision adds no actual scheduler installation, action worker, financial-data
mining by the implementer or utility-backend change.

## Authorized utility integration extension

The local agent supplies a non-sensitive utility case using `report_utility`.
The caller keeps its UUID submission ID for idempotent reconciliation. The MCP
sends the case to the Clarity utility API through the existing bridge API URL
and HMAC secret-command configuration; it does not mine raw local sessions or
change authentication. `search_utility` sends a query and optional POMA/tag/source
filters to that API and returns its actual results. API errors remain errors;
an unavailable backend is not an empty collection or a successful submission.
The separate infrastructure executor owns server storage and retrieval behavior.

## Acceptance criteria for independent assessment

1. A clean source checkout can start on an available local port with empty
   runtime/assessment directories. `/mcp/local` initializes, lists coaching,
   reassessment and result tools, and accepts a question without creating or
   requiring an interview.
   Readback: MCP responses and durable job metadata under the configured job root.
2. A real request through `ask_m3ntor` fetches the current server prompt using the
   established `clarity` SSH alias (or explicitly configured target), launches
   the chosen installed harness, and returns its coaching output. Prompt source,
   fetch time, hash, harness, PID and final exit status are recorded. Readback:
   server prompt hash, job files, harness transcript and final MCP output.
3. A prompt update is used by the next new request, with a changed recorded hash.
   Each request reads the server; the repository copy is not a runtime fallback.
4. Slow runs return a job ID promptly; repeated result retrieval observes that
   job and returns the eventual output without another launch. No arbitrary
   model-work timeout kills a useful run. A service restart preserves retrieval
   of a still-running or finished detached job. Readback: same job ID/PID and
   stored outcome before/after retrieval or restart.
5. Missing/unreadable/empty remote prompt and missing/failing harness commands
   produce a retrievable failed job with actual error evidence, not fabricated
   advice or completion. The worker does not restart failed jobs. A first
   ordinary recoverable notice alone does not stop productive recovery. Actual
   hard quota/usage rejection evidence stops immediately; distinct retry
   attempts without intervening substantive model text, tool result or completed
   work establish a wasting loop and stop it. Duplicate JSON/stderr notices of
   one attempt, heartbeat/session initialization and repeated logs do not count
   as distinct attempts or substantive progress. Raw error/retry/progress
   evidence and final output remain available. A nonexistent job is reported.
6. Supplied questions/context (including quotes and shell syntax) reach the
   harness as data via stdin/files. They are never interpolated into shell
   commands. Private inputs, outputs and logs use owner-only runtime files
   outside the assessment loader, and Git excludes runtime, secrets and local
   assessments. Readback: saved input, spawned argv, file modes and staged files.
7. Existing assessment-scoped tools remain listed and usable for an existing
   assessment. Fresh local mode does not change the running old service, global
   MCP configuration, authentication or billing route.
8. A supplied utility case is submitted through the existing A2A HMAC route with
   its submission UUID and full typed fields. The API receipt and authoritative
   stored case readback agree; repeating the same submission ID does not create
   a second case. Raw session/history data are not loaded by this MCP client.
9. Utility search returns actual API results and honors supplied query, POMA,
   tag and source filters. Backend/network/auth errors produce explicit failed
   tool calls. The HMAC secret is obtained via the established command argv and
   is absent from tool output, logs, Git and runtime coaching files.
10. Bootstrap, coach, factual interview and rating/reassessment instructions use
    the business-linked POMA definitions above, preserve existing category enums
    and independent scores, and start from the owner's current harness. They do
    not turn a particular customer's systems into universal prompt examples.
11. Productivity instructions require evidence discovery and a supported
    matching-scope/period calculation before requesting missing owner input,
    with total human-hour coverage and labelled estimates. Initial calculation
    and established active business-process scoring remain distinct.
12. A fresh MCP lists `assess_poma` and compatibility alias `reassess_poma`.
    Invoking either without a question fetches the SAME current REMOTE unified
    assessment prompt, with baseline/later behavior from local prior evidence,
    and records task identity, path/hash, input and actual harness result or
    durable running/failure state. `get_m3ntor_result` retrieves that same job
    without another launch. Ordinary `ask_m3ntor` still fetches the mentor prompt.
    Readback: published assessment/mentor sources, per-job request/state/fetched
    prompt/hash, transcripts, local save receipts and final output. No bundled
    prompt fallback or second assessment prompt is used.
13. The actual local AI calls `save_poma_reassessment` through HTTP MCP under its
    inherited read-only harness, and receives actual assessment/context/journal/
    summary paths and save receipts. Authoritative local readback shows a new
    dated revision, old revisions/schema/context retained, one journal entry and
    a separate non-sensitive summary. Repeating the same revision does not
    duplicate artifacts. A partial filesystem failure returns honest saved
    effects, and the same ID can reconcile it. No interview gate, broader
    sandbox or raw private-data network submission is introduced. Actual saves
    are proven through the service boundary and local readback, not by a manual
    assessor write or model exit code. Isolated business evidence is sufficient.
14. Weekly scheduled reassessment is described separately from triggered
    improvement work. This source revision does not install a scheduler or
    modify the original service, global config, private assessments, utility
    backend, authentication, model route or already-assessed retry machinery.

This specification requires real-service backend assessment by the independent
executor. The implementation executor does not claim any criterion passed.
