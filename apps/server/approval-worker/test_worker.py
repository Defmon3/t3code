"""Test the approval worker's model boundary."""

import asyncio
import json

import httpx
import pytest

from worker import GenerateRequest, generate, report_invalid_request

TEST_KEY = "test-key"


class ModelEndpoint:
    """Simulate the model's HTTP endpoint."""

    def __init__(self, status: int) -> None:
        self.status = status
        self.request: httpx.Request | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.request = request
        if self.status != 200:
            return httpx.Response(self.status, text=TEST_KEY)
        content = {
            "judgement": {"reason": "Only reads status.", "verdict": "safe"},
            "operations": [
                {"action": "Git status", "detail": "repository", "note": None}
            ],
        }
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "role": "model",
                            "parts": [{"text": json.dumps(content)}],
                        },
                        "finishReason": "STOP",
                    }
                ]
            },
        )


class WaitingEndpoint:
    """Keep a model request pending until it is cancelled."""

    def __init__(self) -> None:
        self.started = asyncio.Event()

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.started.set()
        await asyncio.Event().wait()
        raise AssertionError("The request should have been cancelled")


async def run_request(endpoint: ModelEndpoint) -> None:
    """Run a request against a simulated endpoint."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(endpoint)) as client:
        await generate(
            GenerateRequest(kind="generate", id="1", key=TEST_KEY, prompt="git status"),
            client,
        )


async def cancel_request() -> None:
    """Cancel a request after its HTTP call starts."""
    endpoint = WaitingEndpoint()
    async with httpx.AsyncClient(transport=httpx.MockTransport(endpoint)) as client:
        task = asyncio.create_task(
            generate(
                GenerateRequest(
                    kind="generate", id="1", key=TEST_KEY, prompt="git status"
                ),
                client,
            )
        )
        await endpoint.started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


def test_generates_typed_output_without_thinking(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Return the structured model response."""
    endpoint = ModelEndpoint(200)
    asyncio.run(run_request(endpoint))
    response = json.loads(capsys.readouterr().out)
    assert endpoint.request is not None
    body = json.loads(endpoint.request.content)
    assert body["generationConfig"]["thinkingConfig"]["thinking_budget"] == 0
    assert response["id"] == "1"
    assert response["content"]["judgement"]["verdict"] == "safe"


def test_generation_error_does_not_disclose_credentials(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Return a safe failure when the model request fails."""
    asyncio.run(run_request(ModelEndpoint(401)))
    assert json.loads(capsys.readouterr().out) == {
        "id": "1",
        "error": "generation_failed",
    }


def test_cancelled_request_does_not_emit_a_result(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Stop the model request without returning a stale explanation."""
    asyncio.run(cancel_request())
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize(
    "line, expected",
    [
        (
            b'{"id":"1","key":"secret","kind":"wrong"}',
            {"id": "1", "error": "invalid_request"},
        ),
        (b'{"key":"secret"', {"error": "invalid_request"}),
    ],
)
def test_invalid_request_reports_a_safe_failure(
    capsys: pytest.CaptureFixture[str], line: bytes, expected: dict[str, str]
) -> None:
    """Report invalid input without exposing its contents."""
    report_invalid_request(line)
    assert json.loads(capsys.readouterr().out) == expected
