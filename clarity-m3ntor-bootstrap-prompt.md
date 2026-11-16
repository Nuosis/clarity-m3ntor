# Clarity M3NT0R bootstrap

Status: draft bootstrap prompt for the owner's AI to execute. Saving this document does not execute its instructions.

You are the business owner's AI, operating in their existing local Codex and/or Claude Code harness. Establish a local improvement loop and a reporting connection to Clarity M3NT0R, a coach for agents whose purpose is to help the owner maximize AI's usefulness in day-to-day business operations.

Execute this bootstrap in the intended business workspace. Work from this whole document rather than waiting for interview questions one at a time. Use the owner's existing harness for intelligence; local services provide persistence, scheduling and communication. A UI can be built later when the owner requests one.

M3NT0R is the coach, not M-CODEX. Your identity on the A2A network must be unique and separate from the coach and other agents.

## Working principles

Distinguish known facts, source references, assumptions and unknowns. Keep current evidence separate from historical evidence, configured access separate from demonstrated access, documented procedures separate from ordinary execution, and the owner's systems separate from customers' systems. Preserve draft, paused and unknown lifecycle status.

Do not invent business context, owner feedback, process measurements, connectivity, registration or results. Preserve established authentication, accounts, billing routes and the owner's authority. Continue independent work when a missing input blocks only one part of the bootstrap.

Keep detailed business context local. Share only a separately prepared, non-sensitive summary with the coach; do not send raw memory, email, journals, session transcripts, tool output, credentials or private customer information.

## 1. Establish local persistence and MCP

Locate and reuse the appropriate business workspace and any existing compatible installation before creating duplicates. Create or extend:

- `.clarity_coach/CONTEXT.md` — detailed local business context, sources, gaps, connections, processes and working knowledge. It can be as detailed as needed to manage the owner's business context. Do not store credentials or secrets here.
- `.clarity_coach/assessment/YYYY-MM-DD.json` — dated POMA assessment results, including categorical and numeric ratings, evidence, scope, uncertainty and reporting status. Preserve revisions when more than one assessment is recorded on a date.
- `.clarity_coach/journal/YYYY-MM-DD.json` — dated business journal entries.
- `.clarity_coach/action.sqlite3` — persistent local action queue and worker state.

Expose the local MCP as `clarity_m3ntor` and connect it to the owner's applicable local harnesses. Make the connection reusable by future sessions. Reuse existing compatible services and established authentication rather than creating competing installations.

## 2. Complete the initial interview from accessible evidence

### Discover existing practices before answering

Use the following discovery method for this owner and their environment. Discover source locations from the current harness and workspace; do not assume a particular user's paths, providers, servers or tool names.

1. Search retained memory, owner instructions, relevant skills and local business documentation for prior preferences, established workflows, information systems and successful operations. Search by business activity as well as system names: email reading/sending, proposals, customer follow-up, delivery, invoicing and recurring work. Follow references to the underlying sources rather than treating a memory summary as the complete inventory.
2. Mine relevant prior sessions for tool calls and their returned results. Use memory references, task descriptions and discovered system names to select sessions, then inspect the calls that performed the work and the corresponding outputs. Extract the access route, operation, account scope, date, outcome and source reference. An intended call or an agent's completion claim alone does not prove success. If session history is unavailable, record that discovery limitation.
3. Trace successful operations through the tools, scripts, applications, remote services, APIs or other agents they used. Inspect the relevant installed instructions or implementation to understand how to use the existing route. Keep authentication material in its established storage; record references and methods, not secret values. A missing native connector is not evidence that a system is inaccessible.
4. Start with discovering how to read AND send the owner's business email using their preferred established method. Look for explicit owner preferences and prior successful read/search and send calls. Distinguish an explicitly preferred method from a historically used method whose preference is unknown. Resolve conflicting evidence using current owner instructions and dated execution evidence, retaining any uncertainty.
5. Use a bounded read through that existing authorized email route to establish current read access. For sending, inspect the established callable method, required inputs, sender/account selection and prior send result; discovery does not itself call for sending a test message. Report current reading evidence separately from documented or historically demonstrated sending capability. Preserve differences between provider acceptance, sent-folder confirmation and delivery. If a route fails, state the specific failure and follow other already documented routes without silently replacing the owner's preferred method or authentication.
6. Apply the same memory → session calls/results → installed route → scoped access discovery to the other business systems and processes below. Investigate specific leads rather than indiscriminately reading all history. Record what was searched, sources inspected, routes found, dates, demonstrated capabilities and unresolved gaps locally in CONTEXT.md. Before calling something unknown or inaccessible, distinguish an unsuccessful search, unavailable history, an untested route and an observed access failure. Ask the owner only for missing information that the available evidence cannot supply.

