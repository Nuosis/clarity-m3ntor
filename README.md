Status: account signup/registration, identity, prompt delivery, assessment summary submission, utility cases and A2A message routes use a registered Clarity `clrtok_` token over HTTPS (`register.mjs`). The package's local A2A receiver still uses the a2a-bridge CLI.

Local HTTP MCP for an owner's agent to ask M3NT0R for coaching using the owner's
Codex or Claude Code harness. It extends the Clarity Coach service and retains
its POMA (Process, Observability, Measurement and Agency) assessment, journal and question
tools. No dependency install is needed; use Node.js 22 or newer, an installed
Codex or Claude Code CLI with its existing login. User-facing server access must
use a registered Clarity token over HTTPS, shared by the local MCP and A2A client.
Users need no SSH access or operator secret.

Start the bootstrap in the owner's already-chosen local harness and express the
intent to connect to Clarity M3NT0R there. The bootstrap reuses that current
harness, workspace and established access. POMA concerns the owner's business:
its processes and agent utilization; accessible, current business state; business
process efficiency/effectiveness measures; and actual triggered action backed by
POM, direction/policies and durable execution infrastructure.

## User access

Start in the chosen harness. The agent registers/signs in with Clarity through HTTPS APIs and receives its assigned agent identity and `clrtok_` token directly, with no browser or UI step. Later sessions sign in using that stored token; account enrollment is not repeated. Both A2A and MCP remote operations use that same credential source. Store only its secret reference plus API/organization/agent metadata in the local profile. Prompt retrieval, assessment reporting and utility reporting/search/read use HTTPS bearer authentication. Private business records and detailed calculations stay local.

The [access contract](ACCESS-PATTERN.md) records the deployed routes and the remaining A2A work. Do not use another user's SSH/HMAC configuration to bypass a missing product capability.

## Start the local service

For manual service setup, start this copy on an unused port and configure the
current harness's CLI name. The original service may already use 4317.

```sh
cd /path/to/clartityM3NTOR
export PORT=4318
export M3NTOR_WORKSPACE=/path/to/business/workspace
export M3NTOR_HARNESS=codex
npm start
```

The MCP URL in this example is `http://127.0.0.1:4318/mcp/local`. It works with an
empty `.data` directory and requires no interview or assessment. The existing UI
remains at `http://127.0.0.1:4318/`; existing assessment connections remain at
`/mcp/<assessment-id>`. When a saved assessment exists for the local workspace,
`/mcp/local` continues to use its context and tools. Otherwise it exposes coaching,
local context, journal and question tools without creating an assessment.

To use a single Codex invocation with this MCP without changing global config:

```sh
codex -c 'mcp_servers.clarity_m3ntor.url="http://127.0.0.1:4318/mcp/local"'
```

For a compatible HTTP MCP client, use the name `clarity_m3ntor` and the URL above.
Claude Code accepts this configuration via its existing `--mcp-config` option:

```json
{
  "mcpServers": {
    "clarity_m3ntor": {
      "type": "http",
      "url": "http://127.0.0.1:4318/mcp/local"
    }
  }
}
```

These are configuration examples. Starting the server does not register an MCP
globally, change authentication, restart another service, or start model work.
The HTTP server listens only on loopback and checks the request Host/Origin.
Keep it local; this package does not add remote-user authentication.

## Ask and retrieve

Call `ask_m3ntor` with:

```json
{
  "question": "What should I discover next to help my owner follow up on work?",
  "context": {
    "known": "I can read current customer messages but have not found the work commitments.",
    "poma": { "Observability": "Partial visibility; no process measure established." }
  }
}
```

`context` may be text or JSON. Include only the non-sensitive information the
coach needs. The optional `harness` selects an existing `codex` or `claude` CLI.
Without it, the service's `M3NTOR_HARNESS`, assessment harness, or default `codex`
is selected in that order. A failed selection does not trigger a fallback.

Each call creates a new job, fetches the current remote prompt, then starts a
detached local worker using the selected harness's model, authentication,
permissions and account configuration. It does not pass a model override or
change any auth/billing route. Questions and context travel through private files
and stdin, never shell interpolation. The worker supplies this same local MCP URL
to the harness without changing saved MCP settings.

