#!/usr/bin/env python3
"""Install only the utility extension into an existing Clarity checkout.

Run after uploading server/ to a scratch directory on the established server.
Database SQL is applied separately through the existing postgres container.
"""
import argparse
import hashlib
import shutil
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--target", type=Path, required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parent
for relative in (
    "app/api/agent_utility_api.py",
    "app/services/agent_utility.py",
    "app/workflows/agent_utility_workflow.py",
    "app/alembic/versions/0065_agent_utility_cases.py",
):
    dest = args.target / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / relative, dest)
dest = args.target / "app/database/migrations/0065_agent_utility_cases.sql"
dest.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(source / "migrations/0065_agent_utility_cases.sql", dest)

router = args.target / "app/api/router.py"
content = router.read_text()
if "    agent_utility_api," not in content:
    content = content.replace("    forward_agent_registry_api,", "    forward_agent_registry_api,\n    agent_utility_api,", 1)
if "direct_api_router.include_router(agent_utility_api.router)" not in content:
    content = content.replace("# Create separate router for webhooks", "direct_api_router.include_router(agent_utility_api.router)  # Utility cases via established HMAC\n\n# Create separate router for webhooks", 1)
router.write_text(content)

registry = args.target / "app/workflows/workflow_registry.py"
content = registry.read_text()
if "from workflows.agent_utility_workflow import AgentUtilityWorkflow" not in content:
    content = "from workflows.agent_utility_workflow import AgentUtilityWorkflow\n" + content
if "    AGENT_UTILITY = _entry(" not in content:
    anchor = "    PAYMENT_SYNC = _entry("
    content = content.replace(anchor, '    AGENT_UTILITY = _entry(AgentUtilityWorkflow, description="Persist and retrieve sanitized agent utility cases", version="1.0.0", files=["app/workflows/agent_utility_workflow.py", "app/services/agent_utility.py"])\n\n' + anchor, 1)
registry.write_text(content)

for relative in (
    "app/api/agent_utility_api.py", "app/services/agent_utility.py", "app/workflows/agent_utility_workflow.py",
    "app/alembic/versions/0065_agent_utility_cases.py", "app/database/migrations/0065_agent_utility_cases.sql",
    "app/api/router.py", "app/workflows/workflow_registry.py",
):
    print(hashlib.sha256((args.target / relative).read_bytes()).hexdigest(), relative)

print("Source installed only; production does not hot reload. Activate committed source with an API-only restart:")
print("ssh clarity 'sudo docker restart --time 30 clarity_backend_api'")