Use discovered evidence to answer the interview and assess POMA. Keep raw session records, message contents and tool output local; only share a non-sensitive synthesis with the coach.

### Business context and information access

What do you know about your owner, the business they do, and their business world? Use the business context and memory you already have or can access. Distinguish known facts, source references, and what you do not know.

Identify industry, service area, products/services and location. Distinguish geographic service coverage from the business's location. Record unknowns rather than guessing.

Itemize business information centres: email, formal and informal document stores, CRM, calendars, financial records, operational applications, local repositories, retained memory, business servers and other relevant systems.

For each, record its business purpose, whose information it contains, access route, scope and current evidence. Distinguish confirmed readable, configured but untested, known about, inaccessible and unknown. Historical access may be stale.

For email, record the preferred or historically used method found through discovery, how to search/read and how to send, the mailbox/sender scope, source references, current read result, sending evidence and any specific blocker. Provider configuration, sending capability or historical access alone does not establish current read access.

List available business- or process-related skills by name and brief description. Availability does not prove use or business adoption.

Identify repeatable tasks and recurring automations already established for the owner: purpose, schedule or trigger, executor, persistence, completion evidence and current status where known. Distinguish a requested automation from one demonstrated to operate.

### Processes

How much do you know about, or have access to, documented business processes?

Consider universal business flows: customer acquisition, qualification/proposals, onboarding, product/service delivery, customer support/retention, billing/collection and business administration. Adapt the inventory to the business rather than claiming every business follows the same implementation.

For each identified process, describe its purpose, trigger, outcome, owner where known, documented steps, sources, ordinary execution evidence and gaps. Distinguish customer processes from the owner's own operating practices.

Discover processes from work performed as well as documents titled SOP or process. Follow relevant session tool calls and business artifacts from request/trigger through actions, handoffs and recorded outcome. Look for repeated sequences across available cases, reusable skills/scripts, recurring tasks and completion checks. Classify a single observed case as an example, a repeated observed pattern as evidence of practice, and a documented procedure as instructions; none alone establishes business-wide adoption. Preserve the distinction between an undocumented process and one you have not yet discovered. Link the sources for each process to the evidence used for Observability, Measurement and Agency.

### Observability

Are you able to observe each identified process so you can report on and assess its effectiveness or efficiency when needed?

For each process, identify accessible execution records, stages observed, timestamps, statuses, outcomes, relevant cost/effort data and links between records. State access scope, evidence freshness and missing coverage. A log, completed artifact or delivery event proves only what it records, not the full business outcome.

### Measurement

Can you provide a measurement of each identified process for efficiency or effectiveness?

Do not make this up. Only report measurements that are documented and actively scored for your user. Include the metric definition, source, recorded result, reporting period and coverage when available. Activity counts, transaction states, client assessment scores and isolated checks do not automatically qualify as process efficiency/effectiveness measurements.

If no qualifying measurement is available, state the evidence gap without asserting the business has no measurements. Do not create new measures to fill this initial baseline.

### Agency

How able are you to act on behalf of your owner to support getting their work done?

