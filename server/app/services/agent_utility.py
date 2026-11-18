"""Persistent utility cases and honest hybrid retrieval using established services."""

import json
import math
from uuid import uuid4

from redis import Redis
from sqlalchemy import text

from database.event import Event
from database.session import SessionLocal


CASE_COLUMNS = "id, submission_id, status, payload, embedding_status, embedding_error, event_id, event_registration_status, variant_of, resolution, created_at, updated_at"


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
        "variant_of": str(row["variant_of"]) if row["variant_of"] else None,
        "resolution": row["resolution"],
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
    result = {"status": "recorded", "case_id": case_id, "case": case, "embedding_status": case["embedding_status"]}
    if case["status"] == "held":
        result.update(status="similar_exists", similar=similar_cases(case_id), next=HELD_NEXT)
    return result


# A case found by vector similarity at or above this is offered to the submitter as
# similar. Calibrated 2026-11-18 on full-case embeddings: a paraphrased duplicate 0.74,
# a same-practice variant 0.65, an unrelated practice at most 0.57. Distinct published
# cases reach 0.86, so the submitting agent decides variant, boost or distinct.
SIMILAR_CASE_SIMILARITY = 0.65
SIMILAR_CASE_LIMIT = 3
HELD_NEXT = ("This case is held, not published, because similar cases exist. Compare it with each similar case "
             "and its variants, then call resolve_utility once: action variant with the case_id and only the aspects "
             "of your practice that differ (distinct_aspects); action boost with the case_id (and variant_id when a "
             "variant matches) when nothing material differs; or action distinct when it is a different practice.")


def similar_cases(case_id: str, db=None) -> list[dict]:
    """Published cases close to this case, each with its variants and boosts."""
    if db is None:
        with SessionLocal() as session:
            return similar_cases(case_id, session)
    rows = db.execute(text(f"""
        SELECT {CASE_COLUMNS}, 1 - (c.embedding <=> h.embedding) AS similarity
        FROM agent_utility_cases c, (SELECT embedding FROM agent_utility_cases WHERE id = CAST(:id AS uuid)) h
        WHERE c.status = 'recorded' AND c.id <> CAST(:id AS uuid) AND c.embedding IS NOT NULL AND h.embedding IS NOT NULL
        ORDER BY c.embedding <=> h.embedding, c.id LIMIT :limit
    """), {"id": case_id, "limit": SIMILAR_CASE_LIMIT}).mappings().all()
    found = [(row, float(row["similarity"])) for row in rows if float(row["similarity"]) >= SIMILAR_CASE_SIMILARITY]
    cases = with_variants_and_boosts(db, [serialize_case(row) for row, _ in found])
    return [{"case_id": case["id"], "similarity": similarity, "case": case} for case, (_, similarity) in zip(cases, found)]


def boost_counts(db, case_ids: list[str]) -> dict[str, int]:
    """Boosts per case, including boosts given to its variants."""
    if not case_ids:
        return {}
    rows = db.execute(text("SELECT case_id, count(*) AS n FROM agent_utility_boosts WHERE case_id = ANY(CAST(:ids AS uuid[])) GROUP BY case_id"), {"ids": case_ids}).mappings().all()
    return {str(row["case_id"]): row["n"] for row in rows}


def with_variants_and_boosts(db, cases: list[dict]) -> list[dict]:
    ids = [case["id"] for case in cases]
    if not ids:
        return cases
    boosts = boost_counts(db, ids)
    variant_rows = db.execute(text(f"""
        SELECT {CASE_COLUMNS}, (SELECT count(*) FROM agent_utility_boosts b WHERE b.variant_id = v.id) AS boosts
        FROM agent_utility_cases v WHERE v.status = 'variant' AND v.variant_of = ANY(CAST(:ids AS uuid[]))
        ORDER BY boosts DESC, v.created_at, v.id
    """), {"ids": ids}).mappings().all()
    variants: dict[str, list] = {}
    for row in variant_rows:
        variant = serialize_case(row)
        variants.setdefault(variant["variant_of"], []).append({
            "variant_id": variant["id"], "title": variant["title"], "summary": variant["summary"],
            "distinct_aspects": variant.get("distinct_aspects", []), "boosts": row["boosts"],
            "agent_id": variant.get("agent_id"), "created_at": variant["created_at"],
        })
    for case in cases:
        case["boosts"] = boosts.get(case["id"], 0)
        case["variants"] = variants.get(case["id"], [])
    return cases


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
            if case["status"] == "held":
                return {**read_case(case["id"]), "existing": True}
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
        result = read_case(case_id)
        result["degradation"] = ["similarity_check_unavailable"]
        return result
    # One similarity decision at a time, so two similar submissions cannot hold each other
    # and leave neither published: the later one sees the earlier as published or held.
    with SessionLocal() as db:
        db.execute(text("SELECT pg_advisory_xact_lock(hashtext('agent_utility_similarity'))"))
        if similar_cases(case_id, db):
            db.execute(text("UPDATE agent_utility_cases SET status='held', updated_at=now() WHERE id=CAST(:id AS uuid) AND status='recorded'"), {"id": case_id})
        db.commit()
    return read_case(case_id)


