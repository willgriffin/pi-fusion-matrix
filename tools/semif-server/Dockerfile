# semif-server — CUDA image for a `kind: "semif"` decision backend.
#
#   docker build -t semif-server tools/semif-server
#   docker run --rm --gpus all -p 8791:8791 -v "$PWD/matrix.json:/app/matrix.json:ro" \
#     semif-server --config /app/matrix.json --model-key qwen3.5-4b --host 0.0.0.0
#
# One process per GPU: upstream requires exactly one visible CUDA device, so scale by running more
# containers with CUDA_VISIBLE_DEVICES set rather than by adding threads here. Weights are fetched on
# first start from Hugging Face at the pinned revision; mount a cache volume to avoid re-downloading.
FROM nvidia/cuda:12.8.0-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/cache/huggingface

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN python3 -m pip install --no-cache-dir --upgrade pip \
 && python3 -m pip install --no-cache-dir -r requirements.txt

# Upstream SemIf, pinned by commit so a rebuild cannot pick up different readout code.
ARG SEMIF_REPO=https://github.com/TheoLeeCJ/SemIf.git
ARG SEMIF_REF=master
RUN git clone "$SEMIF_REPO" /opt/SemIf \
 && git -C /opt/SemIf checkout "$SEMIF_REF" \
 && python3 -m pip install --no-cache-dir -e /opt/SemIf

COPY server.py ./

VOLUME ["/cache"]

# The container carries the service, never the config: mount matrix.json read-only so the source and
# revision come from the repository that owns them.
ENTRYPOINT ["python3", "server.py"]