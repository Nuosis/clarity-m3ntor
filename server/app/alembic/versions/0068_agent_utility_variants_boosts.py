"""Utility case variants, held similar submissions and boosts.

Revision ID: 0068_agent_utility_variants_boosts
Revises: 0067_m3ntor_registration_codes
"""
from pathlib import Path
from alembic import op

revision = "0068_agent_utility_variants_boosts"
down_revision = "0067_m3ntor_registration_codes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    migration = Path(__file__).resolve().parents[2] / "database" / "migrations" / "0068_agent_utility_variants_boosts.sql"
    op.execute(migration.read_text())


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS agent_utility_boosts")
    op.execute("ALTER TABLE agent_utility_cases DROP COLUMN IF EXISTS resolution, DROP COLUMN IF EXISTS variant_of")
