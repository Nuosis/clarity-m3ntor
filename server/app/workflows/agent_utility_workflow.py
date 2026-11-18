"""Persist and retrieve sanitized utility through a gate/process/completion flow."""

from typing import Literal

from pydantic import BaseModel

from core.nodes.base import Node
from core.schema import NodeConfig, WorkflowSchema
from core.task import TaskContext
from core.workflow import Workflow


class UtilityEvent(BaseModel):
    id: str
    operation: Literal["submit", "search", "get", "revoke", "boost", "resolve"]
    payload: dict


class UtilityGate(Node):
    async def process(self, task_context: TaskContext) -> TaskContext:
        task_context.update_node(self.node_name, processing_status="completed")
        return task_context


class UtilityProcess(Node):
    async def process(self, task_context: TaskContext) -> TaskContext:
        from services.agent_utility import process_utility

        try:
            task_context.metadata["utility_result"] = process_utility(
                task_context.event.operation, task_context.event.payload
            )
        except Exception as exc:
            task_context.metadata["error"] = type(exc).__name__
            task_context.summary = "Utility operation did not complete"
            task_context.stop_workflow()
            return task_context
        task_context.update_node(self.node_name, processing_status="completed")
        return task_context


class UtilityComplete(Node):
    async def process(self, task_context: TaskContext) -> TaskContext:
        task_context.summary = "Utility operation recorded"
        task_context.update_node(self.node_name, processing_status="completed")
        return task_context


class AgentUtilityWorkflow(Workflow):
    workflow_schema = WorkflowSchema(
        description=__doc__,
        event_schema=UtilityEvent,
        start=UtilityGate,
        nodes=[
            NodeConfig(node=UtilityGate, connections=[UtilityProcess], stage="utility gate"),
            NodeConfig(node=UtilityProcess, connections=[UtilityComplete], stage="utility processing"),
            NodeConfig(node=UtilityComplete, connections=[], stage="utility completion"),
        ],
    )
