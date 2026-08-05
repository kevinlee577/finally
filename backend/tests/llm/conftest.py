"""Safety net for the LLM tests.

`app.config` now loads the repo-root `.env` at import time, so a real
OPENROUTER_API_KEY is present during test runs. That makes an accidental live
LLM call possible — it would be slow, cost money, and produce a non-deterministic
result that looks like a flaky test rather than a missing stub.

The autouse fixture below makes that failure mode loud instead of silent: every
test in this package must either enable LLM_MOCK or stub `complete_chat`. If one
reaches the real provider, it fails immediately with a clear message.
"""

import pytest


class LiveLLMCallAttempted(BaseException):
    """Deliberately derived from BaseException, not Exception.

    `complete_chat` catches `Exception` to degrade provider failures into §9's
    generic fallback. An Exception-derived guard would therefore be swallowed
    and the test would see a plausible-looking fallback message instead of an
    error — exactly the silent failure this fixture exists to prevent.
    """


@pytest.fixture(autouse=True)
def no_live_llm_calls(monkeypatch):
    """Fail loudly if a test reaches the real LiteLLM provider."""

    def _forbidden(*args, **kwargs):
        raise LiveLLMCallAttempted(
            "A test attempted a live LLM call. Set LLM_MOCK=true or stub "
            "app.llm.service.complete_chat instead of hitting the provider."
        )

    monkeypatch.setattr("app.llm.client.completion", _forbidden)
