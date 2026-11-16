"""Sanitized, caller-supplied utility cases beside the existing A2A API."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from auth.org_context import OrgContext, get_org_context
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


async def service_auth(context: OrgContext = Depends(get_org_context)) -> OrgContext:
    # USER-AUTHORIZED: Marcus, 2026-11-15 utility handoff: preserve established
    # A2A HMAC authentication and organization-context patterns.
    if context.auth_type != "hmac":
        raise HTTPException(status_code=403, detail="HMAC service authentication required")
    return context


@router.post("/cases")
async def report_case(payload: UtilityCaseCreate, context: OrgContext = Depends(service_auth)) -> dict:
    return await run_in_threadpool(execute_utility, "submit", payload.model_dump(mode="json"))


@router.post("/search")
async def search_cases(payload: UtilitySearch, context: OrgContext = Depends(service_auth)) -> dict:
    return await run_in_threadpool(execute_utility, "search", payload.model_dump(mode="json"))


@router.get("/cases/{case_id}")
async def get_case(case_id: UUID, context: OrgContext = Depends(service_auth)) -> dict:
    result = await run_in_threadpool(execute_utility, "get", {"case_id": str(case_id)})
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="Utility case not found")
    return result
