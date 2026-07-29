"""Pure memory-checkpoint policy used by the Nitro enclave reply paths."""
from __future__ import annotations


def apply_memory_checkpoint(
    state: dict | None, persist_memory: bool
) -> dict | None:
    """Drop a scorer memory proposal between API-selected checkpoints.

    Love/actions still resolve every scored turn. Fact rescue runs afterward and
    may independently return a memory when a summary fold evicts durable facts.
    """
    if state is not None and not persist_memory:
        state.pop("memory", None)
    return state
