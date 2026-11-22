# Trial: the code interpreter on agent-py (Q43)

Status: **findings only, no code** (wave 5 trial, 2026-11-22). Answers Q43 in
[`PLAN-frontend-backend-split.md`](PLAN-frontend-backend-split.md). Companion
plans: [`PLAN-execution-sandbox.md`](PLAN-execution-sandbox.md) (runtime) and
[`PLAN-code-interpreter.md`](PLAN-code-interpreter.md) (consumer).

## Question

When agent-py runs chat on `/v1/runs`, how should `runCode` execute? agent-py
is a Python FastAPI service in Docker. The planned host is a small shared-vCPU
Linux VM, Hetzner CX22 (`PLAN-agent-api.md` §Host decision). Should agent-py
call "the same microsandbox server over HTTP" that Next uses, or do something
else?

## Current setup on Next (read from the code)

- **No server and no HTTP.** `lib/server/code-sandbox/microsandbox-client.ts`
  imports the npm `microsandbox` SDK (pinned `^0.5.7`, a native NAPI binding,
  listed in `serverExternalPackages`). Each `run()` boots one microVM as a
  child process of the Next server:
  `Sandbox.builder(name).image(img).replace().cpus(CPUS).memory(MiB(MEM_MIB)).disableNetwork().create()`.
- **`CODE_SANDBOX_BASE_URL` is only an on-switch.** `config.ts` says so: the
  embedded runtime ignores the URL, and the remote backend it was reserved for
  doesn't exist. `select-sandbox.ts` always returns the microsandbox client.
  Locally, `msb` 0.5.7 is installed at `~/.microsandbox/bin/msb` (not on
  `PATH`). Its `--help` lists no `server` subcommand.
- **Running code.** `sb.execWith("python3" | "node", e => e.args(["-c" | "-e", code]).timeout(ms))`
  runs it. On timeout the SDK throws `ExecTimeoutError`, which becomes exit
  code 124. An abort calls `sb.stop()`. A module-level semaphore
  (`MAX_CONCURRENT`, default 2) limits how many VMs run at once.
- **Files in.** The client sends a `sandboxFiles` manifest of `{name, fileId,
  dataBase64?}` entries. `resolveMountFiles` (`mount-files.ts`) picks the files
  the model named, makes their names safe, removes duplicates and applies the
  caps. Cloud files are downloaded through the user's RLS-scoped Supabase
  client (`download-user-file.ts`). Each file is written to
  `/mnt/files/<name>` with `sb.fs().write` before the code runs.
- **Results out.** After the run, the client reads back three things:
  - `/tmp/*.png|svg` become image cells.
  - `/tmp/*.table.json` become table cells.
  - Everything in `/tmp/outputs/` becomes a whole file.

  `marshal.ts` caps them and builds the `CodeRunResult`. The route
  (`maybeEmitCodeResultFrames`) then splits it three ways:
  - Charts go to `persistGeneratedImages`, then out as `data-tool-image` with `mode: "code"`.
  - Files go to `persistGeneratedFiles`, then out as `data-tool-file`.
  - stdout, stderr, tables and text go out as `data-code-result`.
- **Caps** (`config.ts`, all overridable by env):

  | Cap | Default |
  |---|---|
  | Timeout | 30 s |
  | stdout/stderr | 256 KB |
  | Result payload | 10 MB |
  | Files read back | 20 |
  | VM size | 512 MiB, 1 vCPU |
  | Mounted files | 10 MB each, 20 MB total, at most 10 files |
  | Tables | 50 columns × 1000 rows, 500 characters per cell |

  The network is off. Images default to `jupyter/scipy-notebook` (Python) and
  `node` (JavaScript).
- **What already exists on agent-py.** The event IR has `CodeResultEvent`,
  `ToolImageEvent` (mode `code`) and `ToolFileEvent` (`events.py`). The AG-UI
  encoder maps `code_result` to `hummingbird.code_result`
  (`packages/contract/RUN_EVENTS.md`). `chat_loop.py` already emits
  `tool_image` and `tool_file` parts from `ToolInvocationResult.images` and
  `.files`. Two pieces are missing:
  - Nothing produces `code_result`, and `ToolInvocationResult` has no field for it.
  - There is no Python port of `persistGeneratedFiles`. Only
    `image_storage.persist_generated_image` exists.

## Findings

### 1. Is there a microsandbox server agent-py can call? No. Is there a Python SDK? Yes.

