#!/usr/bin/env python3
"""fast_chat_ext.py - the single settings source and the extension hooks.

fast_chat.py reads every tunable through this file:

    environment variable  >  SETTINGS below  >  built-in default

So an environment variable still wins (handy for one-off runs), and otherwise
editing SETTINGS is the only place a value needs changing. `python fast_chat.py
--settings` prints the resolved values.

HOOKS are the four points the core calls into; a hook that raises prints one
line and the core carries on with its default path.

  parallel_workers()   READY   measured crossover, used by /images
  (long notes)         READY   autonote in SETTINGS, extracts facts after answers
  after_answer()       READY   per-turn stats, no extra model call
  semantic_recall()    READY   local TF-IDF vectors over the document store
  export_training()    READY   /export writes fine-tuning JSONL
  watch()              READY   live screen loop until the frame changes
  fan_out()            READY   several endpoints, but only if you list them
"""
import json
import math
import os
import re
import time
from pathlib import Path

# --------------------------------------------------------------------------- #
# master switch
# --------------------------------------------------------------------------- #
ENABLED = True

# --------------------------------------------------------------------------- #
# every tunable the app has. Edit a value here to change the default; an
# environment variable of the same name still overrides it for one run.
# --------------------------------------------------------------------------- #
SETTINGS = {
    # --- endpoint ---------------------------------------------------------
    "url": "https://quantumclaw.net/ollama/api/chat",   # or OLLAMA_URL
    "model": "qwen3.5:2b",
    "fast_model": "qwen3.5:2b",
    "keep_alive": "30m",
    "timeout": 180.0,
    "concurrency_timeout": 45.0,
    # --- reply budget and sampling ---------------------------------------
    "max_tokens": 400,
    "draft_tokens": 60,
    "good_enough": 4.5,          # candidate score that stops sampling
    "variants": 3,               # /vary candidates
    "temperature": 0.45,
    "top_p": 0.9,
    "top_k": 40,
    "repeat_penalty": 1.15,
    "repeat_last_n": 256,
    "think": False,              # reasoning pass on every call (qwen needs False)
    "draft": False,              # speculative drafts
    # --- loop guard -------------------------------------------------------
    "loop_n": 8,                 # n-gram width
    "loop_repeats": 2,           # repeats before the stream is cut
    # --- memory -----------------------------------------------------------
    "memory_turns": 40,          # turns kept on disk
    "memory_window": 4,          # hard cap on turns sent verbatim
    "memory_window_tokens": 300,  # verbatim window budget; the real limit
    "tidy_chars": 900,           # local trim of a rambling answer (no rewrite call)
    "memory_budget": 700,        # tokens of retrieved memory
    "layers": 1,                 # critique/rewrite passes per answer
    "think_mode": "auto",        # on | off | auto
    "viewpoint": False,          # model's own read after the answer
    "fast_mode": False,          # one call, no memory assembly
    "preply_threshold": 1200,    # chars before the rest is set aside
    # --- vision -----------------------------------------------------------
    "vision_samples": 2,         # reads behind the consistency figure
    "parallel": False,           # read several images at once
    "paint_rounds": 3,           # /paint loop length
    "vision_max_side": 1280,     # downscale target before the model sees it
    "signature_max_side": 64,    # thumbnail size when only a signature is needed
    "frames_max_side": 640,      # two frames share a 4096-token context
    "cache_min_turns": 10,       # repeat questions get a fresh answer for this many turns
    "watch_min_change": 0.005,   # grid fraction that counts as a real change
    "code_model": "qwen3.5:4b",   # coding requests only: the 2B model writes broken syntax
    "run_scripts": True,         # run generated scripts in a sandboxed folder before showing
    "main_model": "",            # prose model override, e.g. "qwen3.5:9b" (empty = model)
    "memory_limit": 0,           # 0 keeps every turn; older turns are recalled on demand
    "chunk_keep": 0,             # 0 keeps every retrieval chunk
    "memory_save_interval": 2.0, # seconds between throttled memory snapshots
    "append_rounds": 3,          # how many times a cut-off answer may be continued
    "append_tokens": 160,        # tokens per continuation call
    "append_budget": 1200,       # characters of continuation allowed per answer
    "long_limit": 6000,          # characters before continuation stops

    "ocr_model": "glm-ocr:bf16",
    "check_model": "qwen2.5:7b",  # /check auditor (text only)
    # --- long notes and long answers ---------------------------------------
    "autonote": True,            # keep durable facts from each answer
    "autonote_min_chars": 300,   # do not bother with short replies
    "long_form": False,          # answer without the three-sentence cap
    "long_max_tokens": 1200,     # reply budget while long_form is on
    "expand_rounds": 3,          # /expand continuation calls
    "expand_target_words": 400,  # stop when the answer reaches this
}

