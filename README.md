# Clarity M3NT0R MCP

Status: source package; independent runtime assessment pending.

Local HTTP MCP for an owner's agent to ask M3NT0R for coaching. It extends the
existing Clarity Coach service and retains its assessment, journal and question
tools. No dependency install is needed; use Node.js 22 or newer, an installed
Codex or Claude Code CLI with its existing login, and the existing SSH route to
the Clarity server.

## Start

Start this copy on an unused port. The original service may already use 4317.

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
restart with the same job directory. There is no automatic model retry, restart
or credential substitution. Actual provider rejection/retry events stop the
wasting harness and preserve its evidence, per the owner's stop-spending rule.

## Configuration

Environment variables are read from the process; `.env` files are not loaded.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4317` | HTTP service port; choose an unused port for a second copy. |
| `M3NTOR_WORKSPACE` | Owner's home directory | Local business context and harness working directory. |
| `M3NTOR_HARNESS` | Assessment harness, then `codex` | Existing CLI to run; `codex` or `claude`. |
| `M3NTOR_SSH_HOST` | `clarity` | Existing SSH alias/host used to read the prompt. |
| `M3NTOR_PROMPT_PATH` | `/opt/clarity-m3ntor/m3ntor_agent_prompt.md` | Current server prompt; fetched for each new job. |
| `M3NTOR_JOB_DIR` | `.m3ntor-runtime/jobs` beside the source | Private durable job directory. Use an ignored or external location. |
| `M3NTOR_WAIT_MS` | `1500` | Brief ask response wait; does not terminate a running job. |

SSH uses the existing configuration with `BatchMode=yes`; no keys, users,
credentials or alternative routes are installed. Fetch failure or an empty
prompt fails that job. The bundled prompt is a publishing source, never a stale
runtime fallback.

## Publish the server prompt

`m3ntor_agent_prompt.md` is the source to publish. The destination directory must
be writable by the existing SSH account. The following uses the same SSH alias
and atomically replaces only that prompt, without changing services or auth:

```sh
python3 - <<'PY'
from pathlib import Path
import os, shlex, subprocess

source = Path('m3ntor_agent_prompt.md').read_bytes()
destination = os.environ.get('M3NTOR_PROMPT_PATH', '/opt/clarity-m3ntor/m3ntor_agent_prompt.md')
remote = '''import os, sys, tempfile
from pathlib import Path
target = Path(sys.argv[1])
target.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix='.m3ntor_agent_prompt.', dir=target.parent)
try:
    with os.fdopen(fd, 'wb') as stream:
        stream.write(sys.stdin.buffer.read())
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
'''
subprocess.run(
    ['ssh', '-T', '-o', 'BatchMode=yes', '--', os.environ.get('M3NTOR_SSH_HOST', 'clarity'),
     'python3 -c ' + shlex.quote(remote) + ' ' + shlex.quote(destination)],
    input=source, check=True)
PY
```

Publish failure leaves the previous prompt in place. The next ask reads the
server again and records its fetch time, path and SHA-256 in private job state.

## Stored data and scope

The repository contains source, the supplied bootstrap document and the coach
prompt. `.data` holds private assessment state; `.clarity_coach` holds local
business context/journals; `.m3ntor-runtime` holds private coaching requests,
fetched prompts, harness input, command metadata, PIDs, stdout/stderr and results.
Job files are owner-only, separate from the assessment JSON loader. These
directories, environment files, logs and credentials are ignored by Git. Do not
copy an existing owner's runtime data into a new installation or commit custom
runtime locations.

The source was copied from the tracked `clarity-coach` service. Its unrelated
untracked action queue, business loop, service control and worker drafts are not
part of this package. This change does not implement a utility database, semantic
collection search or `report_utility`; the coach is told those tools are absent.
The supplied bootstrap describes broader work and is not executed by startup.

The backend flow and criteria for independent assessment are in
[M3NTOR-FLOW.md](M3NTOR-FLOW.md). No repository test suite is added.