# A case found only by vector similarity counts as a match from this similarity up;
# unrelated cases score about 0.1 to 0.29 with text-embedding-3-small.
MIN_VECTOR_SIMILARITY = 0.30

FILTERS = """
    status = 'recorded'
    AND (:source_kind IS NULL OR source_kind = :source_kind)
    AND tags @> CAST(:tags AS text[])
    AND poma_labels @> CAST(:poma_labels AS text[])
"""


# Matches the expression index in migration 0069; keep the two identical.
DOCUMENT = "(search_document || to_tsvector('english'::regconfig, coalesce(payload->>'distinct_aspects', '')))"


def search_cases(payload: dict) -> dict:
    params = {
        "query": payload["query"], "source_kind": payload.get("source_kind"),
        "tags": list(dict.fromkeys(tag.strip().casefold() for tag in payload.get("tags", []) if tag.strip())),
        "poma_labels": payload.get("poma_labels", []), "limit": payload.get("limit", 10),
    }
    if not str(payload.get("query") or "").strip():
        # No query: the newest cases matching the filters, for browsing.
        with SessionLocal() as db:
            rows = db.execute(text(f"SELECT {CASE_COLUMNS} FROM agent_utility_cases WHERE {FILTERS} ORDER BY (SELECT count(*) FROM agent_utility_boosts b WHERE b.case_id = agent_utility_cases.id) DESC, created_at DESC, id LIMIT :limit"), params).mappings().all()
            cases = with_variants_and_boosts(db, [serialize_case(row) for row in rows])
        results = [{"case": case, "case_id": case["id"], "score": None, "boosts": case["boosts"]} for case in cases]
        return {"status": "ok", "results": results, "count": len(results), "retrieval_mode": "recent", "search_mode": "recent",
                "embedding_status": "not_needed", "degradation": [], "filters": {k: params[k] for k in ("tags", "poma_labels", "source_kind")}}
    degradation = []
    vector = None
    try:
        vector = _embedding(payload["query"])
    except Exception as exc:
        degradation.append(f"query_embedding_unavailable:{type(exc).__name__}")
    # Published variants match too, by their text and their distinct aspects, and count for their case.
    match_filters = FILTERS.replace("status = 'recorded'", "status IN ('recorded', 'variant')")
    candidates = max(params["limit"] * 5, 50)
    # Matches are grouped by their published case before ranking and limiting, so a case's
    # variants never crowd out another case.
    published_parent = "EXISTS (SELECT 1 FROM agent_utility_cases p WHERE p.id = COALESCE(c.variant_of, c.id) AND p.status = 'recorded')"
    lexical_sql = f"""
        SELECT parent AS id, row_number() OVER (ORDER BY text_rank DESC, title_similarity DESC, created DESC, parent) AS rank
        FROM (
            SELECT COALESCE(c.variant_of, c.id) AS parent,
                   max(ts_rank_cd({DOCUMENT}, websearch_to_tsquery('english', :query))) AS text_rank,
                   max(similarity(c.title, :query)) AS title_similarity, max(c.created_at) AS created
            FROM agent_utility_cases c WHERE {match_filters} AND {published_parent}
              AND ({DOCUMENT} @@ websearch_to_tsquery('english', :query) OR c.title % :query)
            GROUP BY 1
        ) grouped
    """
    with SessionLocal() as db:
        lexical = db.execute(text(lexical_sql), params).mappings().all()
        dense = []
        vector_count = db.execute(text(f"SELECT count(*) FROM agent_utility_cases WHERE {match_filters} AND embedding IS NOT NULL"), params).scalar_one()
        if vector is not None and vector_count:
            try:
                # Use a savepoint so a vector-query failure leaves lexical retrieval available.
                with db.begin_nested():
                    dense = db.execute(text(f"""
                        SELECT parent AS id, row_number() OVER (ORDER BY distance, parent) AS rank, 1 - distance AS similarity
                        FROM (
                            SELECT COALESCE(c.variant_of, c.id) AS parent, min(c.embedding <=> CAST(:vector AS vector)) AS distance
                            FROM agent_utility_cases c WHERE {match_filters} AND c.embedding IS NOT NULL AND {published_parent}
                            GROUP BY 1
                        ) grouped
                        ORDER BY distance, parent LIMIT :candidates
                    """), {**params, "vector": vector, "candidates": candidates}).mappings().all()
            except Exception as exc:
                degradation.append(f"vector_retrieval_unavailable:{type(exc).__name__}")
        elif vector is not None:
            degradation.append("no_embedded_cases_for_filters")
        scores, details = {}, {}
        lexical_best = {str(row["id"]): row["rank"] for row in lexical}
        dense_best = {str(row["id"]): (row["rank"], float(row["similarity"])) for row in dense}
        for cid, rank in lexical_best.items():
            scores[cid] = 1.0 / (60 + rank)
            details[cid] = {"lexical_rank": rank}
        for cid, (rank, similarity) in dense_best.items():
            if cid not in scores and similarity < MIN_VECTOR_SIMILARITY:
                continue
            scores[cid] = scores.get(cid, 0) + 1.0 / (60 + rank)
            details.setdefault(cid, {}).update(vector_rank=rank, vector_similarity=similarity)
        # Boosts raise a matching case's rank; they never add a case that did not match.
        boosts = boost_counts(db, list(scores))
        for cid in scores:
            scores[cid] *= 1 + math.log1p(boosts.get(cid, 0))
        ordered = sorted(scores, key=lambda cid: (-scores[cid], cid))[:params["limit"]]
        rows = [db.execute(text(f"SELECT {CASE_COLUMNS} FROM agent_utility_cases WHERE id=CAST(:id AS uuid)"), {"id": cid}).mappings().one() for cid in ordered]
        cases = with_variants_and_boosts(db, [serialize_case(row) for row in rows])
        results = [{"case": case, "case_id": case["id"], "score": scores[case["id"]], "boosts": case["boosts"], **details[case["id"]]} for case in cases]
    return {
        "status": "ok", "results": results, "count": len(results),
        "retrieval_mode": "hybrid" if dense else "lexical", "search_mode": "hybrid" if dense else "lexical",
        "embedding_status": "ready" if vector is not None else "unavailable",
        "degradation": degradation, "filters": {k: params[k] for k in ("tags", "poma_labels", "source_kind")},
    }