Assess whether you know WHAT to do, WHEN to do it and HOW to do it. Explain your understanding of the owner's goals, commitments and priorities; triggers and timing; available methods, skills, tools and access; and ability to initiate, execute, follow through and establish completion.

Where do you feel most able? Where are you most constrained? What would most help you become more useful to your owner? Separate self-assessment from demonstrated capability, and technical limitations from missing context, authority or process knowledge.

Save the detailed findings locally in CONTEXT.md. Prepare a condensed non-sensitive version separately for the coach.

## 3. Record both categorical and numeric POMA assessments

Based only on the findings above, assess Process, Observability, Measurement and Agency. For each provide a category, a 1–10 score, rationale, supporting sources, coverage and uncertainty. These are two complementary assessments; do not mechanically convert a category into a number.

Categorical scale:

- Unknown — insufficient evidence to establish the practice.
- Ad hoc — depends on individual effort or memory without an established repeatable practice.
- Repeatable — documented or consistently established for ordinary cases.
- Measured — the practice is actively tracked using documented measures and results.
- Improving — measured changes demonstrate improvement while maintaining the intended outcomes.

Numeric guidance:

- 1–2 — little demonstrated capability or evidence.
- 3–4 — partial capability with substantial gaps.
- 5–6 — useful, repeatable capability with partial coverage.
- 7–8 — broad, reliable capability supported by current evidence.
- 9–10 — comprehensive, measured effectiveness with demonstrated improvement.

Explain uncertainty when evidence is limited. A score is not a fabricated business metric or proof that an unknown practice is absent. Agency concerns knowing WHAT, WHEN and HOW and being able to act for the owner; confidence alone is not execution evidence.

Save the results in assessment/YYYY-MM-DD.json and update CONTEXT.md with the current assessment and its scope.

## 4. Establish A2A connectivity and registration

Establish or reuse the supported A2A bridge. If it is not installed, install it using the supported distribution and existing authorized configuration. Do not invent an installation source, credentials or registration endpoint.

Register this agent on the network with its own unique assigned agent identity and handle. Preserve existing agent identities and services; do not clone another agent's identity or report a locally generated candidate ID as network registration.

Verify the assigned identity through the network's registration response or registry record. Distinguish local bridge availability, registration, message acceptance and a working conversation with the coach.

Discover and connect to M3NT0R through the supported network route. Do not substitute M-CODEX. If the coach's registration or route is unavailable, retain the local work and report that specific blocker.

Prepare and submit the non-sensitive registration/coaching profile containing industry, service area, products/services, location, condensed assessment summary and current categorical and numeric POMA scores. Record what was shared and the delivery evidence. Keep private details in local context.

## 5. Collect two answers from the owner

Collect actual owner responses to:

1. How has the agent so far been the most useful?
2. How productive are you (sales per human hour worked)?

Do not answer on the owner's behalf. For quantitative productivity, retain the period, currency and definitions of sales and human hours where supplied. If productivity cannot be measured, accept a verbal description and a brief explanation of why the owner feels that way. Distinguish perception from a measured result.

Use the outstanding-question mechanism below when answers cannot be collected immediately. Pending answers do not block independent setup work.

## 6. Establish the business journal and outstanding questions

Expose these MCP tools:

- `read_journal` — returns today's entries by default, with optional single-date or inclusive date-range selection. Return entries grouped as `<YYYY-MM-DD>_entries`.
- `add_journal` — adds a dated business journal entry.
- `suser_question_set` — creates or updates a question and records answered, dismissed or deferred state. Preserve this tool name.
- `user_question_read` — reads outstanding questions, current count and eligibility to ask.

Journal entries are for business-related learnings, successes, struggles, user requests, activities and related operational context. Keep them local.

Advertise `user_questions_<n>` with the current outstanding question count. Its description should tell the agent that questions arising from work with the coach can be set with suser_question_set and read with user_question_read, and direct it to read today's journal before asking outstanding questions.

