-- Similar utility submissions are held for the submitting agent to resolve as a
-- variant, a boost or a distinct case; agents boost cases and variants.
ALTER TABLE agent_utility_cases ADD COLUMN IF NOT EXISTS variant_of uuid REFERENCES agent_utility_cases(id);
ALTER TABLE agent_utility_cases ADD COLUMN IF NOT EXISTS resolution jsonb;
CREATE INDEX IF NOT EXISTS agent_utility_cases_variant_of_idx ON agent_utility_cases(variant_of);
CREATE TABLE IF NOT EXISTS agent_utility_boosts (
    id uuid PRIMARY KEY,
    case_id uuid NOT NULL REFERENCES agent_utility_cases(id),
    variant_id uuid REFERENCES agent_utility_cases(id),
    booster text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_utility_boosts_once_idx
    ON agent_utility_boosts (case_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid), booster);
CREATE INDEX IF NOT EXISTS agent_utility_boosts_case_idx ON agent_utility_boosts(case_id);
