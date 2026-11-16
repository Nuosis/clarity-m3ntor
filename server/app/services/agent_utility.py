"""Persistent utility cases and honest hybrid retrieval using established services."""

import json
import math
from uuid import uuid4

from redis import Redis
from sqlalchemy import text

from database.event import Event
from database.session import SessionLocal


CASE_COLUMNS = "id, submission_id, status, payload, embedding_status, embedding_error, event_id, event_registration_status, created_at, updated_at"


def serialize_case(row) -> dict:
    case = dict(row["payload"])
    case.update({
        "id": str(row["id"]),
        "case_id": str(row["id"]),
        "status": row["status"],
        "submission_id": str(row["submission_id"]),
        "embedding_status": row["embedding_status"],
        "embedding_error": row["embedding_error"],
        "event_id": str(row["event_id"]) if row["event_id"] else None,
        "event_registration_status": row["event_registration_status"],
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
        "agent_identity_status": "caller_supplied" if case.get("agent_id") else "not_supplied",
    })
    return case


def read_case(case_id: str) -> dict:
    with SessionLocal() as db:
        row = db.execute(text(f"SELECT {CASE_COLUMNS} FROM agent_utility_cases WHERE id = CAST(:id AS uuid)"), {"id": case_id}).mappings().first()
    if row is None:
        return {"status": "not_found", "case_id": case_id}
    case = serialize_case(row)
    return {"status": "recorded", "case_id": case_id, "case": case, "embedding_status": case["embedding_status"]}


def _record_submission(payload: dict, event_id: str) -> tuple[dict, bool]:
    case_id = str(uuid4())
    with SessionLocal() as db:
        row = db.execute(text(f"""
            INSERT INTO agent_utility_cases
                (id, submission_id, title, summary, process, payload, tags, poma_labels, source_kind, event_id)
            VALUES (CAST(:id AS uuid), CAST(:submission_id AS uuid), :title, :summary, :process,
                    CAST(:payload AS jsonb), CAST(:tags AS text[]), CAST(:poma_labels AS text[]), :source_kind, CAST(:event_id AS uuid))
            ON CONFLICT (submission_id) DO NOTHING
            RETURNING {CASE_COLUMNS}
        """), {
            **payload, "id": case_id, "event_id": event_id,
            "payload": json.dumps(payload),
            "tags": list(dict.fromkeys(tag.strip().casefold() for tag in payload.get("tags", []) if tag.strip())),
        }).mappings().first()
        created = row is not None
        if not created:
            row = db.execute(text(f"SELECT {CASE_COLUMNS} FROM agent_utility_cases WHERE submission_id = CAST(:submission_id AS uuid)"), {"submission_id": payload["submission_id"]}).mappings().one()
        else:
            db.add(Event(id=event_id, workflow_type="AGENT_UTILITY", status="queued", stage="utility gate", summary="Utility submission recorded", data={"id": event_id, "operation": "submit", "payload": {"case_id": case_id}}))
        case = serialize_case(row)
        db.commit()
    return case, created


def _register_redis(event: dict) -> None:
    from worker.config import get_redis_url

    client = Redis.from_url(get_redis_url(), socket_connect_timeout=5, socket_timeout=5)
    try:
        client.set(f"agent_utility:event:{event['id']}", json.dumps(event))
    finally:
        client.close()


def execute_utility(operation: str, payload: dict) -> dict:
    """Initiate a durable Launchpad event; duplicate submissions have no side effects."""
    event_id = str(uuid4())
    case = None
    if operation == "submit":
        case, created = _record_submission(payload, event_id)
        if not created:
            return {"status": "existing", "case_id": case["id"], "case": case, "embedding_status": case["embedding_status"]}
        payload = {"case_id": case["id"]}
    event = {"id": event_id, "operation": operation, "payload": payload}
    if operation != "submit":
        with SessionLocal() as db:
            db.add(Event(id=event_id, workflow_type="AGENT_UTILITY", status="queued", stage="utility gate", summary=f"Utility {operation} requested", data=event))
            db.commit()
    try:
        _register_redis(event)
    except Exception as exc:
        with SessionLocal() as db:
            saved = db.get(Event, event_id)
            saved.status, saved.error = "failed", type(exc).__name__
            if case:
                db.execute(text("UPDATE agent_utility_cases SET event_registration_status='failed', embedding_error=:error, updated_at=now() WHERE id=CAST(:id AS uuid)"), {"id": case["id"], "error": f"event_registration:{type(exc).__name__}"})
            db.commit()
        if case:
            result = read_case(case["id"])
            result.update(event_id=event_id, workflow_status="failed", degradation=["event_registration_unavailable"])
            return result
        return {"status": "failed", "event_id": event_id, "error": "event_registration_unavailable", "error_type": type(exc).__name__}
    if case:
        with SessionLocal() as db:
            db.execute(text("UPDATE agent_utility_cases SET event_registration_status='registered', updated_at=now() WHERE id=CAST(:id AS uuid)"), {"id": case["id"]})
            db.commit()
    from workflows.workflow_registry import WorkflowRegistry

    context = WorkflowRegistry.AGENT_UTILITY.instantiate().run(event)
    result = context.metadata.get("utility_result")
    if result is None:
        result = read_case(case["id"]) if case else {"status": "failed"}
        result["error"] = context.metadata.get("error", "workflow_incomplete")
    result.update(event_id=event_id, workflow_status=context.status)
    return result


