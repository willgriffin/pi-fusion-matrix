# semif-server

The operator-run scoring service behind a `kind: "semif"` decision backend. It serves SemIf's
single-pass option-logit readout over HTTP so a decision stage, a cascade, a `route`, or a `verify` check
can run against your own GPU instead of a hosted API.

The model key, source, and revision come from the extension's config, not from here:

```bash
pip install -e /path/to/SemIf        # upstream, unmodified
python tools/semif-server/server.py --config matrix.json --model-key qwen3.5-4b
curl -s localhost:8791/health
```

## Endpoints

```http
GET  /health
→ { "status": "ok", "model": "qwen3.5-4b", "source": "Qwen/Qwen3.5-4B",
    "revision": "851bf6e8…", "loaded": true, "error": null }

POST /score
{ "id": "route-1", "state": "…", "question": "Which queue should handle this request?",
  "options": [{ "id": "access", "description": "…" }, { "id": "billing", "description": "…" }],
  "model": "qwen3.5-4b", "max_tokens": 4096 }
→ { "option_ids": […], "probabilities": […], "option_logits": […],
    "model": { "source": "…", "revision": "…" }, "total_seconds": 1.02, "prompt_sha256": "…" }
```

`/health` answers before the weights finish loading (`loaded: false`), so a probe can tell "server down"
from "model still loading". A request naming a different `model` than the one loaded is a `422`, not a
guess: the deployment decides which checkpoint answers.

## Where to run it

| Placement | What it takes | Config |
|---|---|---|
| Local CUDA host | one GPU, BF16 | `{"kind": "semif", "url": "http://127.0.0.1:8791/score", "model": "qwen3.5-4b"}` |
| Self-hosted server | the container, `--gpus all` | same, with the server's URL |
| Cloud container | any host with a GPU | same, plus `apiKeyEnv` if you put auth in front of it |
| GPU-less container or laptop | nothing to run | point at the hosted URL, or use the `typesafe` backend |

```bash
docker build -t semif-server tools/semif-server
docker run --rm --gpus all -p 8791:8791 \
  -v "$PWD/matrix.json:/app/matrix.json:ro" -v semif-cache:/cache \
  semif-server --config /app/matrix.json --model-key qwen3.5-4b --host 0.0.0.0
```

## Apple silicon

Upstream's loader requires exactly one visible CUDA device and BF16 (`semif_phase1/core.py`), which an
M4 Max cannot satisfy — and PyTorch's MPS backend has no BF16. On this machine, use the `typesafe` backend
and leave the local SemIf path for a CUDA host or a container. Making it run locally is an *operator* patch
to upstream, not something this repository carries:

1. accept `--device {cuda,mps,cpu}`, defaulting to cuda when available else mps else cpu, keeping the
   one-CUDA-device rule when cuda is chosen so the published baseline is untouched;
2. `torch.bfloat16` on cuda, `torch.float32` on mps/cpu — not fp16, which has known MPS 16-bit
   correctness problems; a 4B in fp32 is about 16 GB;
3. `device_map={"": device}`, and record the resolved device and dtype in the per-row `metadata`;
4. `torch.mps.synchronize()` beside the existing cuda sync, for accurate `forward_seconds`;
5. thread the flag through `cli.py`.

Upstream's own `REPRODUCE.md` permits this framing — it asks for measurements against the committed
evidence, not byte-identical outputs, and notes that BF16/kernel differences already move borderline
argmaxes. Expect MPS-fp32 to be slower than the published 3090-bf16 figures; measure before investing in
an MLX port, which would be a second implementation rather than a patch.

## Verification

```bash
node scripts/semif-probe.mjs --backend http://127.0.0.1:8791/score
```

The probe asserts the row schema, that probabilities align to the requested option order, and that they
sum to 1. It exits non-zero with the failing row, so "the server is misconfigured" and "the extension is
wrong" never look the same.