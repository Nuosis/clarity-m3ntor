# Clarity M3NT0R MCP

Status: core Codex coaching transport, utility reporting/search and controlled recovery behavior independently assessed. The business-POMA/reassessment revision awaits independent review and assessment. Live Claude success, saved-assessment UI and positive degraded-search behavior remain unassessed.

Local HTTP MCP for an owner's agent to ask M3NT0R for coaching. It extends the
existing Clarity Coach service and retains its assessment, journal and question
tools. No dependency install is needed; use Node.js 22 or newer, an installed
Codex or Claude Code CLI with its existing login, and the existing SSH route to
the Clarity server.

Start the bootstrap in the owner's already-chosen local harness and express the
intent to connect to Clarity M3NT0R there. The bootstrap reuses that current
harness, workspace and established access. POMA concerns the owner's business:
its processes and agent utilization; accessible, current business state; business
process efficiency/effectiveness measures; and actual triggered action backed by
POM, direction/policies and durable execution infrastructure.

## Start

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

## Reassess the business separately

Call `reassess_poma` with `{}` or optional `context`/`harness`. It requires no
question and selects the fixed business-reassessment task and current remote
`poma_reassessment_prompt.md`. The same detached runner, brief wait and
`get_m3ntor_result` retrieve either kind of job; `task` distinguishes `coaching`
from `poma_reassessment` in the durable request/state. The caller cannot choose a
prompt path through tool input. `ask_m3ntor` keeps using the mentor prompt.

The standalone prompt directs the owner's local AI to read private context,
journals, previous dated assessments and relevant current business sources;
refresh affected evidence; assess Process, Observability, Measurement and Agency
with independent category/1–10 ratings; distinguish business change from new
evidence; and preserve private dated revisions. Existing save/report routes are
reused where applicable, with local file operations for standalone saving. A
returned model response or successful CLI exit does not prove those files saved;
use the actual local artifact/readback evidence and separate coaching summary.

For productivity the local AI first searches established financial/sales and
human working-hours evidence and attempts `sales / TOTAL human hours` for a
matching reporting period and business scope. It retains sources/dates, currency,
definitions, people/work coverage and exclusions locally. Supported partial
estimates name assumptions; missing hours are not replaced with AI usage or one
person's hours. Targeted missing-input questions and verbal-feedback fallback
follow source discovery. A first calculation does not establish ongoing business
process Measurement. Detailed business records remain local; only a separate
non-sensitive synthesis is eligible for coaching/report sharing.

The bootstrap describes one system-scheduled weekly reassessment that calls
`reassess_poma` and retrieves the same job. That scheduled assessment is separate
from the event/work-driven productivity-improvement loop. Starting this package
or calling reassessment does not install a scheduler or new action worker.

## Configuration

Environment variables are read from the process; `.env` files are not loaded.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4317` | HTTP service port; choose an unused port for a second copy. |
| `M3NTOR_WORKSPACE` | Owner's home directory | Local business context and harness working directory. |
| `M3NTOR_HARNESS` | Assessment harness, then `codex` | Existing CLI to run; `codex` or `claude`. |
| `M3NTOR_SSH_HOST` | `clarity` | Existing SSH alias/host used to read the prompt. |
| `M3NTOR_PROMPT_PATH` | `/opt/clarity-m3ntor/m3ntor_agent_prompt.md` | Current server prompt; fetched for each new job. |
| `M3NTOR_REASSESSMENT_PROMPT_PATH` | `/opt/clarity-m3ntor/poma_reassessment_prompt.md` | Current server reassessment prompt; selected only by `reassess_poma`. |
| `M3NTOR_JOB_DIR` | `.m3ntor-runtime/jobs` beside the source | Private durable job directory. Use an ignored or external location. |
| `M3NTOR_WAIT_MS` | `1500` | Brief ask response wait; does not terminate a running job. |

SSH uses the existing configuration with `BatchMode=yes`; no keys, users,
credentials or alternative routes are installed. Fetch failure or an empty
prompt fails that job. The bundled prompt is a publishing source, never a stale
runtime fallback.

## Utility cases

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

Both operations read the existing `~/.config/a2a-bridge/config.json` and use its
`api_url` and `hmac_secret_command` argument array. The secret command runs
without a shell; its output stays in memory. Requests use the bridge's existing
HMAC-SHA256 `Authorization: Bearer <signature>.<timestamp>` signing over the
exact JSON request body, preserving any configured API URL prefix. No alternate
secret, account or auth configuration is installed. The client uses the existing
transport's 30-second request convention and does not automatically retry or
follow redirects. Missing configuration, secret-command failure and upstream
errors remain explicit failed tool calls. The separate Clarity server utility
API/database must be deployed for these tools to return real stored results.

## Publish the server prompts

`m3ntor_agent_prompt.md` and `poma_reassessment_prompt.md` are the sources to
publish. Destination directories must be writable by the existing SSH account.
The following stages both files and atomically replaces each prompt using the
same SSH alias, without changing services or auth:

```sh
python3 - <<'PY'
from pathlib import Path
import json, os, shlex, subprocess

prompts = [
    {'path': os.environ.get('M3NTOR_PROMPT_PATH', '/opt/clarity-m3ntor/m3ntor_agent_prompt.md'),
     'content': Path('m3ntor_agent_prompt.md').read_text()},
    {'path': os.environ.get('M3NTOR_REASSESSMENT_PROMPT_PATH', '/opt/clarity-m3ntor/poma_reassessment_prompt.md'),
     'content': Path('poma_reassessment_prompt.md').read_text()},
]
remote = '''import json, os, sys, tempfile
from pathlib import Path
staged = []
try:
    for item in json.load(sys.stdin):
        target = Path(item['path'])
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix='.' + target.name + '.', dir=target.parent)
        staged.append((temporary, target))
        with os.fdopen(fd, 'wb') as stream:
            stream.write(item['content'].encode('utf-8'))
            stream.flush()
            os.fsync(stream.fileno())
    for temporary, target in staged:
        os.replace(temporary, target)
finally:
    for temporary, target in staged:
        if os.path.exists(temporary): os.unlink(temporary)
'''
subprocess.run(
    ['ssh', '-T', '-o', 'BatchMode=yes', '--', os.environ.get('M3NTOR_SSH_HOST', 'clarity'),
     'python3 -c ' + shlex.quote(remote)],
    input=json.dumps(prompts).encode('utf-8'), check=True)
PY
```

Each rename replaces a complete prompt; a publication error must be reconciled
per file. The next job reads its selected server prompt and records fetch time,
path and SHA-256 in private job state. There is no bundled fallback or service
restart needed to select newly published prompt contents.

## Stored data and scope

The repository contains source, the bootstrap, mentor and standalone reassessment
prompts. `.data` holds private assessment state; `.clarity_coach` holds local
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
