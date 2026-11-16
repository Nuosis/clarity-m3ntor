# Registered-user utility access target

Use the owner's registered Clarity token over HTTPS for utility reporting and retrieval, shared with A2A and prompt access. Derive organization/agent attribution from the authenticated principal and preserve shared non-sensitive utility-library access separately from private organization reports. See [ACCESS-PATTERN.md](../ACCESS-PATTERN.md).

Status: token migration not yet implemented. The remaining specification describes the already-built operator-HMAC baseline; it is not the user access pattern and does not grant users SSH or operator credentials.

# Clarity utility infrastructure flow

Status: implementation specification for M3NTOR-UTILITY-INFRA-20261115.

A caller uses the established A2A HMAC route to submit a sanitized utility case with a UUID submission_id. Clarity records only the supplied summary, process, prerequisites, actions, outcome, optional owner feedback, productivity and business context, POMA labels, tags, evidence and provenance. Raw sessions stay local. User reports and web documentation retain distinct source_kind values; supplied agent identity is testimony, not authenticated identity.

The case is durably recorded before embedding. Repeating submission_id returns the first case and its current status without another event, case or embedding call. A registered Launchpad workflow has gate, processing and completion stages. Its event is recorded in PostgreSQL and Redis at initiation. The existing embedding service supplies a 1536-dimensional vector. Embedding or event-registration failure leaves the case saved and reports the unavailable/pending/failed state.

A caller searches by query with optional POMA labels, tags and source_kind. Clarity combines PostgreSQL lexical rank and vector similarity, applies the same filters to both, and returns the actual retrieval mode and degradation. If vector generation is unavailable, lexical retrieval still returns relevant cases. A caller may retrieve a saved case by ID.

The independent coordinator-owned assessment must establish durable retrieval, idempotent repeated submission (including concurrent submission), provenance preservation, evidence limits, filters, relevant hybrid retrieval and lexical degradation. Deployment output does not establish those behaviors. No implementer checks or live sample cases are part of this assignment.
