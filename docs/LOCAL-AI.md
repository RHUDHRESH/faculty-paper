# Local inference

The two discovery features — *Find venues* and *Directions* — used to post a
faculty member's unpublished title, abstract and publication history to a
hosted API in exchange for a key. They now run against a model on the same
machine as the server. Nothing leaves the loopback interface, and there is no
account, key or quota anywhere in the path.

## Configuration

Six variables, none of them secret:

```
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma4:12b          # the considered one
OLLAMA_FAST_MODEL=gemma3:4b      # the interactive one
OLLAMA_KEEP_ALIVE=2m             # how long the considered one stays resident
OLLAMA_FAST_KEEP_ALIVE=30m       # how long the fast one stays resident
```

All of them have working defaults, so an unconfigured server that has Ollama
running and both tags pulled already works. `OLLAMA_TIMEOUT_SECONDS`
(default 240) bounds a single request.

`AI_PROVIDER` takes one value. An unrecognised one is refused rather than
quietly resolved to something that happens to work — a typo in a deployment
variable should stop the feature, not silently change where the text goes.

## Two models, and who picks

Everything here runs on the CPU, so speed follows parameter count almost
linearly. One model could not serve both kinds of work: 4.5 tokens a second is
acceptable for something somebody starts and walks away from, and unusable for
something they watch. So there are two.

| | tag | for |
|---|---|---|
| considered | `gemma4:12b` | *Find venues*, *Directions*, *Openings* — a minute of somebody's patience, and a rupee figure at the end |
| interactive | `gemma3:4b` | the thread assistant — somebody is on the page waiting for a reply |

A caller picks with a keyword:

```python
ai.ask_json(prompt, schema=...)             # considered — unchanged
ai.ask_json(prompt, schema=..., fast=True)  # interactive
```

`fast` defaults to `False`, so every caller written before this change goes to
exactly the tag it always did. **Nothing infers the tier.** There is no
heuristic on prompt length or load, because which features can afford which
wait is a product judgement, and a heuristic that guessed wrong would silently
downgrade the one answer that has money attached to it.

Do not move a feature to the fast tier because it feels slow. The smaller
model is measurably worse at holding a schema, and the thing that makes the
venue search safe is the database check underneath it — not the model.

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
ollama pull gemma3:4b
```

The application reports which of these is missing, **per model**. `ai.health()`
answers `service_down`, `model_missing`, `misconfigured` or `ready` for the
considered model in `code`/`detail`, and the same four for the fast one in
`fast_code`/`fast_detail`, alongside `ready` and `fast_ready`.

They are separate because they fail separately. A server with `gemma4:12b`
installed and `gemma3:4b` missing answers `code: "ready"` and
`fast_code: "model_missing"` in the same breath — `ready` true, `fast_ready`
false: the venue search works, the thread assistant does not, and the
remedy is one `ollama pull` naming the tag that is actually absent. A screen
told only "ready" would be lying to whoever is waiting for a reply, and one
told only "not ready" would send somebody to re-pull a model they already have.

> `/api/discover/status` and the other endpoints in `core/api.py` still read
> only `code`/`detail`, which is correct for them — they front the considered
> features. A screen that wants to report the assistant's readiness needs to
> read `fast_code`; that change belongs in `api.py`, which this did not touch.

## Why this pair

Measured on the machine this was built against, not chosen from a table.

| | |
|---|---|
| CPU | Intel i3-14100, 4 cores / 8 threads |
| RAM | 31.8 GB total, **20.3 GB free** with no model resident |
| GPU | Intel UHD 730 (integrated) — **no usable acceleration** |
| Disk | 113 GB free |

Ollama accelerates on CUDA, ROCm and Metal. An Intel UHD 730 is none of those,
so **everything here runs on the CPU** — confirmed at runtime, not assumed:
`/api/ps` reports `size_vram: 0.00 GB` with the model resident.

That makes free RAM the binding constraint:

| tag | download | verdict |
|---|---|---|
| `gemma4:12b` | 7.04 GB | **considered tier** — 8.90 GB resident |
| `gemma3:4b` | 3.11 GB | **fast tier** — 2.88 GB resident |
| `gemma4:26b` | 17.33 GB | does not fit; would page to disk continuously |
| `gemma4:31b` | 18.50 GB | worse |

26b and 31b are not slow on this hardware, they are unusable: neither fits in
free memory, so both would thrash. 12b is the largest that runs with real
headroom.

### Do both fit?

Measured rather than assumed, with `/api/ps` and the OS both read while the
two were resident together:

```
gemma4:12b   8.90 GB resident,  0.00 GB on GPU
gemma3:4b    2.88 GB resident,  0.00 GB on GPU
             ----------------
             11.78 GB of models