The response includes `job_id`, lifecycle `status` and prompt provenance. A fast
completed job also includes `output`. For `queued` or `running`, call
`get_m3ntor_result` with `{"job_id":"<returned-id>"}` until it reaches a terminal
state. Retrieval never launches work. `complete` means the harness exited
successfully with nonempty final text. `failed` includes the actual failure;
`interrupted` means the worker disappeared without a recorded final result and
reports whether the observed harness PID is still alive. Neither is coaching
success. Partial output and transcripts remain in the private job directory.

The brief response wait does not limit execution time. A detached worker can
finish after the HTTP server stops, and the same result is retrievable after a
restart with the same job directory. The worker does not restart a job or
substitute credentials. A first ordinary recoverable retry notice alone does
not stop the harness. Hard quota/usage rejections stop immediately; distinct
retry attempts without intervening new model text, tool results or completed
work stop a demonstrated wasting loop. Duplicate JSON/stderr notices for the
same attempt, heartbeat/session events and repeated logs do not establish new
attempts or useful progress. Raw stdout/stderr and recovery/progress annotations
are retained alongside final output.

## Assess the business: baseline and later runs

Call `assess_poma` with `{}` or optional `context`/`harness`. No question is
required. It selects the ONE current remote `poma_initial_assessment_prompt.md`
for both the first baseline and later/weekly assessments. `reassess_poma` is a
compatibility alias using the same prompt and task. The existing detached runner,
brief wait and `get_m3ntor_result` retrieve either coaching or assessment jobs;
new assessment requests use task identity `poma_assessment`, while existing
`poma_reassessment` jobs remain supported. The caller cannot choose a prompt path
through tool input. `ask_m3ntor` keeps using the mentor prompt.

The unified prompt directs the owner's local AI to read private context,
journals, previous dated assessments and relevant current business sources. It
establishes a baseline when none exists; otherwise it reuses valid findings,
refreshes affected evidence and compares business change with newly discovered
evidence rather than indiscriminately rescanning. It assesses Process,
Observability, Measurement and Agency with independent category/1–10 ratings and
preserves private dated revisions. It calls the local MCP service's
`save_poma_reassessment` with the task's job UUID as a stable `revision_id`, so
an inherited read-only harness can save without broader filesystem permissions.
A returned model response or successful CLI exit does not prove those files
saved; use the actual per-artifact receipts and local readback.

`save_poma_reassessment` accepts prepared four-area `ratings`, `evidence`,
`coverage`, `uncertainty`, `comparison`, `productivity`, a `context_update`
Markdown section, `journal_entry`, and SEPARATE non-sensitive `coaching_summary`.
`status` defaults to `draft`; the actual `harness` can be supplied when known.
Paths are fixed by this MCP connection's business workspace. The service saves
`.clarity_coach/assessment/YYYY-MM-DD.json`, preserves previous daily schema and
revisions, appends/updates that revision's section in `CONTEXT.md`, upserts one
local journal entry and writes `.clarity_coach/reports/<revision_id>.md`.
`.clarity_coach/reassessments/<revision_id>.json` records stable date/time and
per-artifact save receipts for reconciliation. Same-ID saves do not duplicate
entries/sections; individual files are atomic and workspace writes serialized.
Partial failures return the confirmed effects and actual error, with the same ID
available to reconcile them. This route works outside an active interview and
does not submit private assessment, context or financial data to a server.
Model, authentication, account, billing, sandbox and existing approval settings
remain inherited. Direct file operations remain a fallback when supported.

For productivity the local AI first searches established financial/sales and
human working-hours evidence and attempts `sales / TOTAL human hours` for a
matching reporting period and business scope. It retains sources/dates, currency,
definitions, people/work coverage and exclusions locally. Supported partial
estimates name assumptions; missing hours are not replaced with AI usage or one
person's hours. Targeted missing-input questions and verbal-feedback fallback
follow source discovery. A first calculation does not establish ongoing business
process Measurement. Detailed business records remain local; only a separate
non-sensitive synthesis is eligible for coaching/report sharing.

The bootstrap describes one system-scheduled weekly assessment that calls
`assess_poma` with the same prompt and retrieves the same job. The old
`reassess_poma` name remains an alias. That scheduled assessment is separate
from the event/work-driven productivity-improvement loop. Starting this package
or calling reassessment does not install a scheduler or new action worker.

