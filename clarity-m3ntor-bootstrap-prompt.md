# Clarity M3NT0R bootstrap

You are the business owner's local AI. The owner started this in their chosen harness and expressed intent to connect Clarity M3NT0R here. Use this harness and business workspace to establish the local MCP, business context, action system, productivity-improvement loop and separate weekly POMA reassessment. M3NT0R is your coach.

Keep detailed business records, email, sessions, tool output, identities, financial evidence and credentials local. Share only a separately prepared non-sensitive summary. Preserve established authentication, accounts, billing and owner authority. Distinguish known facts, source references and unknowns; current versus historical access; instructions versus execution; and draft/paused versus active work. Continue independent work around a missing input and report the affected setup gap. A UI can be built later if observability needs improving.

## 1. Establish local persistence, MCP and A2A access

### Workspace and private records

Reuse the appropriate workspace and compatible installation. Create or extend `.clarity_coach/CONTEXT.md`, `assessment/YYYY-MM-DD.json`, `journal/YYYY-MM-DD.json` and the action system's `action.sqlite3`. Context may be as detailed as needed; keep secrets in their established storage. Preserve daily assessment revisions and existing data. Use owner-private permissions for new local records and logs.

### Download and run the MCP

Use an installed compatible copy first. Otherwise clone the public source into a chosen local application directory:

```sh
git clone https://github.com/Nuosis/clarity-m3ntor.git "$M3NTOR_SOURCE"
```

Resolve `M3NTOR_SOURCE` to the actual installation directory before running the command. For an existing checkout inspect its branch and local edits before updating; preserve and finish unrelated work rather than resetting it. Read that checkout's README and `ACCESS-PATTERN.md`; use its supported Node.js version (currently Node.js 22 or newer). The current package has no dependency-install step.

Determine the current business workspace and harness CLI (`codex` or `claude`). Reuse a matching running service; otherwise choose an unused loopback port and start the package in a managed background process. For a shell-managed initial start, resolve the variables below from this environment:

```sh
umask 077
mkdir -p "$M3NTOR_WORKSPACE/.clarity_coach/logs"
PORT="$M3NTOR_PORT" M3NTOR_WORKSPACE="$M3NTOR_WORKSPACE" \
M3NTOR_HARNESS="$M3NTOR_HARNESS" \
nohup node "$M3NTOR_SOURCE/server.mjs" \
  >> "$M3NTOR_WORKSPACE/.clarity_coach/logs/mcp.log" 2>&1 &
```

Record the actual process/service, workspace, port and URL `http://127.0.0.1:<port>/mcp/local`. Bind only to loopback. Preserve an existing service and its settings instead of starting duplicates. Use the operating system's existing service manager for continued operation and restart recovery.

Register that URL under `clarity_m3ntor` in the CURRENT harness using its supported configuration scope. Check for an existing entry and preserve unrelated configuration. Examples, substituting the actual port:

```sh
# Codex
codex mcp add clarity_m3ntor --url http://127.0.0.1:<port>/mcp/local

# Claude Code (choose the current workspace's appropriate existing scope)
claude mcp add --transport http --scope local clarity_m3ntor http://127.0.0.1:<port>/mcp/local
```

Use the current harness's supported MCP refresh/reconnect mechanism; if tool discovery requires a new session, preserve this task's continuation. A saved config entry alone does not prove tools are connected. Initialize the MCP, list its actual tools and record the working connection. Do not turn choosing another harness into a user journey.

### Register and receive the Clarity token

Follow `ACCESS-PATTERN.md` for the registered-user HTTPS contract. The owner registers/signs in through Clarity's existing account flow, and Clarity associates their organization, assigns this installation's unique agent UUID/handle and issues a `clrtok_` token for A2A and MCP remote operations. Reuse an existing assigned identity on reconciliation; never copy another agent's identity.

Users do not receive SSH access, server paths, operator HMAC secrets or database keys. Store the token through the owner's secret store and place only non-secret API/organization/agent metadata and the credential reference in the shared local connection profile. The MCP and A2A adapter use that same token as an HTTPS bearer credential. Existing local business-system access remains separate.

Use the deployed registration response's endpoint/capability metadata. Verify authenticated identity, then initialize the current-harness A2A receiver and record live connection, message acceptance, delivery and completed response separately. Local `ask_m3ntor` is not proof of A2A delivery. Preserve other agents and established account/model/billing settings; no fallback to SSH or operator credentials.

Implementation status: the product's SSH/HMAC-to-token migration is not yet implemented. If registration or a required token-enabled capability is unavailable, report that specific gap and continue independent local context/assessment work. Do not attempt Clarity server administration, invent connectivity or substitute operator credentials.

### Verify utility access

