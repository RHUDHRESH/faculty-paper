# The Gemma harness

The college's own inference service. It holds the Gemma weights, answers the
backend's model questions, and sends nothing to anybody else — no inference
vendor exists in this arrangement. Together with Google Cloud (where it
runs) and Vercel (where the app runs), it is the whole outside surface of
the system; everything else on this path is ours.

The backend talks to it when `AI_PROVIDER=harness` — see
`core/services/harness.py` for the client and `docs/OPS.md` for the
variables. On a developer laptop the same features run against Ollama
instead (`AI_PROVIDER=ollama`, `docs/LOCAL-AI.md`); the seam is tested
against both so the screens cannot tell the difference.

## The protocol

| Endpoint | What it does |
|---|---|
| `GET /health` | Which slots exist (`main`, `fast`), and are the weights loaded |
| `POST /v1/generate` | One prompt, the whole answer: `{"text", "tokens", "seconds"}` |
| `POST /v1/generate-stream` | Same, as NDJSON lines: `{"t":"start"|"token"|"done"}`, or `{"error":{"kind","message"}}` |
| `POST /v1/cancel` | `{"run_id"}` — end a streaming run whose reader went away |

Every response error carries a `kind` (`model_missing`, `timeout`,
`unreachable`, `service_error`), the same words the backend maps onto its
own HTTP statuses, so a screen can say what actually happened. If
`HARNESS_TOKEN` is set, every request must carry it as `X-Harness-Token`.

A generation that has `json: true` or a `json_schema` is decoded under a
grammar constraint — the model cannot answer in prose where JSON was asked
for. A schema the converter cannot handle degrades to the any-JSON grammar;
the backend repairs and re-parses regardless.

## The two slots

| Slot | Model | Why it exists |
|---|---|---|
| `main` | `gemma-3-12b-it-q4_k_m` | The considered tier: venue searches, directions. ~7.3 GB at Q4 |
| `fast` | `gemma-3-4b-it-q4_k_m` | The interactive tier: thread answers while somebody watches |

One generation at a time per slot (llama.cpp contexts are not shareable);
the two slots run concurrently, which is the point of having two. Each slot
is held in memory for its keep-alive after answering — `10m` for `main`,
`30m` for `fast`, the same asymmetry the backend sets on the laptop — and
unloaded by a reaper when idle. Weights load on first use, not at boot.

## Weights

The weights are a licensed copy of Gemma, downloaded once by the college and
stored in the college's own bucket. They are **not baked into the image**:

```bash
gcloud storage cp gemma-3-12b-it-q4_k_m.gguf gemma-3-4b-it-q4_k_m.gguf \
  gs://YOUR-BUCKET/models/
```

At cold start the harness pulls its slot's file from
`gs://$HARNESS_GCS_BUCKET/models/` into `/models` and keeps it for the life
of the instance.

## Deploying on Cloud Run (GPU)

```bash
gcloud run deploy gemma-harness \
  --source harness \
  --region asia-south1 \
  --gpu 1 --gpu-type l4 \
  --no-cpu-throttling \
  --min-instances 0 --max-instances 1 \
  --memory 16Gi \
  --set-env-vars HARNESS_GCS_BUCKET=YOUR-BUCKET,HARNESS_TOKEN=$(openssl rand -hex 32) \
  --no-allow-unauthenticated
```

- `--no-cpu-throttling` keeps background decode alive between requests, the
  same flag the API container needs for its queue worker.
- `--min-instances 0` bills the GPU only when used, and costs a cold start
  (tens of seconds of weight loading) after an idle period.
  `--min-instances 1` buys the warmth back at GPU prices.
- The Dockerfile is the CPU build by default; the GPU variant is a
  two-line change documented at the top of that file.

The backend then gets:

```
AI_PROVIDER=harness
HARNESS_BASE_URL=https://gemma-harness-...run.app   (or the private address)
HARNESS_TOKEN=<the same value>
```

With ingress `internal` and Direct VPC egress from the API service, the
token is belt-and-braces; on a VM deployment it is the only lock on the
door.

## Local run and tests

```bash
pip install -r harness/requirements.txt   # compiles llama.cpp from source
cd harness && uvicorn app:app --port 8300
python -m pytest test_app.py -q           # no weights, no llama.cpp needed
```

The tests inject a fake engine and exercise the real app: protocol order,
the shared-secret check, cancellation mid-stream (which reports
`{"t":"done","stopped":true}` — a cancelled run is not an error), and the
`model_missing` behaviour of a container that has booted before its weights
arrived.
