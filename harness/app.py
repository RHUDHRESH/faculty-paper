"""The harness's HTTP surface: four endpoints, one shared secret.

    GET  /health              which slots exist, and are their weights loaded
    POST /v1/generate         one prompt, the whole answer
    POST /v1/generate-stream  one prompt, the answer as NDJSON token lines
    POST /v1/cancel           end a streaming run somebody stopped waiting for

The stream's line vocabulary is what the Django client (core/services/
harness.py in the backend) parses:

    {"t":"start","run_id":"..."}       first line of a stream
    {"t":"token","text":"..."}         one piece of the answer
    {"t":"done","tokens":N,"seconds":S}
    {"error":{"kind":"...","message":"..."}}

Errors carry a ``kind`` -- unreachable, timeout, model_missing,
service_error, bad_output -- the same words the backend maps onto its own
HTTP statuses, so a screen can say "the model isn't loaded" rather than
"the AI is broken".

Run from the repo root:

    uvicorn app:app --host 0.0.0.0 --port 8300        (from harness/)
    python -m pytest test_app.py -q                   (no weights needed)
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from typing import Any, Iterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from engine import Engine, EngineError, RunCancelled

logger = logging.getLogger("harness.app")

#: Seconds a single generation may run before the harness stops it itself.
#: The backend keeps its own, shorter timeout; this is the backstop that
#: stops a wedged decode holding the slot forever even with no client
#: watching.
MAX_GENERATION_SECONDS = float(os.getenv("HARNESS_MAX_GENERATION_SECONDS", "600"))

app = FastAPI(title="faculty-gemma-harness", version="1.0.0")
engine = Engine()


@app.middleware("http")
async def shared_secret(request: Request, call_next):
    """One shared secret, when the harness is not behind IAM.

    The intended production arrangement is Cloud Run ingress=internal plus
    the backend's own identity, so the token is unset there. On a plain VM
    it is the only thing between the internet and the weights, so it is
    checked before anything else happens.
    """
    expected = (os.getenv("HARNESS_TOKEN") or "").strip()
    if expected and request.headers.get("X-Harness-Token") != expected:
        return JSONResponse(
            status_code=403,
            content={"error": {"kind": "rejected", "message": "Bad or missing token."}},
        )
    return await call_next(request)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "version": app.version,
        "device": engine.device,
        "slots": {
            key: {"name": slot.name, "loaded": slot.loaded}
            for key, slot in engine.slots.items()
        },
    }


@app.post("/v1/generate")
async def generate(request: Request) -> dict[str, Any]:
    data = await request.json()
    run_id = uuid.uuid4().hex
    engine.register_run(run_id)
    started = time.monotonic()
    pieces: list[str] = []
    try:
        for piece in engine.chat(
            model=str(data.get("model") or ""),
            prompt=str(data.get("prompt") or ""),
            system=data.get("system"),
            max_tokens=int(data.get("max_tokens") or 512),
            temperature=float(data.get("temperature") or 0.2),
            fmt=_constraint(data),
            keep_alive=data.get("keep_alive"),
            deadline=started + MAX_GENERATION_SECONDS,
            run_id=run_id,
        ):
            pieces.append(piece)
    except RunCancelled:
        return {"text": "".join(pieces), "stopped": True, "run_id": run_id}
    except EngineError as exc:
        raise HTTPException(
            status_code=404 if exc.kind == "model_missing" else 500,
            detail={"error": {"kind": exc.kind, "message": exc.message}},
        )
    finally:
        engine.finish_run(run_id)
    return {
        "text": "".join(pieces),
        "tokens": len(pieces),
        "seconds": round(time.monotonic() - started, 2),
        "run_id": run_id,
    }


@app.post("/v1/generate-stream")
async def generate_stream(request: Request):
    data = await request.json()
    run_id = uuid.uuid4().hex
    flag = engine.register_run(run_id)
    started = time.monotonic()

    def lines() -> Iterator[str]:
        yield json.dumps({"t": "start", "run_id": run_id}) + "\n"
        pieces = 0
        try:
            for piece in engine.chat(
                model=str(data.get("model") or ""),
                prompt=str(data.get("prompt") or ""),
                system=data.get("system"),
                max_tokens=int(data.get("max_tokens") or 512),
                temperature=float(data.get("temperature") or 0.2),
                fmt=_constraint(data),
                keep_alive=data.get("keep_alive"),
                deadline=started + MAX_GENERATION_SECONDS,
                run_id=run_id,
            ):
                pieces += 1
                yield json.dumps({"t": "token", "text": piece}) + "\n"
            yield json.dumps(
                {"t": "done", "tokens": pieces, "seconds": round(time.monotonic() - started, 2)}
            ) + "\n"
        except RunCancelled:
            yield json.dumps({"t": "done", "stopped": True, "tokens": pieces}) + "\n"
        except EngineError as exc:
            yield json.dumps(
                {"error": {"kind": exc.kind, "message": exc.message}}
            ) + "\n"
        finally:
            engine.finish_run(run_id)

    return StreamingResponse(lines(), media_type="application/x-ndjson")


@app.post("/v1/cancel")
async def cancel(request: Request) -> dict[str, Any]:
    data = await request.json()
    run_id = str(data.get("run_id") or "")
    if not run_id:
        raise HTTPException(status_code=400, detail="run_id is required")
    return {"stopped": engine.cancel(run_id)}


def _constraint(data: dict[str, Any]) -> str | dict | None:
    if data.get("json_schema"):
        return data["json_schema"]
    if data.get("json"):
        return "json"
    return None
