#!/usr/bin/env python3
"""semif-server — the operator-run scoring service behind a `kind: "semif"` decision backend.

It wraps upstream SemIf rather than reimplementing it: `load_causal_model` once at startup, then
`semif_phase1.direct.score` per request, which is the single-pass option-logit readout and emits the
row schema this server returns unchanged.

    python server.py --config ../../matrix.json --model-key qwen3.5-4b --host 127.0.0.1 --port 8791

The model key is resolved through the config's `decide.models` table, which is why that table exists:
the source and the 40-character revision live there, upstream refuses a remote model without a pinned
revision, and the client's request carries only the key.

Endpoints:
    POST /score   the row schema: {id, state, question, options[{id, description}], model, max_tokens}
    GET  /health  {status, model, source, revision, loaded} — answers before the weights finish loading,
                  so a probe can tell "server down" from "model still loading"

This process needs CUDA: upstream's loader requires exactly one visible device and BF16
(`semif_phase1/core.py`). On Apple silicon that check fails — see README.md for the operator patch and
for the hosted/container placements.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", type=Path, required=True, help="a matrix.json carrying decide.models")
    parser.add_argument("--model-key", required=True, help="the key in decide.models to load, e.g. qwen3.5-4b")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--max-tokens", type=int, default=4096, help="per-request input ceiling, no truncation")
    return parser.parse_args()


def load_direct():
    try:
        from semif_phase1 import direct  # type: ignore
    except ImportError as error:  # pragma: no cover - operator environment
        raise SystemExit(
            "semif_phase1 is not importable. Install upstream SemIf into this environment:\n"
            "  pip install -e /path/to/SemIf\n"
            f"(import error: {error})"
        ) from error
    return direct


def main() -> None:
    args = parse_args()
    direct = load_direct()
    from semif_phase1.core import load_causal_model  # type: ignore

    config = json.loads(args.config.read_text())
    spec = (config.get("decide", {}).get("models") or {}).get(args.model_key)
    if not spec or not spec.get("source"):
        raise SystemExit(f"decide.models.{args.model_key} is missing from {args.config}")
    source = spec["source"]
    revision = spec.get("revision")
    if not revision:
        raise SystemExit(f"decide.models.{args.model_key} has no revision; upstream requires a pinned commit")

    state: dict = {"loaded": False, "error": None}
    lock = threading.Lock()

    def worker() -> None:
        try:
            model, tokenizer, metadata = load_causal_model(source, revision)
            state.update(model=model, tokenizer=tokenizer, metadata=metadata, loaded=True)
            print(f"loaded {source}@{revision[:8]}", flush=True)
        except Exception as error:  # surface the reason through /health rather than dying silently
            state["error"] = f"{type(error).__name__}: {error}"
            print(f"model load failed: {state['error']}", file=sys.stderr, flush=True)

    threading.Thread(target=worker, daemon=True).start()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *values) -> None:  # quieter default logging
            print(f"{self.address_string()} {fmt % values}", flush=True)

        def _send(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - stdlib naming
            if self.path.rstrip("/") != "/health":
                self._send(404, {"error": "not found"})
                return
            self._send(200, {
                "status": "ok",
                "model": args.model_key,
                "source": source,
                "revision": revision,
                "loaded": bool(state["loaded"]),
                "error": state["error"],
            })

        def do_POST(self) -> None:  # noqa: N802 - stdlib naming
            if self.path.rstrip("/") != "/score":
                self._send(404, {"error": "not found"})
                return
            length = int(self.headers.get("content-length") or 0)
            try:
                row = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                self._send(400, {"error": "invalid json"})
                return

            if row.get("model") and row["model"] != args.model_key:
                # The client sends the key the deployment loaded; a mismatch is a config error, not a
                # reason to guess.
                self._send(422, {"error": f"this server loaded {args.model_key}, not {row['model']}"})
                return
            if not state["loaded"]:
                self._send(503, {"error": f"model not loaded yet ({state['error'] or 'loading'})"})
                return
            try:
                with lock:  # one model instance, serialised scoring
                    result = direct.score(state["model"], state["tokenizer"], row, state["metadata"], args.max_tokens)
            except ValueError as error:  # validation failures from upstream's own checks
                self._send(422, {"error": str(error)})
                return
            except Exception as error:  # pragma: no cover - runtime failure
                self._send(500, {"error": f"{type(error).__name__}: {error}"})
                return
            self._send(200, result)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"semif-server listening on http://{args.host}:{args.port} (model {args.model_key})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()