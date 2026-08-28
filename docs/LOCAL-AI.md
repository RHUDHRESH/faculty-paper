# Local inference

The two discovery features — *Find venues* and *Directions* — used to post a
faculty member's unpublished title, abstract and publication history to a
hosted API in exchange for a key. They now run against a model on the same
machine as the server. Nothing leaves the loopback interface, and there is no
account, key or quota anywhere in the path.

## Configuration

Three variables, none of them secret:

```
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma4:12b
```

All three have working defaults, so an unconfigured server that has Ollama
running already works. `OLLAMA_TIMEOUT_SECONDS` (default 240) bounds a single
request.

`AI_PROVIDER` takes one value. An unrecognised one is refused rather than
quietly resolved to something that happens to work — a typo in a deployment
variable should stop the feature, not silently change where the text goes.

**There is no fallback to a remote provider.** If the daemon is down, the
answer is that the daemon is down. A fallback would mean the one property this
arrangement exists to provide — that the text stays on this machine — stops
being true exactly when nobody is watching.

## Running it

```bash
ollama serve
```

```bash
ollama pull gemma4:12b
```

The application reports which of these is missing. `/api/discover/status`
answers `service_down`, `model_missing`, `misconfigured` or `ready`, and the
Discover page prints the one command that fixes it. "Off" used to be the only
thing it could say, which was the right diagnosis for one of the three causes
and misleading for the other two.

## Why gemma4:12b

Measured on the machine this was built against, not chosen from a table.

| | |
|---|---|
| CPU | Intel i3-14100, 4 cores / 8 threads |
| RAM | 31.8 GB total, **13.8 GB free** |
| GPU | Intel UHD 730 (integrated) — **no usable acceleration** |
| Disk | 113 GB free |

Ollama accelerates on CUDA, ROCm and Metal. An Intel UHD 730 is none of those,
so **everything here runs on the CPU** — confirmed at runtime, not assumed:
`/api/ps` reports `size_vram: 0.00 GB` with the model resident.

That makes free RAM the binding constraint:

| tag | download | verdict |
|---|---|---|
| `gemma4:12b` | 7.04 GB | **chosen** — 8.29 GB resident, ~4 GB headroom |
| `gemma4:26b` | 17.33 GB | exceeds 13.8 GB free; would page to disk continuously |
| `gemma4:31b` | 18.50 GB | worse |

26b and 31b are not slow on this hardware, they are unusable: neither fits in
free memory, so both would thrash. 12b is the largest that runs with real
headroom, which is the instruction this was chosen under.

### Benchmark

A real request from the product — classify a paper into a research area:

```
COLD   39.1s total   (8.5s loading 7 GB from disk)   4.47 tok/s
WARM   26.9s for 120 tokens                          4.57 tok/s
resident 8.29 GB, of which 0.00 GB on GPU
```

End to end, the actual *Find venues* feature: **91.8s**, returning 8 verified
journals with quartiles and rupee amounts from our own tables, plus one name
the model mangled, correctly quarantined as unverified and carrying no amount.

Roughly 4.5 tokens a second is the number everything else follows from. It is
why `ASK_FOR` dropped from 12 journals to 9 — the three extra cost about a
minute of somebody's wait — and why the request ceiling is 240s rather than
120s. The UI says a minute or two, because it is.

A machine with a discrete GPU would run the same tag an order of magnitude
faster with no configuration change.

## Two things worth knowing about Gemma 4

**It reasons before answering, and silently.** With thinking left on and a
normal token ceiling, the model spends the entire budget reasoning and returns
an **empty string** with `done_reason: "length"` — an HTTP 200 carrying
nothing. Measured: 20 tokens of budget produced 0 characters with thinking on,
and a correct answer in 10 tokens with it off. `THINK = False` in
`core/services/ollama.py` disables it. Reasoning nobody reads is also thirty
seconds nobody waits for, at this speed.

**A smaller model misses its schema more often.** Asked for
`{"journals": [...]}` it sometimes answers with the bare array. Calling `.get`
on that is an uncaught `AttributeError` — a 500 where a shrug would do — so
both parsers accept either shape and drop entries that are not objects.

## The design that makes it safe

Unchanged from before, and more important now that the model is smaller:
**the model proposes, the database disposes.** Every journal name the model
produces is re-resolved against our own Scimago and SNIP tables. A name that
resolves carries a quartile and an amount; a name that does not is shown
separately with no numbers beside it.

A plausible-sounding venue with a confident payout next to it is how somebody
submits to a journal that does not exist. That split is the safety argument of
the whole feature, and no model output is ever trusted with a rupee figure.

## Files

| | |
|---|---|
| `backend/core/services/ollama.py` | the daemon client — health, bounded generate, streaming, cancellation |
| `backend/core/services/ai.py` | the provider seam every feature calls |
| `backend/core/services/discover.py` | the two features, unchanged in shape |

`gemini.py` is gone. `GEMINI_API_KEY` and `GEMINI_MODEL` are no longer read
anywhere and can be removed from the environment.
