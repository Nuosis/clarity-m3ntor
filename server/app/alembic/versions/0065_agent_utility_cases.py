"""Add utility case storage beside A2A.

Revision ID: 0065_agent_utility_cases
Revises: 0064_agent_message_notify
"""
from pathlib import Path
from alembic import op

revision = "0065_agent_utility_cases"
down_revision = "0064_agent_message_notify"
branch_labels = None
depends_on = None


def upgrade() -> None:
    migration = Path(__file__).resolve().parents[2] / "database" / "migrations" / "0065_agent_utility_cases.sql"
    op.execute(migration.read_text())


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS agent_utility_cases")
    # Extensions may be used by other features and are retained.