31.77 GB total, 7.50 GB still free with both loaded
```

**They fit, with 7.5 GB to spare, and they do not thrash.** That was the open
question and it was worth checking directly: loading the 12b from cold with
the small model already resident took 21.6s against 18.4s with the machine
otherwise empty — about 0.8s of it in the load itself. A three-second penalty
on a cold path that already costs eighteen is a cost, not a collapse.

An earlier note in this file recorded 13.8 GB free; that was measured under a
different load, and 20.3 GB was free with nothing resident on the run these
numbers come from. Free memory on a shared machine is a moving figure, so the
one to plan against is the 11.78 GB the two models actually occupy. The margin
is real but it is not unlimited, which is why the two `keep_alive` values are
deliberately different rather than both left at Ollama's default:

- **`OLLAMA_FAST_KEEP_ALIVE=30m`** — the fast model is held. Being warm is its
  entire value; a 3.1s reload is a third of the answer it is there to give.
- **`OLLAMA_KEEP_ALIVE=2m`** — the considered model is let go sooner. Its
  reload costs about 6.4s against a request that already takes a minute and a
  half, so releasing 8.9 GB is nearly free.

Set both to `-1` to pin them and `0` to unload immediately after each answer;
the values are passed to Ollama untouched.

### Benchmark

The same real request for both — classify a paper into a research area,
`format: json`, temperature 0, run against the live daemon:

| | `gemma4:12b` | `gemma3:4b` |
|---|---|---|
| cold, total | **18.4 – 21.6s** | **10.5s** |
| — of which loading | 6.4 – 7.2s | 3.1s |
| — of which reading the prompt | 2.6 – 3.0s | 2.3s |
| warm, total | **15.1s / 16.4s** | **5.4s / 5.3s** |
| generation | 4.1 – 4.5 tok/s | 13.9 – 14.3 tok/s |
| resident | 8.90 GB | 2.88 GB |
| on GPU | 0.00 GB | 0.00 GB |

**The fast model is 3.3x faster per token and answers the same question in
about a third of the wall time**, warm. Reading the prompt speeds up by rather
more than generation does, which is why the two tiers get their own expected
figures in `ai.py` rather than one scaled by a ratio.

One number here is worth not trusting: the first cold 12b load after pulling
several gigabytes took **49.6s**, with 24.0s of it in the load. That is the
page cache, not the model. Steady state is the 18–22s in the table, and it is
the honest figure to plan against.

End to end, the actual *Find venues* feature on the considered tier: **91.8s**,
returning 8 verified journals with quartiles and rupee amounts from our own
tables, plus one name the model mangled, correctly quarantined as unverified
and carrying no amount.

Roughly 4.5 tokens a second is the number the considered features follow from.
It is why `ASK_FOR` dropped from 12 journals to 9 — the three extra cost about
a minute of somebody's wait — and why the request ceiling is 240s rather than
120s. The UI says a minute or two, because it is.

A machine with a discrete GPU would run both tags an order of magnitude faster
with no configuration change.

## Thinking is off, and must stay off — on both models

`THINK = False` in `core/services/ollama.py`. It is not a tuning preference;
each model breaks in its own way with it on, and both ways were re-measured
after the fast tier was added.

**`gemma4:12b` reasons before answering, and silently.** With thinking on and
a normal token ceiling, it spends the entire budget reasoning and returns an
**empty string** with `done_reason: "length"` — an HTTP 200 carrying nothing.
Re-confirmed on the current build:

```
think=true    20 tokens of budget →   0 chars of answer, 70 chars of thinking
think=false   20 tokens of budget →  97 chars of answer
```

Reasoning nobody reads is also time nobody waits for: on the same prompt,
thinking on pushed prompt evaluation from 0.6s to 3.2s, and 0.8s to 9.7s on
the longer one — several seconds per call for output that is discarded.

**`gemma3:4b` behaves differently, and this is worth knowing before anybody
tries to turn thinking on.** It does not reason silently; it refuses outright:

```
POST /api/generate  {"model": "gemma3:4b", "think": true}
→ HTTP 400  {"error": "\"gemma3:4b\" does not support thinking"}
```

So on the fast tier, thinking-on is not a blank answer from a healthy server —
it is **every call failing**, surfaced as `service_error` → `rejected`. The
same one-line setting prevents both, which is the only reason one setting is
enough for two models that fail this differently.

## One more thing worth knowing about a smaller model

**A smaller model misses its schema more often**, and `gemma3:4b` is smaller
again than the model that observation was first made about. Asked for
`{"journals": [...]}` it sometimes answers with the bare array. Calling `.get`
on that is an uncaught `AttributeError` — a 500 where a shrug would do — so
every parser accepts either shape and drops entries that are not objects.

Measured, not assumed. Five thread-shaped questions put through `ask_json`
against the thread assistant's own schema, on a machine that was busy at the
time: of the calls that came back at all, `gemma3:4b` held the contract on two
of three and produced one answer that would not parse, raising
`AIError(code="unparsable")`. The 12b held it on four of four. One
unparsable answer in three is a small sample and the true rate is somewhere
looser than that, but the direction is not in doubt.

That failure is already handled where it lands: `thread_agent` treats an
`AIError` as "this reply is lost and nothing else is", logs the code and
returns `None`. So the cost of the fast tier is not a wrong answer, it is a
slightly higher chance of no answer — which is the right way for it to fail,
and the reason this trade is acceptable for a sentence in a discussion thread
and unacceptable for a venue with a payment beside it.

This is why the fast tier is opt-in per caller rather than a default.

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
| `backend/core/services/discover.py` | the two considered features, unchanged in shape |
| `backend/core/services/thread_agent.py` | the interactive one — the candidate for `fast=True` |
| `backend/core/test_inference.py` | the two-model tests; transport stubbed, no daemon needed |

`gemini.py` is gone. `GEMINI_API_KEY` and `GEMINI_MODEL` are no longer read
anywhere and can be removed from the environment.
