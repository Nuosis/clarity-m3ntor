# Ask M3NT0R backend flow

Status: implementation acceptance specification; runtime assessment pending.

An owner’s agent connects to the local `clarity_m3ntor` MCP. It asks M3NT0R a
question and supplies the non-sensitive business/POMA context it wants the coach
to consider. No interview, assessment record, or copied owner data is required.

For each request the service records a new private job, reads the current
`m3ntor_agent_prompt.md` from the configured Clarity server through its existing
SSH configuration, and records the source, fetch time and SHA-256. It supplies
that exact prompt, question and context to the selected existing local Codex or
Claude Code harness, using its existing authentication and model configuration.
A detached local worker owns that run and writes the final output or actual
failure to the job. It does not launch an automatic retry or substitute a model,
provider, credential or stale bundled prompt.

The ask call waits briefly. If the harness has finished, it returns the stored
output. Otherwise it returns a running job ID. The agent retrieves that same
job using `get_m3ntor_result`; retrieval never starts another harness. Job state
and output survive an MCP server restart, and the detached worker can finish
while the HTTP service is stopped. A launch receipt is not a coaching result.

The existing assessment-scoped MCP and its journal, question, interview and
report behavior remain available.

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
   runtime/assessment directories. `/mcp/local` initializes, lists both new
   tools, and accepts a question without creating or requiring an interview.
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
   advice or completion. No automatic retry is started. Quota/retry events stop
   the wasting harness and retain evidence. A nonexistent job is reported.
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

This specification requires real-service backend assessment by the independent
executor. The implementation executor does not claim any criterion passed.
