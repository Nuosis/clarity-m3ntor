-- Additive M3NTOR utility storage; does not change existing A2A records.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS agent_utility_cases (
    id uuid PRIMARY KEY,
    submission_id uuid NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'recorded',
    title text NOT NULL,
    summary text NOT NULL,
    process text NOT NULL,
    payload jsonb NOT NULL,
    tags text[] NOT NULL DEFAULT '{}',
    poma_labels text[] NOT NULL DEFAULT '{}',
    source_kind text NOT NULL CHECK (source_kind IN ('user_reported', 'web_documented')),
    embedding vector(1536),
    embedding_status text NOT NULL DEFAULT 'pending',
    embedding_error text,
    event_id uuid,
    event_registration_status text NOT NULL DEFAULT 'pending',
    search_document tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' ||
            coalesce(process, '') || ' ' || coalesce(payload->>'outcome', '') || ' ' ||
            coalesce(payload->>'agent_actions', '') || ' ' || coalesce(payload->>'prerequisites', '') || ' ' ||
            coalesce(payload->>'tags', '') || ' ' || coalesce(payload->>'business_context', ''))
    ) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_utility_cases_search_idx ON agent_utility_cases USING gin(search_document);
CREATE INDEX IF NOT EXISTS agent_utility_cases_tags_idx ON agent_utility_cases USING gin(tags);
CREATE INDEX IF NOT EXISTS agent_utility_cases_poma_idx ON agent_utility_cases USING gin(poma_labels);
CREATE INDEX IF NOT EXISTS agent_utility_cases_source_idx ON agent_utility_cases(source_kind);
CREATE INDEX IF NOT EXISTS agent_utility_cases_title_trgm_idx ON agent_utility_cases USING gin(title gin_trgm_ops);
-- Exact vector distance preserves recall for the initial collection and filtered searches.