def _embedding(content: str) -> str:
    from services.embedding_service import embed_text

    vector = embed_text(content)
    if len(vector) != 1536 or any(not math.isfinite(value) for value in vector):
        raise ValueError("Embedding service returned an invalid vector")
    return "[" + ",".join(str(float(value)) for value in vector) + "]"


def embed_case(case_id: str) -> dict:
    with SessionLocal() as db:
        row = db.execute(text("SELECT payload FROM agent_utility_cases WHERE id=CAST(:id AS uuid)"), {"id": case_id}).mappings().one()
    payload = row["payload"]
    try:
        vector = _embedding(json.dumps(payload, ensure_ascii=False))
        with SessionLocal() as db:
            db.execute(text("UPDATE agent_utility_cases SET embedding=CAST(:vector AS vector), embedding_status='ready', embedding_error=NULL, updated_at=now() WHERE id=CAST(:id AS uuid)"), {"id": case_id, "vector": vector})
            db.commit()
    except Exception as exc:
        # Persist only the error class; upstream messages may contain private service details.
        with SessionLocal() as db:
            db.execute(text("UPDATE agent_utility_cases SET embedding_status='failed', embedding_error=:error, updated_at=now() WHERE id=CAST(:id AS uuid)"), {"id": case_id, "error": type(exc).__name__})
            db.commit()
    return read_case(case_id)


FILTERS = """
    (:source_kind IS NULL OR source_kind = :source_kind)
    AND tags @> CAST(:tags AS text[])
    AND poma_labels @> CAST(:poma_labels AS text[])
"""


def search_cases(payload: dict) -> dict:
    params = {
        "query": payload["query"], "source_kind": payload.get("source_kind"),
        "tags": list(dict.fromkeys(tag.strip().casefold() for tag in payload.get("tags", []) if tag.strip())),
        "poma_labels": payload.get("poma_labels", []), "limit": payload.get("limit", 10),
    }
    degradation = []
    vector = None
    try:
        vector = _embedding(payload["query"])
    except Exception as exc:
        degradation.append(f"query_embedding_unavailable:{type(exc).__name__}")
    lexical_sql = f"""
        SELECT id, row_number() OVER (ORDER BY
            ts_rank_cd(search_document, websearch_to_tsquery('english', :query)) DESC,
            similarity(title, :query) DESC, created_at DESC, id) AS rank
        FROM agent_utility_cases WHERE {FILTERS}
          AND (search_document @@ websearch_to_tsquery('english', :query) OR title % :query)
    """
    with SessionLocal() as db:
        lexical = db.execute(text(lexical_sql), params).mappings().all()
        dense = []
        vector_count = db.execute(text(f"SELECT count(*) FROM agent_utility_cases WHERE {FILTERS} AND embedding IS NOT NULL"), params).scalar_one()
        if vector is not None and vector_count:
            try:
                # Use a savepoint so a vector-query failure leaves lexical retrieval available.
                with db.begin_nested():
                    dense = db.execute(text(f"""
                        SELECT id, row_number() OVER (ORDER BY embedding <=> CAST(:vector AS vector), id) AS rank,
                               1 - (embedding <=> CAST(:vector AS vector)) AS similarity
                        FROM agent_utility_cases WHERE {FILTERS} AND embedding IS NOT NULL
                        ORDER BY embedding <=> CAST(:vector AS vector), id LIMIT :limit
                    """), {**params, "vector": vector}).mappings().all()
            except Exception as exc:
                degradation.append(f"vector_retrieval_unavailable:{type(exc).__name__}")
        elif vector is not None:
            degradation.append("no_embedded_cases_for_filters")
        scores, details = {}, {}
        for row in lexical:
            cid = str(row["id"])
            scores[cid] = 1.0 / (60 + row["rank"])
            details[cid] = {"lexical_rank": row["rank"]}
        for row in dense:
            cid = str(row["id"])
            scores[cid] = scores.get(cid, 0) + 1.0 / (60 + row["rank"])
            details.setdefault(cid, {}).update(vector_rank=row["rank"], vector_similarity=float(row["similarity"]))
        ordered = sorted(scores, key=lambda cid: (-scores[cid], cid))[:params["limit"]]
        results = []
        for cid in ordered:
            row = db.execute(text(f"SELECT {CASE_COLUMNS} FROM agent_utility_cases WHERE id=CAST(:id AS uuid)"), {"id": cid}).mappings().one()
            results.append({"case": serialize_case(row), "case_id": cid, "score": scores[cid], **details[cid]})
    return {
        "status": "ok", "results": results, "count": len(results),
        "retrieval_mode": "hybrid" if dense else "lexical", "search_mode": "hybrid" if dense else "lexical",
        "embedding_status": "ready" if vector is not None else "unavailable",
        "degradation": degradation, "filters": {k: params[k] for k in ("tags", "poma_labels", "source_kind")},
    }


def process_utility(operation: str, payload: dict) -> dict:
    if operation == "submit":
        return embed_case(payload["case_id"])
    if operation == "search":
        return search_cases(payload)
    return read_case(payload["case_id"])
