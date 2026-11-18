"""Full-text index including variant distinct aspects.

Revision ID: 0069_agent_utility_variant_search_index
Revises: 0068_agent_utility_variants_boosts
"""
from pathlib import Path
from alembic import op

revision = "0069_agent_utility_variant_search_index"
down_revision = "0068_agent_utility_variants_boosts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    migration = Path(__file__).resolve().parents[2] / "database" / "migrations" / "0069_agent_utility_variant_search_index.sql"
    op.execute(migration.read_text())


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS agent_utility_cases_variant_search_idx")