# --------------------------------------------------------------------------- #
# feature switches
# --------------------------------------------------------------------------- #
FEATURES = {
    # local TF-IDF vectors over the document store, no server support needed
    "semantic_recall": True,
    # embed store chunks with the server instead of local TF-IDF.
    # This deployment answers 501 "does not support embeddings".
    "server_embeddings": False,
    "training_export": True,
    "live_watch": True,
    "fan_out": False,
}

HOOKS = {
    "after_answer": "after_answer",   # after every answer
    "recall": "semantic_recall",      # when keyword search finds nothing
    "parallel": "parallel_workers",   # how many image reads at once
}

_warned = set()


def _warn_once(key, message):
    if key not in _warned:
        _warned.add(key)
        print("[ext] %s" % message)


def _core_module():
    """The running fast_chat module, whether imported or run as __main__."""
    import sys

    module = sys.modules.get("fast_chat")
    if module is not None and hasattr(module, "pixel_facts"):
        return module
    module = sys.modules.get("__main__")
    if module is not None and hasattr(module, "pixel_facts"):
        return module
    return None


def report():
    """/ext - what this file is currently doing."""
    print("extension: %s | %s" % (Path(__file__).name, "enabled" if ENABLED else "disabled"))
    for name in sorted(SETTINGS):
        print("  %-20s %s" % (name, SETTINGS[name]))
    for name in sorted(FEATURES):
        print("  %-20s %s" % (name, "on" if FEATURES[name] else "off"))
    print("hooks: %s" % ", ".join(sorted(HOOKS)))


# --------------------------------------------------------------------------- #
# parallelism: the measured crossover, not a guess
#   <=32 tokens  1.48x   extra workers pay off
#   <=128 tokens 1.05x   barely
#   longer       1.02x   serialise
# --------------------------------------------------------------------------- #
def parallel_workers(count, expected_tokens=110, requested=False):
    count = max(1, int(count))
    if count == 1:
        return 1
    if requested:
        return min(count, 5)
    if expected_tokens <= 32:
        return min(count, 5)
    if expected_tokens <= 128:
        return min(count, 2)
    return 1


# --------------------------------------------------------------------------- #
# post-turn hook: cheap stats, no extra model call
# --------------------------------------------------------------------------- #
def after_answer(chat, prompt, answer, intent=None):
    memory = getattr(chat, "memory", None)
    if memory is None:
        return
    try:
        text = str(answer)
        memory.log(
            "ext",
            intent=intent,
            chars=len(text),
            sentences=len([part for part in re.split(r"[.!?]+", text) if len(part.strip()) > 20]),
        )
    except Exception:  # noqa: BLE001
        pass


# --------------------------------------------------------------------------- #
# semantic recall: local TF-IDF vectors over the document store
#
# No server support required, which is why it works here: /api/embed answers
# 501 on this deployment, so embeddings would be an unusable stub. TF-IDF is
# weaker than a trained embedding but it is real, offline and fast.
# --------------------------------------------------------------------------- #
_STOP = set(
    """a an the and or but if then than that this these those of in on at to for from with
    into about as is are was were be been it its i you we they he she them us not no so do
    does did done can could should would will just very more most some any all what which
    who when where why how there here also make made get got like one two""".split()
)
_VECTOR_CACHE = {"stamp": None, "docs": [], "vectors": [], "idf": {}}


def _tokens(text):
    return [word for word in re.findall(r"[a-z0-9_]{2,}", str(text).lower()) if word not in _STOP]