- **microsandbox has no self-hosted server.** The README says "No setup
  server. No long-running daemon", and `create()` "boots a microVM as a child
  process" ([repo README](https://github.com/superradcompany/microsandbox)).
  `msb` 0.5.7 has no server command (checked locally). In the current docs,
  "local" means the SDK embedded in your process. "Remote" means their managed
  cloud REST API at `https://api.microsandbox.dev`, which is in **private
  beta** ([cloud/overview](https://github.com/superradcompany/microsandbox/blob/main/docs/cloud/overview.mdx),
  [api-reference/overview](https://github.com/superradcompany/microsandbox/blob/main/docs/api-reference/overview.mdx)).
  A remote context can point at "another compatible API" through
  `MSB_API_URL` / `RemoteContext.with_url(...)`
  ([cloud/connect](https://github.com/superradcompany/microsandbox/blob/main/docs/cloud/connect.mdx)).
  **Not verified:** I found no open-source implementation of that API, so
  self-hosting it doesn't look possible today.
  *(Correction: `PLAN-execution-sandbox.md` describes a "local daemon
  (JSON-RPC)". That was the pre-0.5 design. The plan's own Phase 1 already
  found that neither SDK needs `msb server`.)*
- **The official Python SDK is [`microsandbox` on PyPI](https://pypi.org/project/microsandbox/).**
  The latest is **0.7.16** (2026-11-18). The GitHub release
  [v0.7.16](https://github.com/superradcompany/microsandbox/releases) has the
  same date. It needs Python ≥ 3.10. Wheels exist for Linux glibc ≥ 2.28
  x86-64 and arm64, and for macOS 14+ arm64. The wheels bundle `msb` and
  `libkrunfw`. The docs on `main` already describe v0.8.0 (SDK contexts,
  local-only and remote-only packages), but v0.8.0 is not released yet.
- **The Python API covers everything Next uses:**

  | Next (Node 0.5.7) | Python 0.7.x ([sandbox](https://github.com/superradcompany/microsandbox/blob/main/docs/sdk/python/sandbox.mdx), [execution](https://github.com/superradcompany/microsandbox/blob/main/docs/sdk/python/execution.mdx), [filesystem](https://github.com/superradcompany/microsandbox/blob/main/docs/sdk/python/filesystem.mdx), [networking](https://github.com/superradcompany/microsandbox/blob/main/docs/sdk/python/networking.mdx)) |
  |---|---|
  | `Sandbox.builder(n).image().replace().cpus().memory(MiB()).disableNetwork().create()` | `await Sandbox.create(n, image=…, cpus=…, memory=<MiB>, network=Network.none(), replace=True)`, usable as an async context manager |
  | `sb.execWith(cmd, e => e.args([...]).timeout(ms))` → `.stdout()` / `.stderr()` / `.code` | `await sb.exec(cmd, [...], timeout=seconds)` → `.stdout_text` / `.stderr_text` / `.exit_code`; raises `ExecTimeoutError` |
  | `sb.fs().write` / `.read` / `.list` / `.mkdir` | `sb.fs.write` / `.read` / `.list` (`FsEntry.kind`, `.size`) / `.mkdir` |
  | `sb.stop()` | `async with` exit, or stop |

  The port needs no new capability. Two differences to plan for:
  - **Versions differ.** Next is on 0.5.7, two minors behind. v0.7 changed the
    on-disk storage format, and "Local creation no longer downloads missing
    runtimes" ([migrations/v0.7](https://github.com/superradcompany/microsandbox/blob/main/docs/migrations/v0.7.mdx)).
  - **A home-installed runtime wins.** The v0.7 migration guide says "a
    home-installed runtime takes precedence over Python and Node bundles".
    "Older SDK applications … sharing `MSB_HOME`" must be stopped and upgraded
    together, and the setup docs list the lookup order
    ([sdk/setup](https://github.com/superradcompany/microsandbox/blob/main/docs/sdk/setup.mdx)).
    On the dev Mac, `~/.microsandbox` already holds the 0.5.7 runtime that Next
    uses. agent-py therefore needs its own `MSB_HOME`.

### 2. Deployment: KVM, Hetzner CX22, Docker

- **Linux needs a usable `/dev/kvm`, and no other privileges.** The docs say
  "No setuid, no elevated capabilities", usually via the `kvm` group
  ([security/isolation](https://github.com/superradcompany/microsandbox/blob/main/docs/security/isolation.mdx)).
  Inside a VM, "the outer environment must expose nested virtualization before
  `/dev/kvm` can appear"
  ([troubleshooting/linux](https://github.com/superradcompany/microsandbox/blob/main/docs/troubleshooting/linux.mdx)).
- **Hetzner Cloud probably has no `/dev/kvm`. Not verified first-hand.**
  - Hetzner's [cloud FAQ](https://docs.hetzner.com/cloud/technical-details/faq)
    says only that the hypervisor is KVM. It never mentions nested
    virtualization, and neither does [docs.hetzner.com/llms.txt](https://docs.hetzner.com/llms.txt).
  - Hetzner's own [community Proxmox tutorial](https://community.hetzner.com/tutorials/proxmox-on-cloud)
    (2021) says "we can´t (till now) use KVM, as nesting is not supported/enabled".
  - A third-party test from May 2026 found that "no Hetzner Cloud tier (CCX,
    CPX, CAX) exposes nested virt. `/dev/kvm` is absent"
    ([mvm-deployment-docs](https://mvm-deployment-docs.pages.dev/providers/hetzner/)).

  Treat CX22, and the dedicated-vCPU CCX types too, as **unable to run
  microsandbox locally**. Running `ls /dev/kvm` on the box would settle it.
  Hetzner **dedicated root servers** are bare metal and list "Virtualization
  (AMD-V)". The cheapest, AX41, is €59/month excl. VAT with no setup fee
  ([matrix-ax](https://www.hetzner.com/dedicated-rootserver/matrix-ax/), fetched
  2026-11-22).
- **Docker works if you pass `/dev/kvm` through.**
  [how-to/docker](https://github.com/superradcompany/microsandbox/blob/main/docs/how-to/docker/docker.mdx)
  uses `--device /dev/kvm`, without `--privileged`, and says "`--privileged`
  cannot create a KVM device that the Docker environment does not have". It
  recommends a volume for the image cache. Their Kubernetes example installs
  the Python wheel in `python:3.12-slim-bookworm`: "The Python package includes
  the runtime and kernel firmware; the pod needs no Docker daemon"
  ([how-to/sandboxing/kubernetes](https://github.com/superradcompany/microsandbox/blob/main/docs/how-to/sandboxing/kubernetes.mdx)).
  agent-py's base image is `python:3.12-slim`, a current Debian with glibc
  well above 2.28, so it fits. The container runs as the non-root `agent` user,
  so that user needs read/write on `/dev/kvm`. On a KVM host, the compose delta is:

  ```yaml
  agent-py:
    devices: ["/dev/kvm:/dev/kvm"]
    group_add: ["${KVM_GID}"]          # gid of /dev/kvm on the host (stat -c %g /dev/kvm)
    environment:
      CODE_SANDBOX_ENABLED: "1"
      MSB_HOME: /msb                   # separate from any other microsandbox home
    volumes: ["msb-data:/msb"]         # OCI image cache + sandbox DB; must be writable by `agent`
  ```

- **Docker Desktop on the dev Mac does not expose `/dev/kvm`.** I checked
  locally (Docker Desktop 29.5.3, aarch64):
  `docker run --device /dev/kvm alpine` fails with "no such file or directory".
  To test `runCode` on the Mac, agent-py has to run on the host
  (`uv run uvicorn …`, so HVF is used) or use a remote backend. `docker compose
  up agent-py` cannot run it.
- **Memory.** Each VM reserves `MEM_MIB` (512 MiB by default) on top of
  agent-py. agent-py runs a single uvicorn process (no `--workers`), so a
  process-level semaphore really does bound the count. Set a small
  `CODE_SANDBOX_MAX_CONCURRENT` on small hosts.

### 3. Fallbacks when the host has no KVM

| Option | Isolation | Fit for agent-py | Rough cost |
|---|---|---|---|
| **KVM host** (Hetzner AX41 dedicated, home server or NAS with VT-x/AMD-V) | microVM with its own kernel, unchanged | Same embedded SDK; only the compose change above | AX41 €59/month vs a few € for CX22 |
| **microsandbox managed cloud** (`MSB_BACKEND=remote`, `MSB_API_KEY`) | microVM on their hosts; **user files and code leave our infra** | Same SDK and code; backend picked by env. Private beta: access not verified. Some features are local-only: [limitations](https://github.com/superradcompany/microsandbox/blob/main/docs/cloud/limitations.mdx) lists low-level fs handles and custom networking. Whether `Network.none()` and fs list/read work remotely is **not verified** | Shared: $0.007/vCPU-h, $0.000375/GiB-h; Standard: $0.048 / $0.003 ([cloud/pricing](https://github.com/superradcompany/microsandbox/blob/main/docs/cloud/pricing.mdx)). One 30 s run of 1 vCPU + 0.5 GiB costs a fraction of a cent. Builder plan $20/month incl. $20 credit |
| **Anthropic code execution tool** (`code_execution_20260521`, no beta header) | Anthropic-hosted container; no internet; 1 CPU / 5 GiB RAM / 5 GiB disk; data kept up to 30 days; **not ZDR-eligible** | A natural fit, since agent-py only allows `anthropic/*` models. But it is a **different tool shape**: Claude runs the code server-side. User files go in as Files API uploads (`container_upload`), generated files come back as Files API ids we'd download and re-store, and results arrive as `bash_code_execution_tool_result` blocks, not our `runCode`. Behaviour would differ from Next's `runCode` (Python/bash only, no `/mnt/files` or `/tmp/outputs` conventions) | 1,550 free hours/month per org, then $0.05/container-hour (5 min minimum). Free when `web_search_20260209`/`web_fetch_20260209` is in the request ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)). agent-py's web tools are its own providers, so that waiver wouldn't apply unless we switch |
| **E2B** hosted | Firecracker microVM | New adapter; Jupyter-style SDK | $0.000014/vCPU-s + $0.0000045/GiB-s; Hobby gets $100 one-time credit with 1 h sessions; Pro $150/month ([pricing](https://e2b.dev/pricing)). Self-hosting also needs KVM ([e2b-dev/runtime](https://github.com/e2b-dev/runtime)) |
| **Modal Sandboxes** | gVisor by default, or a VM runtime | New adapter; `block_network=True` | ~$0.0000394/core-s (1 core = 2 vCPU) + $0.00000667/GiB-s (3× function rates); $30/month free credit ([pricing](https://modal.com/pricing), [Sandbox API](https://modal.com/docs/sdk/py/latest/Sandbox)) |
| **Daytona** | "dedicated kernel" claimed; mechanism not confirmed | New adapter. The OSS repo is AGPL-3.0, and it was **archived Oct 2026** (development moved to a private codebase) | $0.0504/vCPU-h + $0.0162/GiB-h; $200 free credit ([pricing](https://www.daytona.io/pricing)) |
| **gVisor on the CX22** (`runsc`, systrap platform) | Userspace kernel: weaker than a microVM, much stronger than a plain container | Works without KVM. The [platforms guide](https://gvisor.dev/docs/architecture_guide/platforms/) calls systrap "a better choice when running inside a VM". But agent-py would have to start containers: either Docker-socket access (root-equivalent, so no) or our own `runsc` runner sidecar. That is the most new code, and the images/caps/fs conventions would need reimplementing | Free; runs on the existing VM |

## Recommendation

1. **Embed the Python SDK in agent-py, as Next embeds the Node SDK. Don't add
   an HTTP sidecar.** microsandbox has no server to share, so a sidecar would
   be a service of our own: another container, an internal auth token, and a
   byte-moving wire for 20 MB in and 10 MB out. It adds no isolation, because
   the microVM is the boundary either way. Reconsider a sidecar only if
   Next and agent-py should share one sandbox host, or if `/dev/kvm` must stay
   out of the API container.
2. **Choose the host before the code.** A CX22 can't run the local backend,
   so the implementation wave needs one decision:
   - (a) move agent-py to a KVM-capable host. This keeps the "local,
     segregated" decision in `PLAN-execution-sandbox.md`.
   - (b) stay on the CX22 and set `MSB_BACKEND=remote` (microsandbox cloud).
     It's the same code, but third-party data handling, and it depends on
     getting into the beta.
   - (c) treat Anthropic's code execution tool as a separate, later option.
     It needs no infra, but it changes how the feature behaves, so it isn't a
     drop-in replacement for `runCode`.

   Until the host is decided, the feature should register only where a
   preflight passes (see the shape below).
3. **Shape of the port:**
   - `services/agent-py/src/agent_py/code_sandbox/`:
     - `types.py`: `CodeRunInput`, `CodeRunResult`, `CodeResult` and `CodeFile`
       dataclasses, plus a `CodeSandbox` Protocol (`async def run(input) ->
       CodeRunResult`). Field for field the same as `lib/server/code-sandbox/types.ts`.
     - `config.py`: the same `CODE_SANDBOX_*` env names and defaults, in `settings.py`.
     - `microsandbox_sandbox.py`: boot, write mounts, exec, read back
       `/tmp/*.png|svg`, `/tmp/*.table.json` and `/tmp/outputs/*` under the
       same count and byte budget, then stop in `finally`. Cancel by catching
       `asyncio.CancelledError` and stopping the VM (cancelling a wait does
       not cancel the SDK deadline). A module-level `asyncio.Semaphore(MAX_CONCURRENT)`.
     - `marshal.py`, `mount_files.py`, `mime.py`: ports of the pure TS helpers.
       Reuse the TS test cases as pytest fixtures so both sides stay in step.
     - `select.py`: returns a sandbox or `None` (no mock). Preflight at boot:
       local backend means `/dev/kvm` is readable/writable, or the platform is
       macOS arm64; remote means `MSB_BACKEND=remote` plus a key. A failed
       preflight logs once and leaves `runCode` unregistered.
   - **The tool:** `tools/run_code.py` is a `ToolDescriptor` named `runCode`
     with the same input schema and the same prompt fragment as
     `lib/server/skills/code-interpreter.ts`. It is gated by the shared
     web-tool budget, like Next.
     - The model-facing `text` holds stdout, stderr, mount notes and a line
       like "2 charts, 1 file returned". It must not carry base64 back to the
       model.
   - **Files in, by reference (Q44).**
     - `forwardedProps` gains `sandboxFiles: [{name, fileId}]` in
       `packages/contract/openapi.yaml`, regenerated with `contract:gen`.
     - Cloud files are fetched by id. agent-py's Storage client bypasses RLS,
       so it must first check `files.user_id = caller` itself, then download
       the `storage_path` from `user-files`. No owner match means "could not
       be loaded" (a note to the model, never an error that leaks existence).
     - Inline `dataBase64` is allowed only for a signed-out caller's local
       files. The run body is capped at 16 MB, which is below the 20 MB mount
       total once base64 adds a third. Signed-out mounts are therefore limited
       by the body cap, and this should be stated in the error note.
   - **Results out on runs:**
     - Charts go through `image_storage.persist_generated_image`, then out as
       `ToolInvocationResult.images` with `image_mode="code"`. This path
       already exists.
     - Files go through a new `file_storage.persist_generated_file`, a port of
       `lib/server/file-storage.ts`, then out as `ToolInvocationResult.files`
       (`tool_file`, also existing).
     - stdout, stderr, tables and text go into a new
       `ToolInvocationResult.code_result` field. `chat_loop.py` emits it as
       `CodeResultEvent` with `tool_call_id`, after the image and file parts,
       in the same order as Next. The encoder and `RUN_EVENTS.md` already
       carry `hummingbird.code_result`.
     - `localFilesOnly` (still an open checklist item) applies to both
       persists, as on Next.
4. **What the follow-up implementation wave needs:**
   - the host decision from point 2;
   - an exact pin of `microsandbox` in `pyproject.toml` (0.7.x now; v0.8
     changes the APIs, see [migrations/v0.8](https://github.com/superradcompany/microsandbox/blob/main/docs/migrations/v0.8.mdx));
   - a separate `MSB_HOME` for agent-py;
   - the compose `devices` / `group_add` / volume change, plus a KVM-host
     variant documented in `services/agent-py/README.md`;
   - the contract field (`sandboxFiles`) and the `code_result` producer;
   - the file-storage port;
   - a fake `CodeSandbox` for pytest and for the stub harness or conformance;
   - one manual smoke on a KVM host: print, a chart, a mounted CSV, a
     `/tmp/outputs` file, a timeout, a cancel mid-run;
   - closing the `runCode` / `sandboxFiles` / `code_result` checklist line
     in the split plan.

   Separately, consider bumping Next from 0.5.7 to the same 0.7.x so the two
   sides don't drift. Hosts that share a home must upgrade together.

## Open items (not verified in this trial)

- Whether `/dev/kvm` is absent on a CX22 or CCX today. There is no official
  Hetzner statement; one `ls /dev/kvm` on the VM would settle it.
- Whether the microsandbox cloud supports `Network.none()`, `fs.list` and
  `fs.read`, and whether we can get into the private beta. Whether any
  self-hostable server for the remote API exists.
- Python SDK 0.7.x boot, mount and read-back were not run. No VMs were started
  in this trial; the Python boot smoke in `PLAN-execution-sandbox.md` was on
  an older version.
- Whether the `jupyter/scipy-notebook` default or `docker/runcode-python.Dockerfile`
  pulls and boots under 0.7.x, and the image-cache disk needed on a small host.
- What "1 vCPU" costs in boot latency on a shared host. No numbers were measured.
