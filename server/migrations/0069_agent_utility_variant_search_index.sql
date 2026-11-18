-- Full-text index over a case's search document plus a variant's distinct aspects.
CREATE INDEX IF NOT EXISTS agent_utility_cases_variant_search_idx ON agent_utility_cases
    USING gin ((search_document || to_tsvector('english'::regconfig, coalesce(payload->>'distinct_aspects', ''))));