def revoke_case(case_id: str) -> dict:
    """Withdraw a case from the shared library; the record is kept, marked revoked."""
    with SessionLocal() as db:
        row = db.execute(text("UPDATE agent_utility_cases SET status = 'revoked', updated_at = now() WHERE id = CAST(:id AS uuid) RETURNING id"), {"id": case_id}).first()
        db.commit()
    return {"status": "revoked" if row else "not_found", "case_id": case_id}


def _published_target(db, case_id: str, variant_id: str | None) -> tuple[str, str | None]:
    """The published case and optional variant a resolution or boost names; a variant id
    given as case_id resolves to its case."""
    row = db.execute(text("SELECT id, status, variant_of FROM agent_utility_cases WHERE id = CAST(:id AS uuid)"), {"id": case_id}).mappings().first()
    if row is not None and row["status"] == "variant" and not variant_id:
        variant_id, case_id = case_id, str(row["variant_of"])
        row = db.execute(text("SELECT id, status, variant_of FROM agent_utility_cases WHERE id = CAST(:id AS uuid)"), {"id": case_id}).mappings().first()
    if row is None or row["status"] != "recorded":
        raise LookupError("case_not_published")
    if variant_id:
        variant = db.execute(text("SELECT 1 FROM agent_utility_cases WHERE id = CAST(:id AS uuid) AND status = 'variant' AND variant_of = CAST(:case AS uuid)"), {"id": variant_id, "case": case_id}).first()
        if variant is None:
            raise LookupError("variant_not_of_case")
    return case_id, variant_id


def _boost(db, case_id: str, variant_id: str | None, booster: str) -> bool:
    row = db.execute(text("""
        INSERT INTO agent_utility_boosts (id, case_id, variant_id, booster)
        VALUES (CAST(:id AS uuid), CAST(:case AS uuid), CAST(:variant AS uuid), :booster)
        ON CONFLICT DO NOTHING RETURNING id
    """), {"id": str(uuid4()), "case": case_id, "variant": variant_id, "booster": booster}).first()
    return row is not None


