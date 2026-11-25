"""agent-py for the real stack, with a fake sandbox behind `runCode`.

The live stack has no microVM (and CI no image cache), so `runCode` runs
here against a fixed result: stdout, a chart, a table and an output file.
Everything around it is real — the tool, Storage fallbacks, the parts on
the stream, the task's result and its delivery. The real sandbox is
checked by hand (Q96). Started by `stack.sh` from `services/agent-py`.
"""

import base64

import uvicorn

from agent_py.code_sandbox.types import CodeFile, CodeRunInput, CodeRunResult
from agent_py.tools import run_code

# A 1x1 PNG, the chart.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
CSV = b"x,y\n1,42\n"


class FakeSandbox:
    async def run(self, run_input: CodeRunInput) -> CodeRunResult:
        mounted = ", ".join(f.path for f in run_input.files)
        out = f"42\n{mounted}\n" if mounted else "42\n"
        return CodeRunResult(
            ok=True,
            stdout=out,
            stderr="",
            results=[
                {"type": "text", "value": out},
                {"type": "image", "format": "png", "data": base64.b64encode(PNG).decode()},
                {"type": "table", "columns": ["x", "y"], "rows": [["1", "42"]]},
            ],
            files=[CodeFile("answer.csv", "text/csv", len(CSV), base64.b64encode(CSV).decode())],
        )


run_code.available_sandbox = lambda: FakeSandbox()  # type: ignore[assignment]
uvicorn.run("agent_py.main:app", host="127.0.0.1", port=8171)
