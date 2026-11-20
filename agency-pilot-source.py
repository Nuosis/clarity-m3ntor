"""Read-only server-side half of the single Agency pilot observer.

Run inside the existing claire-api-1 container; database credentials never leave it.
Only notification IDs already received by the observer can be requested on stdin.
"""
import asyncio
import json
import os
import sys
import uuid

import asyncpg
from app.config import get_settings


def emit(value):
    print(json.dumps(value, default=str), flush=True)


async def main():
    connection = await asyncpg.connect(get_settings().database_url.replace("+asyncpg", ""))
    requests = asyncio.Queue()
    loop = asyncio.get_running_loop()
    connection.add_termination_listener(lambda _connection: requests.put_nowait({"connection_lost": True}))

    def notified(_connection, _pid, _channel, message_id):
        emit({"type": "notification", "message_id": message_id})

    input_buffer = bytearray()

    def incoming():
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            requests.put_nowait(None)
            loop.remove_reader(sys.stdin)
        else:
            input_buffer.extend(chunk)
            while b"\n" in input_buffer:
                line, _, remaining = input_buffer.partition(b"\n")
                input_buffer[:] = remaining
                requests.put_nowait(json.loads(line))

    loop.add_reader(sys.stdin, incoming)
    try:
        await connection.add_listener("agent_inbox:claire", notified)
        emit({"type": "ready", "channel": "agent_inbox:claire"})
        while True:
            request = await requests.get()
            if request is None:
                break
            if request.get("connection_lost"):
                raise ConnectionError("Source observer database connection ended")
            message_id = uuid.UUID(request["message_id"])
            # USER-AUTHORIZED — Marcus, November 20, 2026: observe the exact
            # notified source handoff for AGENCY-PILOT-01; never claim/ack the inbox.
            async with connection.transaction(readonly=True):
                row = await connection.fetchrow(
                    """SELECT json_build_object(
                              'id', m.id, 'session_id', m.session_id, 'thread_id', m.thread_id,
                              'from_agent', m.from_agent, 'to_agent', m.to_agent,
                              'message_type', m.message_type, 'payload_schema_version', m.payload_schema_version,
                              'payload', m.payload, 'correlation_id', m.correlation_id,
                              'idempotency_key', m.idempotency_key, 'created_at', m.created_at,
                              'metadata', m.metadata, 'execution_run_id', m.execution_run_id,
                              'executor_revision', m.executor_revision, 'claimed_by', m.claimed_by
                           ) AS message, row_to_json(i) AS intake,
                              row_to_json(s) AS source
                       FROM agent_agent_messages m
                       JOIN goal_intakes i ON i.id = m.payload->>'intake_id'
                         AND i.source_event_id = m.payload->>'source_event_id'
                       JOIN source_events s ON s.id = i.source_event_id
                         AND s.tenant_id = i.tenant_id AND s.org_id = i.owner_user_id
                       WHERE m.id = $1 AND m.to_agent = 'claire'
                         AND m.from_agent = 'system_ops'
                         AND m.message_type = 'goal_intake'
                         AND m.payload_schema_version = 'goal.intake@1'""",
                    message_id,
                )
            if row:
                emit({"type": "handoff", "message_id": str(message_id),
                      **{key: json.loads(value) if isinstance(value, str) else value
                         for key, value in dict(row).items()}})
            else:
                emit({"type": "unrelated", "message_id": str(message_id)})
    finally:
        loop.remove_reader(sys.stdin)
        try:
            await connection.remove_listener("agent_inbox:claire", notified)
        finally:
            connection.terminate()


if __name__ == "__main__":
    asyncio.run(main())