def boost_case(payload: dict) -> dict:
    """One boost per booster per case or variant; a variant boost counts toward its case."""
    with SessionLocal() as db:
        try:
            case_id, variant_id = _published_target(db, payload["case_id"], payload.get("variant_id"))
        except LookupError as exc:
            return {"status": "failed", "error": str(exc), "case_id": payload["case_id"]}
        created = _boost(db, case_id, variant_id, payload["booster"])
        db.commit()
        boosts = boost_counts(db, [case_id]).get(case_id, 0)
        variant_boosts = db.execute(text("SELECT count(*) FROM agent_utility_boosts WHERE variant_id = CAST(:id AS uuid)"), {"id": variant_id}).scalar_one() if variant_id else None
    return {"status": "boosted" if created else "already_boosted", "case_id": case_id, "variant_id": variant_id,
            "boosts": boosts, **({"variant_boosts": variant_boosts} if variant_id else {})}


def resolve_case(payload: dict) -> dict:
    """Resolve a held submission once: variant, boost or distinct. Repeats return the first resolution."""
    held_id, action = payload["held_case_id"], payload["action"]
    reembed = False
    with SessionLocal() as db:
        row = db.execute(text("SELECT status, resolution FROM agent_utility_cases WHERE id = CAST(:id AS uuid) FOR UPDATE"), {"id": held_id}).mappings().first()
        if row is None:
            return {"status": "not_found", "case_id": held_id}
        if row["status"] != "held":
            db.rollback()
            result = read_case(held_id)
            result["status"] = "already_resolved" if row["resolution"] else "not_held"
            return result
        if action == "distinct":
            db.execute(text("UPDATE agent_utility_cases SET status='recorded', resolution=CAST(:r AS jsonb), updated_at=now() WHERE id=CAST(:id AS uuid)"), {"id": held_id, "r": json.dumps({"action": "distinct"})})
        else:
            try:
                case_id, variant_id = _published_target(db, payload["case_id"], payload.get("variant_id") if action == "boost" else None)
            except LookupError as exc:
                db.rollback()
                return {"status": "failed", "error": str(exc), "case_id": held_id}
            if action == "variant":
                aspects = [aspect.strip() for aspect in payload.get("distinct_aspects", []) if aspect.strip()]
                if not aspects:
                    db.rollback()
                    return {"status": "failed", "error": "distinct_aspects_required", "case_id": held_id}
                resolution = {"action": "variant", "case_id": case_id}
                db.execute(text("""
                    UPDATE agent_utility_cases SET status='variant', variant_of=CAST(:case AS uuid), resolution=CAST(:r AS jsonb),
                        payload = payload || jsonb_build_object('distinct_aspects', CAST(:aspects AS jsonb)), updated_at=now()
                    WHERE id=CAST(:id AS uuid)
                """), {"id": held_id, "case": case_id, "r": json.dumps(resolution), "aspects": json.dumps(aspects)})
                reembed = True
            else:
                resolution = {"action": "boost", "case_id": case_id, "variant_id": variant_id}
                _boost(db, case_id, variant_id, payload["booster"])
                db.execute(text("UPDATE agent_utility_cases SET status='merged', variant_of=CAST(:case AS uuid), resolution=CAST(:r AS jsonb), updated_at=now() WHERE id=CAST(:id AS uuid)"), {"id": held_id, "case": case_id, "r": json.dumps(resolution)})
        db.commit()
    if reembed:
        # The variant is found by what makes it distinct; a failed embedding leaves its text searchable.
        try:
            with SessionLocal() as db:
                case_payload = db.execute(text("SELECT payload FROM agent_utility_cases WHERE id=CAST(:id AS uuid)"), {"id": held_id}).scalar_one()
            vector = _embedding(json.dumps(case_payload, ensure_ascii=False))
            with SessionLocal() as db:
                db.execute(text("UPDATE agent_utility_cases SET embedding=CAST(:vector AS vector), updated_at=now() WHERE id=CAST(:id AS uuid)"), {"id": held_id, "vector": vector})
                db.commit()
        except Exception as exc:
            reembed = f"variant_embedding_unavailable:{type(exc).__name__}"
    result = read_case(held_id)
    result["status"] = "resolved"
    if isinstance(reembed, str):
        result["degradation"] = [reembed]
    return result


def process_utility(operation: str, payload: dict) -> dict:
    if operation == "submit":
        return embed_case(payload["case_id"])
    if operation == "boost":
        return boost_case(payload)
    if operation == "resolve":
        return resolve_case(payload)
    if operation == "revoke":
        return revoke_case(payload["case_id"])
    if operation == "search":
        return search_cases(payload)
    return read_case(payload["case_id"])
