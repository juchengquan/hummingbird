# syntax=docker/dockerfile:1
#
# Slim Python image for the runCode sandbox (CODE_SANDBOX_PYTHON_IMAGE).
#
# The sandbox runs AIRGAPPED (microsandbox `.disableNetwork()`), so the
# scientific stack the runCode skill advertises must be baked into the image —
# there is no `pip install` at run time. This is a ~550 MB alternative
# to the multi-GB default `jupyter/scipy-notebook`, suited to small self-host
# VMs. microsandbox boots it exactly like the stock `python` image: `python3`
# is on the default PATH (/usr/local/bin), so no per-image runtime tweaks.
#
# Build + push to a registry your sandbox HOST can pull from (the host pulls
# the image before the airgapped guest runs), then point the app env at it:
#
#   docker build -t ghcr.io/<you>/runcode-python:1 -f docker/runcode-python.Dockerfile .
#   docker push   ghcr.io/<you>/runcode-python:1
#   # then set in the app environment:
#   CODE_SANDBOX_PYTHON_IMAGE=ghcr.io/<you>/runcode-python:1
#
# Multi-arch (match your host CPU — HVF on Apple Silicon = arm64, most Linux
# VMs = amd64):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t ghcr.io/<you>/runcode-python:1 -f docker/runcode-python.Dockerfile --push .

FROM python:3.12-slim

# No display in the microVM: default matplotlib to the headless Agg backend so
# `savefig` works and `plt.show()` is a harmless no-op. Keep pip quiet + slim.
ENV MPLBACKEND=Agg \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# The libraries the runCode prompt advertises. Pinned to majors for
# reproducible-ish builds; bump as needed. These ship manylinux wheels, so no
# compiler toolchain is needed on slim.
RUN pip install \
      "numpy>=2,<3" \
      "pandas>=2,<3" \
      "matplotlib>=3,<4"

# Fail the BUILD (not the first runCode call) if the stack can't import.
RUN python3 -c "import numpy, pandas, matplotlib; print('runcode-python OK', numpy.__version__, pandas.__version__, matplotlib.__version__)"
