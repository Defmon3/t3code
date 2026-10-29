"""Generate structured explanations for approval requests."""

import asyncio
import sys
from typing import Literal

import httpx
from google.genai import types
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError
from pydantic_ai import Agent, NativeOutput
from pydantic_ai.exceptions import ModelAPIError, UnexpectedModelBehavior
from pydantic_ai.models.google import GoogleModel, GoogleModelSettings
from pydantic_ai.providers.google import GoogleProvider


class Judgement(BaseModel):
    """Describe the overall effect of a command."""

    reason: str = Field(
        description=(
            "Briefly explain the actual effect. For git restore --staged --worktree, name both staged and unstaged edits. "
            "If instructions are unseen, name that missing information, for example: Instructions in task.md are unseen. "
            "Permission bypass alone is not the reason for uncertainty."
        )
    )
    verdict: Literal["safe", "unsafe", "uncertain"] = Field(
        description="Unsafe if local edits or data are discarded or credentials transmitted; uncertain if a coding agent follows unseen instructions; safe for reads, status and expected log writes."
    )


class Operation(BaseModel):
    """Describe one operation in a command."""

    action: str = Field(
        description="The actual operation, naming SSH or SCP only when invoked."
    )
    detail: str = Field(
        description="The actual filename, program or host. For a copy or upload, include both source and destination."
    )
    note: str | None = Field(
        description="Neutral facts such as overwrite or bypassing permission checks."
    )


class ApprovalExplanation(BaseModel):
    """Provide a judgement and the operations it covers."""

    judgement: Judgement
    operations: list[Operation] = Field(min_length=1)


class GenerateRequest(BaseModel):
    """Carry one explanation request."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["generate"]
    id: str
    key: str = Field(min_length=1)
    prompt: str = Field(min_length=1)


class CancelRequest(BaseModel):
    """Cancel an outstanding request."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["cancel"]
    id: str


class RequestIdentity(BaseModel):
    """Identify an invalid request when possible."""

    id: str


request_adapter = TypeAdapter(GenerateRequest | CancelRequest)


def write_response(response: dict[str, object]) -> None:
    """Write a response to the server."""
    sys.stdout.buffer.write(TypeAdapter(dict[str, object]).dump_json(response) + b"\n")
    sys.stdout.buffer.flush()


def report_invalid_request(line: bytes) -> None:
    """Report an invalid request without exposing its contents."""
    try:
        identity = RequestIdentity.model_validate_json(line)
    except ValidationError:
        write_response({"error": "invalid_request"})
    else:
        write_response({"id": identity.id, "error": "invalid_request"})


async def generate(request: GenerateRequest, client: httpx.AsyncClient) -> None:
    """Send one request and write its result."""
    try:
        model = GoogleModel(
            "gemini-3.1-flash-lite",
            provider=GoogleProvider(
                api_key=request.key,
                base_url="https://wonton.soup.herahorizon.com",
                http_client=client,
                retry_options=types.HttpRetryOptions(attempts=1),
            ),
        )
        agent = Agent(
            model,
            output_type=NativeOutput(ApprovalExplanation),
            model_settings=GoogleModelSettings(
                google_thinking_config={"thinking_budget": 0}
            ),
            retries=0,
        )
        result = await agent.run(request.prompt)
        response = {"id": request.id, "content": result.output.model_dump()}
    except (ModelAPIError, UnexpectedModelBehavior, ValidationError, httpx.HTTPError):
        response = {"id": request.id, "error": "generation_failed"}
    except Exception:
        response = {"id": request.id, "error": "internal_error"}
    write_response(response)


async def main() -> None:
    """Read requests until the server closes the pipe."""
    tasks: dict[str, asyncio.Task[None]] = {}
    async with httpx.AsyncClient(timeout=None) as client:
        while line := await asyncio.to_thread(sys.stdin.buffer.readline):
            try:
                request = request_adapter.validate_json(line)
            except ValidationError:
                report_invalid_request(line)
                continue
            if isinstance(request, CancelRequest):
                task = tasks.pop(request.id, None)
                if task is not None:
                    task.cancel()
            else:
                task = asyncio.create_task(generate(request, client))
                tasks[request.id] = task
                task.add_done_callback(
                    lambda completed, request_id=request.id: tasks.pop(request_id, None)
                )
        for task in tasks.values():
            task.cancel()
        await asyncio.gather(*tasks.values(), return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