def _build_vectors(chat, limit=40000):
    """TF-IDF over every indexed chunk, cached until the store size changes."""
    # keyed on the database file, not just its size: two stores with the same
    # chunk count used to share stale vectors
    try:
        stamp = (str(chat.store.path), chat.store.path.stat().st_mtime_ns)
    except OSError:
        stamp = (str(chat.store.path), 0)
    if _VECTOR_CACHE.get("stamp") == stamp and _VECTOR_CACHE["vectors"]:
        return _VECTOR_CACHE
    rows = chat.store.db.execute("SELECT path, body FROM chunks LIMIT ?", (limit,)).fetchall()
    docs = [(path, body) for path, body in rows]
    if not docs:
        _VECTOR_CACHE.update({"stamp": stamp, "docs": [], "vectors": [], "idf": {}})
        return _VECTOR_CACHE
    term_counts = []
    document_frequency = {}
    for _path, body in docs:
        counts = {}
        for token in _tokens(body):
            counts[token] = counts.get(token, 0) + 1
        term_counts.append(counts)
        for token in counts:
            document_frequency[token] = document_frequency.get(token, 0) + 1
    total = len(docs)
    idf = {token: math.log((total + 1.0) / (1.0 + freq)) + 1.0 for token, freq in document_frequency.items()}
    vectors = []
    for counts in term_counts:
        weighted = {token: (1.0 + math.log(freq)) * idf.get(token, 1.0) for token, freq in counts.items()}
        norm = math.sqrt(sum(value * value for value in weighted.values())) or 1.0
        vectors.append({token: value / norm for token, value in weighted.items()})
    _VECTOR_CACHE.update({"stamp": stamp, "docs": docs, "vectors": vectors, "idf": idf})
    return _VECTOR_CACHE


def _query_vector(query, idf):
    counts = {}
    for token in _tokens(query):
        counts[token] = counts.get(token, 0) + 1
    weighted = {token: (1.0 + math.log(freq)) * idf.get(token, 1.0) for token, freq in counts.items()}
    norm = math.sqrt(sum(value * value for value in weighted.values())) or 1.0
    return {token: value / norm for token, value in weighted.items()}


def _cosine(a, b):
    if len(a) > len(b):
        a, b = b, a
    return sum(value * b.get(token, 0.0) for token, value in a.items())


def semantic_recall(chat, query, limit=6, floor=0.12):
    """Vector search over the indexed chunks. Returns [] when nothing matches."""
    if not FEATURES["semantic_recall"]:
        return []
    try:
        index = _build_vectors(chat)
    except Exception as err:  # noqa: BLE001
        _warn_once("vectors", "vector index failed: %s" % err)
        return []
    if not index["vectors"]:
        return []
    vector = _query_vector(query, index["idf"])
    if not vector:
        return []
    scored = []
    for position, candidate in enumerate(index["vectors"]):
        score = _cosine(vector, candidate)
        if score > floor:
            scored.append((score, position))
    scored.sort(reverse=True)
    hits = []
    for score, position in scored[:limit]:
        path, body = index["docs"][position]
        hits.append({"path": "%s (vector %.2f)" % (path, score), "body": body})
    return hits


# --------------------------------------------------------------------------- #
# fine-tuning data: the only honest path from "learning" to "weights"
# --------------------------------------------------------------------------- #
def export_training(chat, argument=""):
    if not FEATURES["training_export"]:
        print("[ext] training_export is off")
        return
    raw = str(argument or "").strip().strip('"')
    module = _core_module()
    base = Path(getattr(module, "STATE", ".")) if module is not None else Path(".")
    target = Path(raw) if raw else base / "training.jsonl"
    if not target.is_absolute():
        target = base / target
    memory = getattr(chat, "memory", None)
    logged = 0
    source = getattr(memory, "log_path", None)
    if source and Path(source).exists():
        try:
            with Path(source).open("r", encoding="utf-8") as handle:
                logged = sum(1 for line in handle if '"event": "turn"' in line)
        except OSError:
            logged = 0
    seen = set()
    rows = []
    for turn in list(getattr(memory, "turns", []) or []):
        user = str(turn.get("user", "")).strip()
        answer = str(turn.get("answer", "")).strip()
        if len(answer) < 80 or not user or user in seen:
            continue
        seen.add(user)
        rows.append(
            {
                "messages": [
                    {"role": "user", "content": user},
                    {"role": "assistant", "content": answer},
                ]
            }
        )
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError as err:
        print("[ext] export failed:", err)
        return
    print("[ext] wrote %d training pair(s) to %s (from %d logged turn(s))" % (len(rows), target, logged))
    if not rows:
        print("[ext] ask a few questions first - answers under 80 chars are skipped")


