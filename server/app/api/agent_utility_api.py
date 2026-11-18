"""Sanitized, caller-supplied utility cases beside the existing A2A API."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from api.agent_mentor_api import bound_agent
from auth.api_token_scopes import API_TOKEN_SCOPE_M3NTOR_ACCESS
from auth.org_context import OrgContext, get_org_context
from database.session import SessionLocal
from sqlalchemy import text
from services.agent_utility import execute_utility

router = APIRouter(prefix="/agent/utility", tags=["agent-utility"])


class Evidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["owner_reported", "measured", "demonstrated"]
    limitations: list[str] = Field(default_factory=list)
    source_refs: list[str] = Field(default_factory=list)


class UtilityCaseCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    submission_id: UUID
    title: str
    summary: str
    process: str
    prerequisites: list[str]
    agent_actions: list[str]
    outcome: str
    owner_feedback: str | None = None
    productivity: dict = Field(default_factory=dict)
    poma_labels: list[Literal["Process", "Observability", "Measurement", "Agency"]]
    tags: list[str]
    business_context: dict = Field(default_factory=dict)
    evidence: Evidence
    source_kind: Literal["user_reported", "web_documented"]
    source_url: str | None = None
    source_date: str | None = None
    agent_id: UUID | None = None


class UtilitySearch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str
    poma_labels: list[Literal["Process", "Observability", "Measurement", "Agency"]] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    source_kind: Literal["user_reported", "web_documented"] | None = None
    limit: int = Field(default=10, ge=1)


class UtilityBoost(BaseModel):
    model_config = ConfigDict(extra="forbid")
    variant_id: UUID | None = None


class UtilityResolve(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["variant", "boost", "distinct"]
    case_id: UUID | None = None
    variant_id: UUID | None = None
    distinct_aspects: list[str] = Field(default_factory=list)


async def service_auth(context: OrgContext = Depends(get_org_context)) -> OrgContext:
    # USER-AUTHORIZED: Marcus, 2026-11-15 utility handoff: preserve established
    # A2A HMAC authentication. Marcus, 2026-11-16: registered M3NT0R installations
    # use their clrtok_ token (m3ntor:access scope) over HTTPS for these routes.
    if context.auth_type == "hmac":
        return context
    if context.auth_type == "api_token" and API_TOKEN_SCOPE_M3NTOR_ACCESS in context.api_token_scopes:
        return context
    raise HTTPException(status_code=403, detail="HMAC or M3NT0R installation token required")


def _attributed(payload: dict, context: OrgContext) -> dict:
    """Token submissions are attributed to the token's registered agent, never a supplied id."""
    if context.auth_type != "api_token":
        return payload
    with SessionLocal() as db:
        agent = bound_agent(db, context)
        return {**payload, "agent_id": str(agent.id)}


@router.post("/cases")
async def report_case(payload: UtilityCaseCreate, context: OrgContext = Depends(service_auth)) -> dict:
    return await run_in_threadpool(execute_utility, "submit", _attributed(payload.model_dump(mode="json"), context))


def _own_agent_ids(context: OrgContext) -> set[str]:
    """Agents of the caller's organization; a case they submitted is the caller's own."""
    if context.auth_type != "api_token":
        return set()
    with SessionLocal() as db:
        rows = db.execute(text("SELECT id FROM agents WHERE organization_id = :org"), {"org": context.organization_id}).all()
    return {str(row[0]) for row in rows}


@router.post("/search")
async def search_cases(payload: UtilitySearch, context: OrgContext = Depends(service_auth)) -> dict:
    result = await run_in_threadpool(execute_utility, "search", payload.model_dump(mode="json"))
    own = await run_in_threadpool(_own_agent_ids, context)
    for item in result.get("results", []) or []:
        case = item.get("case") or {}
        item["own"] = bool(case.get("agent_id")) and str(case.get("agent_id")) in own
    return result


def _require_submitter(case_id: UUID, context: OrgContext) -> None:
    """Only the organization whose agent submitted a case may revoke or resolve it."""
    with SessionLocal() as db:
        row = db.execute(text("SELECT payload->>'agent_id' AS agent_id FROM agent_utility_cases WHERE id = CAST(:id AS uuid)"), {"id": str(case_id)}).mappings().first()
        if row is None:
            raise HTTPException(status_code=404, detail="Utility case not found")
        if context.auth_type != "hmac":
            owner = db.execute(text("SELECT organization_id FROM agents WHERE id = CAST(:id AS uuid)"), {"id": row["agent_id"]}).scalar() if row["agent_id"] else None
            if owner is None or str(owner) != str(context.organization_id):
                raise HTTPException(status_code=403, detail="Only the organization that submitted this case can change it")


def _booster(context: OrgContext) -> str:
    """Boosts count once per registered agent; HMAC callers count once per organization."""
    if context.auth_type == "api_token":
        with SessionLocal() as db:
            return str(bound_agent(db, context).id)
    return f"org:{context.organization_id}"


def _checked(result: dict) -> dict:
    if result.get("status") == "failed":
        raise HTTPException(status_code=422 if result.get("error") in ("case_not_published", "variant_not_of_case", "distinct_aspects_required", "case_id_required") else 503, detail=result.get("error"))
    return result


@router.post("/cases/{case_id}/revoke")
async def revoke_case(case_id: UUID, context: OrgContext = Depends(service_auth)) -> dict:
    """Withdraw a case from the shared library through the utility workflow. An installation
    may revoke only cases its own organization's agents submitted; the record is kept."""
    await run_in_threadpool(_require_submitter, case_id, context)
    result = await run_in_threadpool(execute_utility, "revoke", {"case_id": str(case_id)})
    if result.get("status") == "failed":
        raise HTTPException(status_code=503, detail=f"Revocation could not be completed: {result.get('error')}")
    return result


@router.post("/cases/{case_id}/boost")
async def boost_case(case_id: UUID, payload: UtilityBoost, context: OrgContext = Depends(service_auth)) -> dict:
    """Boost a published case, or one of its variants, once per agent."""
    booster = await run_in_threadpool(_booster, context)
    body = {"case_id": str(case_id), "variant_id": str(payload.variant_id) if payload.variant_id else None, "booster": booster}
    return _checked(await run_in_threadpool(execute_utility, "boost", body))


@router.post("/cases/{case_id}/resolve")
async def resolve_case(case_id: UUID, payload: UtilityResolve, context: OrgContext = Depends(service_auth)) -> dict:
    """Resolve the caller's held submission as a variant, a boost or a distinct case."""
    if payload.action != "distinct" and payload.case_id is None:
        raise HTTPException(status_code=422, detail="case_id_required")
    await run_in_threadpool(_require_submitter, case_id, context)
    booster = await run_in_threadpool(_booster, context)
    body = {"held_case_id": str(case_id), "action": payload.action, "case_id": str(payload.case_id) if payload.case_id else None,
            "variant_id": str(payload.variant_id) if payload.variant_id else None, "distinct_aspects": payload.distinct_aspects, "booster": booster}
    return _checked(await run_in_threadpool(execute_utility, "resolve", body))