## Configuration

Environment variables are read from the process; `.env` files are not loaded.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4317` | HTTP service port; choose an unused port for a second copy. |
| `M3NTOR_WORKSPACE` | Owner's home directory | Local business context and harness working directory. |
| `M3NTOR_HARNESS` | Assessment harness, then `codex` | Existing CLI to run; `codex` or `claude`. |
| `M3NTOR_CONFIG` | `~/.config/clarity_m3ntor/config.json` | Clarity connection profile written by `register.mjs`. |
| `M3NTOR_JOB_DIR` | `.m3ntor-runtime/jobs` beside the source | Private durable job directory. Use an ignored or external location. |
| `M3NTOR_WAIT_MS` | `1500` | Brief ask response wait; does not terminate a running job. |

Each new job fetches its current prompt (`coach` or `poma-assessment`) from
`GET /agent/mentor/prompts/{id}` with the installation token and records its
SHA-256 and publish time in private job state. A missing profile, rejected token
or empty prompt fails that job; there is no bundled fallback.

## Utility cases

All three utility operations authenticate with the registered installation token. Clarity attributes token submissions to the token's registered agent.

`report_utility` sends a caller-prepared non-sensitive case to
`POST /agent/utility/cases`. Required fields are `submission_id` (UUID), `title`,
`summary`, `process`, `prerequisites` (string array), `agent_actions` (string
array), `outcome`, `poma_labels`, `tags`, `evidence` and `source_kind`. POMA labels
are `Process`, `Observability`, `Measurement`, `Agency`. `evidence.kind` is
`owner_reported`, `measured` or `demonstrated`; optional `limitations` and
`source_refs` are string arrays. `source_kind` distinguishes `user_reported`
from `web_documented`. Optional fields are `owner_feedback`, `productivity`
(object), `business_context` (object), `source_url`, `source_date` and `agent_id`.
Keep the same submission UUID when reconciling a submission. The API owns
idempotent persistence; a network error is not a confirmed saved case.

`search_utility` calls `POST /agent/utility/search` with `query`, optional
`poma_labels`, `tags`, `source_kind` and `limit`. It returns the actual search
response. These client tools do not mine raw local sessions or generate evidence
on the owner's behalf; the local agent supplies the sanitized report.

Both operations use the shared client in `clarity-client.mjs`: the profile's `api_url` and `token_command` (or `token_env`), `Authorization: Bearer <token>`, a 30-second timeout, no automatic retry and no redirects. Missing registration, token-command failure and upstream errors remain explicit failed tool calls.

## Operator-only server prompt maintenance

`m3ntor_agent_prompt.md` and `poma_initial_assessment_prompt.md` are private
operator publishing files, absent from fresh clones. The API serves them from
`/opt/clarity-backend/app/state/m3ntor-prompts/` on the Clarity host (mounted at
`/app/state/m3ntor-prompts`, override with `M3NTOR_PROMPT_DIR`). Publish by
atomically replacing each file there with the operator's SSH access; the next
job fetches the new content without a restart.

## Stored data and scope

The current Git tree contains source, bootstrap and access/flow documentation.
The private local `poma_initial_assessment_prompt.md` and
`m3ntor_agent_prompt.md` publishing files are retained on the operator machine
and explicitly ignored; they are absent from fresh checkouts. The obsolete
`poma_reassessment_prompt.md` is deleted locally and from the tracked tree and
ignored against accidental re-addition. `.data` holds private assessment state; `.clarity_coach` holds local
business context/journals; `.m3ntor-runtime` holds private coaching requests,
fetched prompts, harness input, command metadata, PIDs, stdout/stderr and results.
Job files are owner-only, separate from the assessment JSON loader. These
directories, environment files, logs and credentials are ignored by Git. Do not
copy an existing owner's runtime data into a new installation or commit custom
runtime locations.

The source was copied from the tracked `clarity-coach` service. Its unrelated
untracked action queue, business loop, service control and worker drafts are not
part of this package. The utility database/API is separately deployed on Clarity;
this local package supplies its MCP client. The supplied bootstrap describes
broader work and is not executed by startup.

The backend flow and criteria for independent assessment are in
[M3NTOR-FLOW.md](M3NTOR-FLOW.md). No repository test suite is added.
