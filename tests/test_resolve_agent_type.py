"""Tests for resolve_agent_type — the Task/Agent subagent type resolution.

Run with: uv run --with pytest python -m pytest tests/ -q
(or plain `python -m pytest tests/` when langfuse is already installed)
"""
import importlib.util
from pathlib import Path

import pytest

HOOK_PATH = Path(__file__).resolve().parent.parent / "hooks" / "langfuse_hook.py"


def _load_hook():
    spec = importlib.util.spec_from_file_location("langfuse_hook", HOOK_PATH)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except SystemExit:  # module exits at import when langfuse is unavailable
        pytest.skip("langfuse SDK not installed in this environment")
    return module


resolve_agent_type = _load_hook().resolve_agent_type


def test_sync_agent_reads_agent_type_from_result_meta():
    # Completed synchronous agents carry agentType in the toolUseResult.
    meta = {"agentId": "abc", "agentType": "general-purpose", "usage": {}}
    assert resolve_agent_type(meta, {"subagent_type": "explore"}) == "general-purpose"


def test_async_agent_falls_back_to_tool_input_subagent_type():
    # Async / background agents omit agentType; the tool_use input still has subagent_type.
    meta = {"agentId": "abc", "isAsync": True}
    tool_input = {"description": "…", "subagent_type": "general-purpose", "run_in_background": True}
    assert resolve_agent_type(meta, tool_input) == "general-purpose"


def test_result_meta_takes_precedence_over_input():
    meta = {"agentType": "code-reviewer"}
    assert resolve_agent_type(meta, {"subagent_type": "general-purpose"}) == "code-reviewer"


def test_generic_fallback_when_nothing_available():
    assert resolve_agent_type({"agentId": "abc"}, {}) == "subagent"
    assert resolve_agent_type({}, None) == "subagent"
