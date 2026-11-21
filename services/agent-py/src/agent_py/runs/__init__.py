"""The run model's interfaces (wave 3a of docs/PLAN-frontend-backend-split.md).

Four seams, each a small `Protocol` with an in-memory fake, that wave 3b
implements in parallel:

| Interface                         | Implemented by | What                                                     |
|-----------------------------------|----------------|----------------------------------------------------------|
| `event_log.RunEventLog`           | 3b-A           | numbered event log: append / read / subscribe / compact  |
| `encoder.AgUiEncoder`             | 3b-A           | internal events → AG-UI 1.0 events, per stream           |
| `harness.HarnessAdapter`          | 3b-C           | runs the agent, emits progress, returns the outcome      |
| `repository.RunRepository`        | 3b-B           | runs as `tasks` rows (0041): create / get / list / cancel / settle |

`model` holds the shared value types (owners, statuses, outcomes,
interrupts, the replay cursor, the `Run` resource JSON). The normative
wire behaviour is `packages/contract/RUN_EVENTS.md` and the runs
operations in `packages/contract/openapi.yaml`.

How they fit (3b-B's run driver, roughly):

    created = await repo.create(owner, spec)                  # idempotent on run id
    emitter = RunEmitter(run_id=..., sink=log.append, start_seq=...)
    result  = await harness.run(run_input, emitter, cancel)   # progress → log
    # driver: terminal entries from result.outcome (see harness.py), then
    await repo.settle(run_id, result.outcome); await log.seal(run_id)
    # meanwhile each stream: encoder.start → replay log.read → log.subscribe
    #                        → encoder.finish once the row says it is over
"""

from .encoder import AgUiEncoder, AgUiEncoderFactory, AgUiEvent, RecordingEncoder
from .event_log import InMemoryRunEventLog, RunEventLog, SeqConflict
from .harness import (
    CancelSignal,
    HarnessAdapter,
    HarnessOutcome,
    HarnessResult,
    ResumeAnswer,
    RunInput,
    ScriptedHarness,
    Yielded,
)
from .model import (
    Cancelled,
    ContractStatus,
    Failed,
    InternalStatus,
    Interrupted,
    PendingInterrupt,
    RunCursor,
    RunMode,
    RunOutcome,
    RunOwner,
    RunRecord,
    RunResultData,
    Succeeded,
    contract_status,
    outcome_from_json,
    outcome_to_json,
    run_to_contract,
)
from .repository import (
    CreateResult,
    InMemoryRunRepository,
    InvalidPageToken,
    PreviousRunNotFound,
    RunFilter,
    RunIdConflict,
    RunPage,
    RunRepository,
    RunSpec,
    ThreadNotFound,
)

__all__ = [
    "AgUiEncoder",
    "AgUiEncoderFactory",
    "AgUiEvent",
    "CancelSignal",
    "Cancelled",
    "ContractStatus",
    "CreateResult",
    "Failed",
    "HarnessAdapter",
    "HarnessOutcome",
    "HarnessResult",
    "InMemoryRunEventLog",
    "InMemoryRunRepository",
    "InternalStatus",
    "Interrupted",
    "InvalidPageToken",
    "PendingInterrupt",
    "PreviousRunNotFound",
    "RecordingEncoder",
    "ResumeAnswer",
    "RunCursor",
    "RunEventLog",
    "RunFilter",
    "RunIdConflict",
    "RunInput",
    "RunMode",
    "RunOutcome",
    "RunOwner",
    "RunPage",
    "RunRecord",
    "RunRepository",
    "RunResultData",
    "RunSpec",
    "ScriptedHarness",
    "SeqConflict",
    "Succeeded",
    "ThreadNotFound",
    "Yielded",
    "contract_status",
    "outcome_from_json",
    "outcome_to_json",
    "run_to_contract",
]