# --------------------------------------------------------------------------- #
# live watch: keep looking until the screen actually changes
# --------------------------------------------------------------------------- #
def watch(chat, seconds=2.0, rounds=10, min_change=None):
    """Compare captures in memory; no PNG is written unless something changed."""
    if not FEATURES["live_watch"]:
        print("[ext] live_watch is off")
        return
    module = _core_module()
    if module is None:
        print("[ext] core module not found")
        return
    minimum = float(SETTINGS.get("watch_min_change", 0.005) if min_change is None else min_change)
    try:
        width, height, rows = module.capture_screen()
    except Exception as err:  # noqa: BLE001
        print("[ext] capture failed:", err)
        return
    previous = (width, height, rows)
    before = dict(
        module._stats_from_rows(width, height, 3, 2, b"", rows), path="frame-0", format="screen", bytes=0, decoded=True
    )
    for round_number in range(1, max(1, int(rounds)) + 1):
        time.sleep(max(0.2, float(seconds)))
        try:
            width, height, rows = module.capture_screen()
        except Exception as err:  # noqa: BLE001
            print("[ext] capture failed:", err)
            return
        after = dict(
            module._stats_from_rows(width, height, 3, 2, b"", rows),
            path="frame-%d" % round_number,
            format="screen",
            bytes=0,
            decoded=True,
        )
        change = module.frame_change(before, after) or {"fraction": 0.0, "regions": []}
        print(
            "[round %d: %.1f%% changed%s]"
            % (
                round_number,
                change["fraction"] * 100,
                " in " + ", ".join(change["regions"][:3]) if change["regions"] else "",
            )
        )
        if change["fraction"] >= minimum:
            cap = int(SETTINGS.get("frames_max_side", 640))
            payloads = []
            for w, h, r in (previous, (width, height, rows)):
                if max(w, h) > cap:
                    r = module.shrink_rows(w, h, 3, 2, b"", r, cap)
                    w, h = len(r[0]) // 3, len(r)
                payloads.append(module.base64.b64encode(module.write_png(w, h, r)).decode())
            prompt = "What changed between these two frames?\n\nMeasured: %.1f%% changed." % (
                change["fraction"] * 100
            )
            text = chat._vision_call(prompt, payloads, kind="frames") if hasattr(chat, "_vision_call") else ""
            if text:
                print(text)
            return
        previous = (width, height, rows)
        before = after
    print("[ext] %d round(s), nothing changed enough to report" % rounds)


# --------------------------------------------------------------------------- #
# several endpoints: only runs when you list providers
# --------------------------------------------------------------------------- #
def fan_out(question, providers=None, system="Answer in at most three sentences."):
    providers = providers or []
    if not FEATURES["fan_out"]:
        _warn_once("fan-out-off", "fan_out is off in FEATURES")
        return []
    if not providers:
        _warn_once("fan-out", "no providers given: fan_out(question, [{'url':..., 'model':...}])")
        return []
    try:
        import requests
    except ImportError:
        return []
    results = []
    for provider in providers:
        started = time.time()
        try:
            response = requests.post(
                provider["url"],
                json={
                    "model": provider.get("model", ""),
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": question},
                    ],
                    "stream": False,
                    "think": False,
                    "options": {"num_predict": 200, "temperature": 0.4},
                },
                timeout=180,
            )
            text = ((response.json().get("message") or {}).get("content") or "").strip()
        except Exception as err:  # noqa: BLE001
            results.append({"provider": provider.get("model", "?"), "text": "", "error": str(err)[:120]})
            continue
        results.append(
            {"provider": provider.get("model", "?"), "text": text, "ms": round((time.time() - started) * 1000)}
        )
    return results