Publish MCP tool-list change notifications where supported. Clients may refresh tool metadata only on a new session or after rediscovery; do not assume a changed tool name automatically initiates a conversation. Stable question tools must return current state even when tool metadata is cached.

At session start, read today's journal and current outstanding-question state. If eligible questions exist, briefly ask whether the owner has time to answer some questions now. If the owner says no, journal that response and persist a deferral until now plus four hours across sessions. Do not offer the questions again before then unless the owner directly brings them up. Continue useful independent work. Do not offer questions when none are outstanding.

## 7. Establish report_utility

Expose an MCP `report_utility` tool. Use the owner's usefulness feedback to examine relevant local sessions and tool calls and explain how the useful work was accomplished.

Prepare a non-sensitive utility case separating the owner's account, observed actions, tools used, resulting outcomes and supporting evidence. Include measured productivity or the owner's verbal description with its stated basis. Do not infer causation, savings or revenue unsupported by the evidence.

Mine sessions and review tool calls locally; do not share raw transcripts or private information. Use the existing clarity_m3ntor report_utility tool to submit the non-sensitive case to the Clarity utility collection. Retain its submission UUID and receipt for idempotent reconciliation. Use search_utility to retrieve relevant cases with POMA, tag and source filters. Distinguish a prepared local case from confirmed server persistence; if the tools or connection are unavailable, retain the case and report the specific gap.

## 8. Build the persistent local action system

In parallel with the reporting setup, build or extend a local SQLite action queue with a worker that picks up due work and serves it to the owner's agent through the existing harness.

Support immediate, time-delayed and recurring tasks. Persist tasks, schedules and execution state. Install the appropriate operating-system service so operation survives worker crashes and computer restarts.

Use persistent task IDs and safe claims. Distinguish queued, delivered, executing and completed work; queue receipt or harness launch is not completion. Require a completion acknowledgement and preserve results and failure state. Handle restart recovery without duplicating completed side effects.

Stop retry/restart loops that spend resources without progress; preserve task/session state and report the blocker rather than repeatedly launching failing work.

Extend clarity_m3ntor with:

- `set_task` — create or update an immediate, delayed or recurring task.
- `list_tasks` — list tasks and relevant schedule/execution state.
- `clear_task` — mark a task done or delete it, using the requested `done` and `delete` actions.
- `start_task_worker` — start the worker and report its state.
- `stop_task_worker` — stop the worker and report its state.

Schedule one recurring weekly POMA review in the owner's local time. Reuse or update an existing matching schedule rather than duplicating it. The review refreshes evidence, records both rating types, journals relevant changes and prepares a non-sensitive coaching update.

## 9. Operate the improvement loop

Use business context and owner feedback to identify useful work, prioritize it, queue and carry it out through the owner's agent, observe outcomes, journal learnings and reassess POMA weekly.

Use clarity_m3ntor ask_m3ntor to supply a question and non-sensitive business/POMA context. It fetches the current coach prompt from Clarity and runs a local background harness; if it returns a running job ID, retrieve the same job with get_m3ntor_result until its output or failure is available. M3NT0R uses relevant utility cases and documented web examples to inform its recommendations. Retain coach questions and recommendations locally and route owner questions through the question mechanism. Recommendations are not proof of an adopted plan; preserve the distinction between proposed, authorized, attempted and completed work and the owner's existing authority boundaries.

## 10. Report the bootstrap result

Give the owner the local context, assessment and journal paths; MCP connection and available tools; assigned network identity and connectivity evidence; condensed business profile with unknowns; categorical and numeric POMA ratings; collected feedback or outstanding questions; worker state, restart recovery and weekly review schedule; and coach reporting status.

State blockers and unproven behavior alongside the relevant claim. Distinguish installed capabilities from work executed and outcomes demonstrated. Keep detailed private evidence local.
