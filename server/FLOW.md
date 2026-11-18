# Registered-user utility access target

Use the owner's registered Clarity token over HTTPS for utility reporting and retrieval, shared with A2A and prompt access. Derive organization/agent attribution from the authenticated principal and preserve shared non-sensitive utility-library access separately from private organization reports. See [ACCESS-PATTERN.md](../ACCESS-PATTERN.md).

Status: token migration not yet implemented. The remaining specification describes the already-built operator-HMAC baseline; it is not the user access pattern and does not grant users SSH or operator credentials.

# Clarity utility infrastructure flow

Status: implementation specification for M3NTOR-UTILITY-INFRA-20261115.

A caller uses the established A2A HMAC route to submit a sanitized utility case with a UUID submission_id. Clarity records only the supplied summary, process, prerequisites, actions, outcome, optional owner feedback, productivity and business context, POMA labels, tags, evidence and provenance. Raw sessions stay local. User reports and web documentation retain distinct source_kind values; supplied agent identity is testimony, not authenticated identity.

The case is durably recorded before embedding. Repeating submission_id returns the first case and its current status without another event, case or embedding call. A registered Launchpad workflow has gate, processing and completion stages. Its event is recorded in PostgreSQL and Redis at initiation. The existing embedding service supplies a 1536-dimensional vector. Embedding or event-registration failure leaves the case saved and reports the unavailable/pending/failed state.

A caller searches by query with optional POMA labels, tags and source_kind. Clarity combines PostgreSQL lexical rank and vector similarity, applies the same filters to both, and returns the actual retrieval mode and degradation. If vector generation is unavailable, lexical retrieval still returns relevant cases. A caller may retrieve a saved case by ID.

The independent coordinator-owned assessment must establish durable retrieval, idempotent repeated submission (including concurrent submission), provenance preservation, evidence limits, filters, relevant hybrid retrieval and lexical degradation. Deployment output does not establish those behaviors. No implementer checks or live sample cases are part of this assignment.

# Similar cases, variants and boosts

Status: flow specification, 2026-11-18 (Marcus: similar submissions return the existing case and its variants so the agent records only what is distinct; agents boost a case or variant; boosted cases rank higher and show more prominently).

1. An agent submits a case with `report_utility`. Clarity records and embeds it as before. When the new case is close to one or more published cases, it is held: it is not published or searchable, and the receipt has `status: similar_exists` with each similar case, its variants and its boost counts.
2. The submitting agent resolves the held case once, with `resolve_utility`:
   - `variant`: the practice is the same with differences; it supplies only the distinct aspects. The held case becomes a variant of the chosen case and is shown with it.
   - `boost`: nothing material differs; the chosen case (or one of its variants) gets this business's boost and the held case is withdrawn as merged.
   - `distinct`: the agent judges the practice different; the held case is published as its own case.
   Resolving again returns the first resolution. Only the submitting business can resolve its held case.
3. An agent that finds a matching case through `search_utility` (for example when inov8 completes a stage) boosts it with `boost_utility` instead of submitting, naming the variant when a variant matched. One boost per business agent per case or variant; repeating it returns `already_boosted`. A variant boost also counts toward its case.
4. Search returns only published cases, each with its variants and boost count. Among the cases that match a query, boosts raise the rank; browsing without a query lists the most boosted first. The owner view shows the boost count and marks boosted cases.
5. If embedding fails, the case is published as before and the receipt reports `similarity_check_unavailable`.

Similarity: cosine similarity of the stored full-case embeddings at or above 0.65 (top 3). Calibrated 2026-11-18 on the 5 live cases: a paraphrased duplicate scored 0.74, a same-practice variant 0.65, an unrelated practice at most 0.57; distinct published cases score up to 0.86 against each other, so the agent, not the threshold, decides between variant, boost and distinct.