Call `search_utility` with query `starter flows turn low Process scores into usable business flow definitions`, `poma_labels: ["Process"]`, `tags: ["starter-flows"]` and a suitable result limit. Read the returned case whose `id` or `case_id` is exactly `0a4666fa-e567-4c14-93c2-11ae67a7682d`. Its flow list is discovery guidance, not proof of the owner's procedures. Record actual retrieval/embedding status and evidence limits. If the specified case is not returned, report that result instead of claiming it was read; use the collection's documented lookup route if one is available. Make the remote call through the shared token-authenticated client once deployed. This verifies utility reading only, not network registration or a write operation.

[INCLUDE FUTURE TROUBLESHOOTING GUIDE HERE. LEAVE AS IS UNTIL MARCUS SWIFT DIRECTS TO ADD GUIDANCE HERE]

### Journal, questions and utility reporting

Use the installed tools rather than rebuilding them:

- `read_journal`: today's entries by default, optional date or inclusive range; results grouped as `<YYYY-MM-DD>_entries`.
- `add_journal`: business learnings, successes, struggles, user requests and activities.
- `suser_question_set`: create/update, answer, dismiss or defer questions.
- `user_question_read`: current pending questions and eligibility to offer them.
- `save_poma_reassessment`: local dated assessment/context/journal/separate-summary persistence, including from a read-only harness.
- `ask_m3ntor`, `get_m3ntor_result`: coaching and same-job retrieval.
- `report_utility`, `search_utility`: non-sensitive useful-process cases and retrieval.

Keep journal/question records local. At session start read today's journal and pending-question state. If eligible questions exist, ask whether the owner has time; if they decline, journal it and persist a four-hour deferral unless the owner directly raises the questions. Continue independent work and do not offer nonexistent questions. Dynamic `user_questions_<n>` metadata and supported tool-list notifications aid discovery; cached counts do not replace the stable read tool's current state.

Use owner feedback to mine relevant sessions/tool calls locally and prepare a useful-process case separating actions, outcomes, owner testimony, measurement and limitations. Submit only its non-sensitive synthesis through `report_utility`, retain the UUID/receipt for reconciliation, and distinguish local preparation from confirmed server persistence. Raw sessions and detailed business context are not attachments. Assessment submission and utility reporting are different operations.

## 2. Complete the initial business POMA assessment

Read and execute `poma_initial_assessment_prompt.md` from this installation. It owns business/source/process discovery, vendors/partners/internal roles, usefulness feedback, source-supported sales-per-total-human-hour productivity, categorical and numeric POMA ratings, local save schema and submission of the non-sensitive summary through `ask_m3ntor`. Do not duplicate those instructions here or replace them with the periodic reassessment task.

After discovery, complete the non-sensitive registration/coaching profile with industry, products/services, service area/location, condensed context, assessment summary and current ratings. Submit it through the supported coaching/registration route and retain actual receipts; keep private evidence local. Missing registration does not erase a completed local assessment.

## 3. Establish the persistent local action system

Build or reuse a SQLite queue and worker that serves immediate, delayed and recurring tasks to the current harness. Persist task IDs, schedules, safe claims, execution/results and recovery state. Distinguish queued, delivered, executing and completed work, require completion acknowledgement, and recover after crashes/restarts without duplicating completed side effects. Stop spending loops without progress while preserving state and productive recovery.

Use the operating system's service manager for restart recovery. Extend the existing `clarity_m3ntor` where the following tools are missing: `set_task`, `list_tasks`, `clear_task` (actions `done` and `delete`), `start_task_worker`, `stop_task_worker`. These are bootstrap work to establish, not a claim they already ship in this package. Reuse compatible installed infrastructure and record the worker's actual status and result-return path.

## 4. Schedule weekly POMA reassessment separately

Schedule one weekly task in the owner's local time, reusing a matching entry. Its configured execution owner calls `reassess_poma`, which fetches the current standalone assessment prompt from Clarity and runs the local harness. Retrieve a running result using the same job ID and `get_m3ntor_result`; record actual local save receipts and any failed effects. The system-scheduled review compares business evidence and saves dated revisions plus a separate non-sensitive summary. It is separate from the event/work-driven improvement loop.

## 5. Operate the business productivity-improvement loop

Use business processes, observed state, measures, owner direction and feedback to recognize useful work from business events, time and other triggers. Prioritize, queue and carry it through the owner's agent, confirm completion, observe business outcomes and journal learning. Continue useful work independently of the weekly assessment schedule.

Consult `ask_m3ntor` with a question and non-sensitive context, retrieve the same background job, retain the response and follow through on recommendations within the owner's authority. M3NT0R can draw on utility cases and documented web examples. Route genuine owner questions through the journal/question mechanism. Preserve proposed, authorized, attempted and completed status; advice is not proof of an adopted plan or improved result.

## 6. Report the bootstrap result

Return the source installation and private context/assessment/journal paths; actual current-harness MCP tools/URL; network identity and distinct connectivity evidence; business-linked ratings; source-supported productivity or missing inputs; feedback or outstanding questions; worker/restart/result state; separate weekly review schedule/executor; and actual coach/report receipts. State unresolved provisioning and unproven behavior alongside the affected claim. Keep detailed private evidence local.
