# Clarity utility extension

Status: additive infrastructure source; runtime behavior awaits independent assessment.

This directory owns the Clarity backend extension for M3NTOR-UTILITY-INFRA-20261115. The root MCP module is maintained separately. The process specification is in FLOW.md.

## API contract

All three routes use the existing A2A service HMAC and organization-context dependency. No credentials, middleware exemptions, provider routes or billing settings are installed.

- `POST /agent/utility/cases`: submission_id UUID; title, summary, process, prerequisites string array, agent_actions string array, outcome, optional owner_feedback, productivity object, poma_labels (Process/Observability/Measurement/Agency), tags, business_context object, evidence (kind owner_reported/measured/demonstrated, limitations, source_refs), source_kind user_reported/web_documented, optional source_url/source_date/agent_id. Only caller-sanitized content belongs in this contract; extra root fields are rejected. Agent identity remains caller supplied. Reuse submission_id to reconcile an uncertain receipt.
- `POST /agent/utility/search`: query, optional poma_labels, tags, source_kind, limit (positive integer, default 10). All supplied tags and POMA labels must match; tag comparisons ignore case. Results contain case, case_id, reciprocal-rank score and available lexical/vector ranks, retrieval_mode/search_mode and degradation.
- `GET /agent/utility/cases/{UUID}`: saved case or 404.

A submission receipt has status recorded/existing, case_id, case with lifecycle status recorded, embedding_status pending/ready/failed, event_registration_status and optional error class. New operations also return event_id/workflow_status. A recorded case is not evidence of measured business success: owner feedback, evidence kind/limitations and source_kind remain unchanged.

A unique submission_id and PostgreSQL conflict handling prevent duplicate case/event/embedding creation, including concurrent calls. Case + initial PostgreSQL event share a transaction; Redis event registration precedes workflow processing. Redis failure leaves a saved pending case, registration failed and a degradation reason. Repeated submission returns that same state without automatically restarting work. No scheduler or retry loop is installed.

Embeddings reuse services.embedding_service.embed_text (existing Vault route, text-embedding-3-small, 1536 dimensions). Failed embedding leaves the case available for lexical retrieval. Search reports lexical when vector generation/retrieval is unavailable or no filtered case has an embedding. PostgreSQL full text and title trigram candidates are ranked alongside exact cosine vector candidates, using reciprocal rank fusion. Exact vector search is intentional for this initial collection; no approximate index is needed to preserve recall under filters.

## Deployment

Commit server/ first. Upload this directory to a remote scratch path using established `ssh clarity`. Run `python3 /scratch/server/install.py --target /opt/clarity-backend`; it adds only this module/migration, API registration and mandatory workflow registration. Apply `migrations/0065_agent_utility_cases.sql` with psql `ON_ERROR_STOP=1` through `supabase-db`, on stdin, inside a transaction. The matching Alembic migration supports a future standard migration run and the SQL is idempotent. Direct SQL application does not advance unrelated Alembic revisions.

The API bind mount updates files without re-importing them. Production `/app/start.sh` runs Uvicorn workers without `--reload`. After committing the narrow installed paths, activate them with an API-only restart: `ssh clarity 'sudo docker restart --time 30 clarity_backend_api'`. This reuses the existing container configuration. Read back the container StartedAt/status to record the load operation; independent assessment must establish that the routes are serving the requested behavior. No stack rebuild or Celery worker/scheduler restart is required: the registered workflow runs inline, off the API event loop, after both event registrations.

Stage and commit only the seven installed utility paths. Preserve unrelated dirty work. Installer output records deployed file hashes; source commit, remote commit, migration output and API restart output belong in the outside-repository delivery report. Installed-source hashes, migration output and runtime start time are deployment evidence, not proof of API behavior.

For removal, remove the narrow router/workflow registry additions before removing modules. Keep utility records unless explicitly authorized to delete them. Do not drop shared extensions. No managed processes need stopping or resuming.
