#!/usr/bin/env python3
"""fast_chat.py - a low-latency, non-repetitive chat client for a local Ollama-style server.

State (cache, telemetry, notes, history) lives in the project's data/ folder
next to the examples/ directory, not in the current directory, so it works
when launched from C:\\Windows\\System32. Override with FASTCHAT_HOME.
State is runtime data and stays untracked: data/ is git-ignored, so
conversation history and telemetry are never committed or pushed.

Latency techniques, tagged in the code:
  [#1]  keep-alive + pooling          - one requests.Session with an HTTPAdapter
  [#2]  streaming + TTFT              - print tokens as they arrive, time them
  [#3]  prompt-sized context          - num_ctx from the prompt, small reply budget
  [#4]  small/fast model for drafts   - FAST_MODEL for cheap work
  [#5]  parallel independent calls    - ThreadPoolExecutor (/compare)
  [#6]  local cache                   - exact hash + fuzzy near match
  [#7]  single flight                 - one model request in flight, never a queue
  [#8]  speculative draft (--draft)   - off by default: competes for the same GPU
  [#9]  no redraw                     - incremental append, no ANSI cursor games
  [#10] telemetry dataset             - JSONL per call, aggregated by /stats

Answer quality:
  [Q1] anti-repetition sampling      - repeat_penalty/top_p seedable
  [Q2] loop detection + rewrite      - a 7-gram repeated 3x triggers a fixup call
  [Q3] follow-up expansion           - "give an example" resolves against the last turn
  [Q4] rolling summary               - long conversations stay cheap and coherent
  [Q5] notes + documents             - /doc ingests a file, answers cite chunks
  [Q6] multi-call research           - /research plans, gathers, then synthesizes

Commands:
  /help  /stats  /notes  /note <text>  /doc <path>  /documents
  /research <question>   /vary <question>   /keep   /fix   /think on|off
  /temp <0-2>  /context <question>  /clear  quit
"""
import argparse
import ast
import atexit
import base64
import colorsys
import ctypes
import hashlib
import json
import math
import os
import random
import re
import shlex
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import zlib
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from pathlib import Path

try:  # fast_chat_ext.py is the adjustment file; without it nothing changes
    import fast_chat_ext as EXT
except Exception:  # noqa: BLE001
    EXT = None

try:
    import requests
except ImportError:  # --demo works without requests
    requests = None

# --------------------------------------------------------------------------- #
# one settings source: environment variable > fast_chat_ext.SETTINGS > default
# --------------------------------------------------------------------------- #
def setting(name, default, cast=str):
    env_key = name.upper()
    if env_key in os.environ:
        try:
            return cast(os.environ[env_key])
        except (TypeError, ValueError):
            return default
    if EXT is not None:
        value = getattr(EXT, "SETTINGS", {}).get(name)
        if value is not None:
            try:
                return cast(value)
            except (TypeError, ValueError):
                return default
    return default


def as_bool(name, default=False):
    env_key = name.upper()
    if env_key in os.environ:
        return os.environ[env_key].lower() not in ("0", "", "false", "off", "no")
    if EXT is not None:
        value = getattr(EXT, "SETTINGS", {}).get(name)
        if isinstance(value, bool):
            return value
        if value is not None:
            return str(value).lower() not in ("0", "", "false", "off", "no")
    return default


URL = os.environ.get("OLLAMA_URL") or setting("url", "https://quantumclaw.net/ollama/api/chat")
# main_model overrides model, so the prose model can be switched without editing code:
#   MAIN_MODEL=qwen3.5:9b  (or "main_model" in fast_chat_ext.py)
MODEL = setting("main_model", "") or setting("model", "qwen3.5:2b")
FAST_MODEL = setting("fast_model", MODEL)
KEEP_ALIVE = setting("keep_alive", "30m")
MAX_TOKENS = setting("max_tokens", 400, int)
DRAFT_TOKENS = setting("draft_tokens", 60, int)
TIMEOUT = setting("timeout", 180.0, float)
# The concurrency experiment must never hang the console: a stalled request is
# the result we are measuring, so it gets a short bound of its own.
CONCURRENCY_TIMEOUT = setting("concurrency_timeout", 45.0, float)
# One context size for every call that fits. Ollama unloads and reloads the
# model when num_ctx changes, so a short note (2048) after an answer (4096)
# made the next answer pay the reload: the 8914 ms first token in the log was
# a note's reload, not the note. A 2B model's extra KV cache is cheap.
NUM_CTX = max(2048, setting("num_ctx", 4096, int))
# Notes, plans and critiques are short and nobody waits on them: they get a
# short read timeout instead of the full answer timeout, so a stalled one
# cannot hold a lane for three minutes.
AUX_TIMEOUT = max(5.0, min(TIMEOUT, setting("aux_timeout", 45.0, float)))
# [plan] The checklist pass runs after the answer, not before it, and it is a
# luxury: one short assess call by default, and a wall-clock ceiling on the whole
# pass even when the extra appends and the thinking review are switched back on.
# 0 means no ceiling, which is the old behavior.
PLAN_BUDGET = max(0.0, setting("plan_budget", 8.0, float))
# A candidate scoring at or above this is clean enough to stop sampling. The
# usual cost of /vary and of a repetition fixup is therefore ONE call.
GOOD_ENOUGH = setting("good_enough", 4.5, float)
VARIANTS = max(1, setting("variants", 3, int))

# qwen3.5 answers inside `thinking` unless told not to: 112 chars of reasoning
# and an empty answer. Off by default, /think on to watch it work.
THINK = as_bool("think", False)
DEFAULT_DRAFT = as_bool("draft", False)

SYSTEM = (
    "Answer in at most three sentences unless asked for more. Start with the answer "
    "itself: never restate the question, never comment on the question, never repeat "
    "a sentence, no markdown fences. If the question is ambiguous, answer the most "
    "common everyday meaning first."
)

# /long swaps the three-sentence cap for a full answer. Same anti-padding rules:
# length comes from content, never from restating what was already said.
LONG_SYSTEM = (
    "Answer fully and specifically. Use as much room as the answer needs: explain the "
    "mechanism, give examples, numbers and steps, then stop. Never pad, never restate "
    "the question, never repeat a sentence, no markdown fences."
)

# [Q1] Sampling that discourages the loop you saw, where a 2B model re-emits the
# same clause forever. repeat_penalty is the one that actually stops it.
SAMPLING = {
    "temperature": setting("temperature", 0.45, float),
    "top_p": setting("top_p", 0.9, float),
    "top_k": setting("top_k", 40, int),
    "repeat_penalty": setting("repeat_penalty", 1.15, float),
    "repeat_last_n": setting("repeat_last_n", 256, int),
}


# --------------------------------------------------------------------------- #
# state location: the project's git-ignored data/ folder, never the current
# directory and never the tracked examples/ folder — conversation history and
# telemetry are private runtime data
# --------------------------------------------------------------------------- #
def state_dir():
    override = os.environ.get("FASTCHAT_HOME")
    if override:
        path = Path(override)
    else:
        path = Path(__file__).resolve().parent.parent / "data" / "fastchat"
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".write-test"
        probe.write_text("x", encoding="utf-8")
        probe.unlink()
    except OSError:
        path = Path(tempfile.gettempdir()) / "fast_chat"
        path.mkdir(parents=True, exist_ok=True)
    return path


STATE = state_dir()


def console_setup():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def now_ms():
    return time.perf_counter() * 1000.0


def percentile(values, p):
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(math.ceil(p / 100.0 * len(ordered))) - 1))
    return ordered[index]


def tokens_of(text):
    return {word for word in re.findall(r"[a-z0-9]{3,}", str(text).lower())}


META_MARKERS = (
    "as instructed",
    "conversation",
    "constraint",
    "the requested response",
    "i need to",
    "let me",
    "wait,",
    "formatting rules",
    "no i mean",
    "the user asked",
)


def score_candidate(text, question):
    """Rank a candidate answer: least repetitive, most specific, right length.

    A 2B model's failure mode is a loop, so the duplicate-6-gram rate is weighted
    heaviest; keyword overlap with the question keeps it on topic.
    """
    words = re.findall(r"[a-z0-9']+", str(text).lower())
    # a six-word answer can still be the right one; only fragments are rejected
    if len(words) < 6:
        return -1.0
    grams = [tuple(words[i: i + 6]) for i in range(len(words) - 5)]
    duplicate_rate = 1.0 - (len(set(grams)) / float(len(grams))) if grams else 0.0
    distinct = len(set(words)) / float(len(words))
    wanted = tokens_of(question)
    overlap = (len(wanted & set(words)) / float(len(wanted))) if wanted else 0.0
    length_ok = 1.0 if 60 <= len(str(text)) <= 900 else 0.4
    # Meta-commentary scores well on "different" but is not an answer: a rewrite
    # that says "as instructed, here are five copies" must lose to a real reply.
    lowered = str(text).lower()
    meta_penalty = min(6.0, 1.8 * sum(1 for marker in META_MARKERS if marker in lowered))
    return ((1.0 - duplicate_rate) * 3.0) + distinct + (overlap * 0.6) + length_ok - meta_penalty


def dedupe_candidates(ranked, threshold=0.72):
    """Drop candidates that say the same thing as a better-scoring one.

    Without this, /vary showed three lines where two were the same answer with a
    different opening clause, which is the "only 2 different" problem.
    """
    kept = []
    for score, text in ranked:
        lowered = text.lower()
        if any(SequenceMatcher(None, lowered, other.lower()).ratio() > threshold for _, other in kept):
            continue
        kept.append((score, text))
    return kept


def variation_stats(answers, threshold=0.72):
    """How different repeated answers really are.

    `distinct` only counts replies a reader would call different, so "7
    variations" means seven answers, not seven strings with a new opening clause.
    """
    texts = [str(answer).strip() for answer in answers if str(answer).strip()]
    if not texts:
        return {"answers": 0, "distinct": 0, "mean": 0.0, "min": 0.0, "max": 0.0, "chars": 0, "words": 0}
    ratios = []
    for index, left in enumerate(texts):
        for right in texts[index + 1:]:
            ratios.append(SequenceMatcher(None, left.lower(), right.lower()).ratio())
    kept = []
    for text in texts:
        if all(SequenceMatcher(None, text.lower(), other.lower()).ratio() <= threshold for other in kept):
            kept.append(text)
    words = [len(text.split()) for text in texts]
    return {
        "answers": len(texts),
        "distinct": len(kept),
        "mean": (sum(ratios) / len(ratios)) if ratios else 0.0,
        "min": min(ratios) if ratios else 0.0,
        "max": max(ratios) if ratios else 0.0,
        "chars": int(sum(len(text) for text in texts) / len(texts)),
        "words": int(sum(words) / len(words)),
    }


def split_candidates(text, limit=3):
    """Pull numbered or blank-line-separated candidate answers out of one reply."""
    parts = re.split(r"(?m)^\s*(?:\d+[.)]|[-*])\s+", str(text))
    parts = [part.strip() for part in parts if len(part.strip()) > 20]
    if len(parts) < 2:
        parts = [part.strip() for part in re.split(r"\n{2,}", str(text).strip()) if len(part.strip()) > 20]
    return parts[:limit]


class DegenerateOutput(Exception):
    """The model started repeating itself and the stream was cut short."""


# --------------------------------------------------------------------------- #
# [Q2] loop detector
# --------------------------------------------------------------------------- #
class LoopGuard:
    def __init__(self, n=None, repeats=None):
        n = setting("loop_n", 8, int) if n is None else n
        repeats = setting("loop_repeats", 2, int) if repeats is None else repeats
        self.n = n
        self.repeats = repeats
        self.words = []
        self.seen = {}

    def feed(self, piece):
        found = re.findall(r"[a-z0-9']+", piece.lower())
        if not found:
            return False
        self.words.extend(found)
        del self.words[:-400]
        if len(self.words) < self.n:
            return False
        gram = tuple(self.words[-self.n:])
        self.seen[gram] = self.seen.get(gram, 0) + 1
        return self.seen[gram] >= self.repeats


# --------------------------------------------------------------------------- #
# output: append only, so a console without VT support cannot smear the line
# --------------------------------------------------------------------------- #
class Writer:
    def __init__(self, stream=None):
        self.stream = stream or sys.stdout
        self.open_line = False

    def start(self, prefix):
        self.stream.write(prefix)
        self.stream.flush()
        self.open_line = True

    def write(self, text):
        if not text:
            return
        self.stream.write(text)
        self.stream.flush()

    def end(self):
        if self.open_line:
            self.stream.write("\n")
            self.stream.flush()
            self.open_line = False

    def status(self, text):
        if self.open_line:
            self.stream.write("\n")
            self.open_line = False
        self.stream.write(text + "\n")
        self.stream.flush()

    def answer(self, text):
        self.start("AI: ")
        self.write(text)
        self.end()


# --------------------------------------------------------------------------- #
# [#10] telemetry
# --------------------------------------------------------------------------- #
def rotate_jsonl(path, max_bytes=4_000_000, keep_lines=20000):
    """Trim an append-only JSONL file instead of letting it grow forever."""
    path = Path(path)
    try:
        if not path.exists() or path.stat().st_size <= max_bytes:
            return 0
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-keep_lines:]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return len(lines)
    except OSError:
        return 0


# Background note/summary calls and the reader share these files.
_WRITE_LOCK = threading.Lock()


class Telemetry:
    def __init__(self, path):
        self.path = path

    def record(self, **fields):
        row = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "t": round(time.time(), 3)}
        row.update({k: v for k, v in fields.items() if v is not None})
        with _WRITE_LOCK:
            try:
                with open(self.path, "a", encoding="utf-8") as handle:
                    handle.write(json.dumps(row) + "\n")
            except OSError as err:
                print("telemetry write failed:", err)
            rotate_jsonl(self.path)

    @staticmethod
    def load(path):
        rows = []
        try:
            with open(path, "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if line:
                        try:
                            rows.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
        except OSError:
            pass
        return rows


def print_stats(path):
    rows = Telemetry.load(path)
    if not rows:
        print("No telemetry yet. Run a few turns first.")
        return
    streams = [r for r in rows if r.get("kind") == "stream"]
    answers = [r for r in rows if r.get("kind") == "answer"]
    hits = [r for r in answers if r.get("cache_score") is not None]
    rewrites = [r for r in rows if r.get("kind") == "rewrite"]

    def block(label, items):
        ttft = [r["ttft_ms"] for r in items if r.get("ttft_ms") is not None]
        total = [r["ms"] for r in items if r.get("ms") is not None]
        tps = [r["tps"] for r in items if r.get("tps") is not None]
        rate = "%5.1f" % percentile(tps, 50) if tps else "  n/a"
        print(
            "%-22s calls %3d | ttft p50 %7.1f ms | total p50 %8.1f ms | tok/s p50 %s"
            % (label, len(items), percentile(ttft, 50), percentile(total, 50), rate)
        )

    print("\n=== telemetry dataset (%s) ===" % path)
    by_model = {}
    for row in streams:
        by_model.setdefault(row.get("model", "?"), []).append(row)
    for model, items in sorted(by_model.items()):
        block("model " + model, items)
    block("all streams", streams)
    if answers:
        print("cache hits        %3d / %d answers" % (len(hits), len(answers)))
    if rewrites:
        print("rewritten answers %3d (repetition caught and fixed)" % len(rewrites))
    merged = [r for r in rows if r.get("kind") == "coalesced"]
    if merged:
        print("coalesced calls   %3d (identical concurrent work shared one request)" % len(merged))
    drafts = [r for r in rows if r.get("kind") == "draft"]
    if drafts:
        print("speculative drafts %3d dispatched" % len(drafts))
    gaps = [r["max_gap_ms"] for r in streams if r.get("max_gap_ms") is not None]
    if gaps:
        p50_ttft = percentile([r["ttft_ms"] for r in streams if r.get("ttft_ms") is not None], 50)
        p50_total = percentile([r["ms"] for r in streams if r.get("ms") is not None], 50)
        if percentile(gaps, 95) < 5 and p50_total > 0 and p50_ttft >= 0.8 * p50_total:
            print(
                "streaming delivered nothing early: the endpoint sent each reply in one burst\n"
                "(ttft %.0f ms of a %.0f ms total). Fix that server-side first."
                % (p50_ttft, p50_total)
            )
        else:
            print("longest inter-token gap p95 %.1f ms" % percentile(gaps, 95))
    for row in rows[-6:]:
        print("  ", json.dumps(row))
    print()


# --------------------------------------------------------------------------- #
# [#6] cache
# --------------------------------------------------------------------------- #
class AnswerCache:
    def __init__(self, path, ttl=6 * 3600.0, fuzzy=0.86, limit=200):
        self.path = path
        self.ttl = ttl
        self.fuzzy = fuzzy
        self.limit = limit
        self.entries = {}
        self.load()

    @staticmethod
    def normalize(text):
        return re.sub(r"[^a-z0-9 ]+", " ", str(text).lower()).split()

    def _key(self, prompt):
        return hashlib.sha1(" ".join(self.normalize(prompt)).encode("utf-8")).hexdigest()

    def load(self):
        try:
            data = json.loads(Path(self.path).read_text(encoding="utf-8"))
            if isinstance(data, dict):
                self.entries = data
        except (OSError, json.JSONDecodeError):
            pass

    def save(self):
        try:
            trimmed = sorted(self.entries.items(), key=lambda kv: kv[1].get("at", 0))[-self.limit: ]
            Path(self.path).write_text(json.dumps(dict(trimmed)), encoding="utf-8")
        except OSError as err:
            print("cache save failed:", err)

    @staticmethod
    def too_recent(entry, turn, min_gap):
        """A cached answer must age min_gap turns before it is served again."""
        if not min_gap or turn is None:
            return False
        stored = entry.get("turn")
        if stored is None:
            return False
        return (turn - stored) < min_gap

    def recent(self, prompt):
        """The last answer to this exact question, even if too fresh to serve."""
        entry = self.entries.get(self._key(prompt))
        return entry.get("answer") if entry else None

    def poison(self, prompt):
        """Mark an answer as bad so the cache never replays it."""
        entry = self.entries.get(self._key(prompt))
        if not entry:
            return False
        entry["reward"] = 0.0
        entry["poisoned"] = True
        self.save()
        return True

    def promote(self, prompt):
        """Mark an answer as good: keep it eligible even after the cooldown."""
        entry = self.entries.get(self._key(prompt))
        if not entry:
            return False
        entry["reward"] = max(float(entry.get("reward") or 0.0), 0.9)
        entry["poisoned"] = False
        self.save()
        return True

    @staticmethod
    def low_reward(entry):
        """An answer that scored or was rated badly must not be replayed."""
        reward = entry.get("reward")
        return isinstance(reward, (int, float)) and reward < 0.45

    def get(self, prompt, turn=None, min_gap=0):
        cutoff = time.time() - self.ttl
        exact = self.entries.get(self._key(prompt))
        if exact and exact.get("at", 0) >= cutoff:
            if self.too_recent(exact, turn, min_gap) or self.low_reward(exact):
                return None
            return exact["answer"], 1.0
        words = set(self.normalize(prompt))
        best, best_score = None, 0.0
        for entry in self.entries.values():
            if entry.get("at", 0) < cutoff or self.too_recent(entry, turn, min_gap) or self.low_reward(entry):
                continue
            other = set(self.normalize(entry["prompt"]))
            if not words or not other:
                continue
            overlap = len(words & other) / float(len(words | other))
            if overlap < 0.5:
                continue
            ratio = SequenceMatcher(None, " ".join(sorted(words)), " ".join(sorted(other))).ratio()
            score = 0.5 * overlap + 0.5 * ratio
            if score > best_score:
                best, best_score = entry, score
        if best and best_score >= self.fuzzy:
            return best["answer"], best_score
        return None

    def put(self, prompt, answer, model, speculative=False, turn=None, reward=None):
        self.entries[self._key(prompt)] = {
            "prompt": prompt,
            "answer": answer,
            "model": model,
            "turn": turn,
            "reward": reward,
            "at": time.time(),
            "speculative": speculative,
        }
        if len(self.entries) > self.limit:
            oldest = sorted(self.entries.items(), key=lambda kv: kv[1].get("at", 0))
            for key, _ in oldest[: len(self.entries) - self.limit]:
                self.entries.pop(key, None)
        self.save()


# --------------------------------------------------------------------------- #
# [Q5] notes and documents
# --------------------------------------------------------------------------- #
class Notes:
    def __init__(self, path, limit=400):
        self.path = path
        self.limit = limit
        self.items = []
        self.load()

    def load(self):
        try:
            data = json.loads(Path(self.path).read_text(encoding="utf-8"))
            if isinstance(data, list):
                self.items = data
        except (OSError, json.JSONDecodeError):
            pass

    def save(self):
        try:
            Path(self.path).write_text(json.dumps(self.items), encoding="utf-8")
        except OSError as err:
            print("notes save failed:", err)

    def add(self, kind, title, text, tags=""):
        body = str(text).strip()
        if not body:
            return None
        item = {
            "id": hashlib.sha1((title + body).encode("utf-8")).hexdigest()[:10],
            "at": time.time(),
            "kind": kind,
            "title": str(title)[:120],
            "text": body[:4000],
            "tags": tags,
        }
        with _WRITE_LOCK:
            self.items.append(item)
            self.items = self.items[-self.limit:]
            self.save()
        return item

    def search(self, query, limit=4, kinds=None):
        wanted = tokens_of(query)
        if not wanted:
            return []
        scored = []
        for item in self.items:
            if kinds and item.get("kind") not in kinds:
                continue
            body = tokens_of(item.get("title", "") + " " + item.get("text", ""))
            if not body:
                continue
            overlap = len(wanted & body) / float(len(wanted))
            if overlap <= 0:
                continue
            scored.append((overlap, item))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [item for _, item in scored[:limit]]

    def documents(self):
        return [item for item in self.items if item.get("kind") == "doc"]


def chunk_text(text, size=1100, overlap=150):
    flat = re.sub(r"\s+", " ", str(text)).strip()
    if not flat:
        return []
    chunks, start = [], 0
    while start < len(flat):
        end = min(len(flat), start + size)
        chunks.append(flat[start:end])
        if end >= len(flat):
            break
        start = end - overlap
    return chunks


# --------------------------------------------------------------------------- #
# [#11] lanes: interactive work never queues behind background work
# --------------------------------------------------------------------------- #
# How long interactive work waits for a running background call before it takes
# the lane anyway. Bounded so an autonote or summary cannot delay an answer.
DEFAULT_DRAIN = 0.25


class Lanes:
    """Priority scheduling for one GPU.

    A single GPU cannot answer two requests faster than one, so raw parallelism
    buys nothing: what actually helps is that background work (a summary, a
    draft, a prefetch) must never sit in front of the answer you are waiting
    for. Interactive calls wait for the background lane only up to `drain`, and
    background calls only start when nothing has been asked for a moment.
    """

    def __init__(self, interactive=1, background=2, grace_s=0.4):
        self.cond = threading.Condition()
        self.max_interactive = max(1, int(interactive))
        self.max_background = max(1, int(background))
        self.grace = max(0.0, float(grace_s))
        self.active_interactive = 0
        self.active_background = 0
        self.waiting_interactive = 0
        self.last_interactive_end = 0.0

    def _wait(self, deadline):
        remaining = None if deadline is None else deadline - time.time()
        if remaining is not None and remaining <= 0:
            return False
        self.cond.wait(remaining)
        return True

    def acquire(self, priority="interactive", timeout=None, drain=DEFAULT_DRAIN):
        """Take a lane.

        `drain` bounds how long interactive work waits for background work: an
        autonote or summary that is already generating must not sit in front of
        the answer the user is waiting for. When the drain window closes the
        interactive call takes the lane anyway; drain=None waits it out.
        """
        # Guard: a negative or non-numeric drain must not spin the wait loop or
        # raise in the middle of a request, so it falls back to the default.
        if drain is not None:
            try:
                drain = max(0.0, float(drain))
            except (TypeError, ValueError):
                drain = DEFAULT_DRAIN
        deadline = None if timeout is None else time.time() + timeout
        drain_by = None if drain is None else time.time() + drain
        if deadline is not None and drain_by is not None:
            # The drain window can never outlive the caller's own deadline.
            drain_by = min(drain_by, deadline)
        with self.cond:
            if priority == "interactive":
                self.waiting_interactive += 1
                try:
                    while self.active_interactive >= self.max_interactive or (
                        self.active_background > 0 and (drain_by is None or time.time() < drain_by)
                    ):
                        if self.active_interactive >= self.max_interactive:
                            if not self._wait(deadline):
                                return False
                            continue
                        # Only background stands in the way: wait until the drain
                        # window closes, bounded by the caller's own deadline.
                        target = drain_by
                        if deadline is not None:
                            target = deadline if target is None else min(target, deadline)
                        if not self._wait(target) and deadline is not None and time.time() >= deadline:
                            return False
                    self.active_interactive += 1
                    return True
                finally:
                    self.waiting_interactive -= 1
                    self.cond.notify_all()
            while True:
                now = time.time()
                busy = (
                    self.active_interactive > 0
                    or self.waiting_interactive > 0
                    or self.active_background >= self.max_background
                    or (now - self.last_interactive_end) < self.grace
                )
                if not busy:
                    self.active_background += 1
                    return True
                if deadline is not None and now >= deadline:
                    return False
                # Wake at the earlier of the grace expiring and the deadline;
                # waiting for the full deadline would stall a background call.
                wake = self.last_interactive_end + self.grace
                if deadline is not None:
                    wake = min(wake, deadline)
                self.cond.wait(max(0.01, wake - now))

    def release(self, priority="interactive"):
        with self.cond:
            if priority == "interactive":
                self.active_interactive = max(0, self.active_interactive - 1)
                self.last_interactive_end = time.time()
            else:
                self.active_background = max(0, self.active_background - 1)
            self.cond.notify_all()

    def state(self):
        return "interactive %d/%d, background %d/%d, waiting %d" % (
            self.active_interactive,
            self.max_interactive,
            self.active_background,
            self.max_background,
            self.waiting_interactive,
        )


# --------------------------------------------------------------------------- #
# [#1][#2][#3][#4] transport
# --------------------------------------------------------------------------- #
class Client:
    def __init__(self, url=URL, telemetry=None, demo=False):
        self.url = url
        self.telemetry = telemetry
        self.demo = demo
        # Model requests made by this client. --demo prints the count per turn so
        # the plan pass can be measured instead of guessed at.
        self.calls = 0
        self.sampling = dict(SAMPLING)
        self.lanes = Lanes()  # [#7][#11]
        self.shared = {}
        self.shared_results = {}
        self.shared_lock = threading.Lock()
        self.session = None
        if not demo and requests is not None:
            self.session = requests.Session()
            adapter = requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=8, max_retries=0)
            self.session.mount("https://", adapter)
            self.session.mount("http://", adapter)
            self.session.headers.update({"Content-Type": "application/json", "Connection": "keep-alive"})

    def _body(self, messages, model, max_tokens, stream, sampling, think=None):
        options = {
            "num_predict": max_tokens,  # [#3]
            "num_ctx": ctx_for(messages),  # [#3]
            "keep_alive": KEEP_ALIVE,
        }
        options.update(sampling or self.sampling)
        body = {"model": model, "messages": messages, "stream": stream, "keep_alive": KEEP_ALIVE, "options": options}
        # qwen3.5 otherwise answers only inside `thinking`, so it is forced off
        # unless a reasoning pass explicitly asks for it.
        body["think"] = bool(THINK if think is None else think)
        return body

    def stream(self, messages, model=MODEL, max_tokens=MAX_TOKENS, sampling=None, on_token=None, kind="stream", on_thinking=None, guard=None, think=None, read_timeout=None, stop_when_answered=False):
        result = {
            "text": "",
            "ttft_ms": None,
            "total_ms": None,
            "chunks": 0,
            "max_gap_ms": 0.0,
            "model": model,
            "thinking_chunks": 0,
            "thinking_chars": 0,
        }
        started = now_ms()
        last = started
        self.calls += 1
        iterator = (
            self._demo_chunks(messages)
            if self.demo
            else self._http_chunks(messages, model, max_tokens, sampling, think, read_timeout)
        )
        try:
            for item in iterator:
                channel, piece = item if isinstance(item, tuple) else ("content", item)
                if channel != "content":
                    result["thinking_chunks"] += 1
                    result["thinking_chars"] += len(piece)
                    if on_thinking:
                        on_thinking(piece, result)
                    continue
                stamp = now_ms()
                if result["ttft_ms"] is None:
                    result["ttft_ms"] = stamp - started
                elif result["chunks"]:
                    result["max_gap_ms"] = max(result["max_gap_ms"], stamp - last)
                last = stamp
                result["chunks"] += 1
                result["text"] += piece
                # A reasoning pass wants only the thinking channel. Once the answer
                # text starts, the rest of this generation is discarded, so stop
                # reading instead of paying for tokens nobody will see.
                if stop_when_answered and result["thinking_chunks"]:
                    break
                if on_token:
                    on_token(piece, result)
                if guard is not None and guard.feed(piece):
                    raise DegenerateOutput(result["text"])
        finally:
            close = getattr(iterator, "close", None)
            if close:
                close()
        result["total_ms"] = now_ms() - started
        if result["ttft_ms"] is None:
            result["ttft_ms"] = result["total_ms"]
        decode_s = max(0.0, (result["total_ms"] - result["ttft_ms"]) / 1000.0)
        est = max(1.0, len(result["text"]) / 4.0)
        result["tps"] = round(est / decode_s, 1) if decode_s >= 0.05 else None
        if self.telemetry:
            self.telemetry.record(
                kind=kind,
                model=model,
                ms=round(result["total_ms"], 1),
                ttft_ms=round(result["ttft_ms"], 1),
                chunks=result["chunks"],
                max_gap_ms=round(result["max_gap_ms"], 1),
                tps=result["tps"],
                chars=len(result["text"]),
                thinking_chars=result["thinking_chars"] or None,
                prompt_chars=sum(len(m.get("content", "")) for m in messages),
            )
        return result

    def _http_chunks(self, messages, model, max_tokens, sampling, think=None, read_timeout=None):
        if self.session is None:
            raise RuntimeError("requests is not installed; install it or use --demo")
        last_error = "request failed"
        attempts = [
            {"think": think, "suffix": None},
            {"think": False, "suffix": "Answer with only the final answer. No reasoning."},
        ]
        for attempt in attempts:
            # The second attempt used the caller's `think` too, so a reasoning
            # pass that returned no answer retried with reasoning enabled.
            body = self._body(messages, model, max_tokens, True, sampling, attempt["think"])
            if attempt["suffix"]:
                body["messages"] = list(messages) + [{"role": "system", "content": attempt["suffix"]}]
            answered = 0
            try:
                with self.session.post(self.url, json=body, stream=True, timeout=(10, read_timeout or TIMEOUT)) as response:
                    if response.status_code >= 400:
                        # Keep the server's own words: "exceeds the available context
                        # size" is the only way callers can react sensibly.
                        detail = (response.text or "")[:300].replace("\n", " ").strip()
                        last_error = detail or ("HTTP %d" % response.status_code)
                        # Re-sending the same body (plus one more message, which
                        # made an over-long prompt longer) could never succeed:
                        # Chat.ask is the one that shrinks the context.
                        raise RuntimeError(last_error)
                    response.raise_for_status()
                    for chunk in response.iter_lines(decode_unicode=True):
                        if chunk is None:
                            continue
                        # urllib3 only decodes when the server declares a charset;
                        # this endpoint sends NDJSON with no charset, so bytes.
                        line = chunk.decode("utf-8", "replace") if isinstance(chunk, bytes) else chunk
                        line = line.strip()
                        if not line:
                            continue
                        if line.startswith("data:"):
                            line = line[5:].strip()
                        if not line:
                            continue
                        if line == "[DONE]":
                            break
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        message = data.get("message") or {}
                        reasoning = message.get("thinking") or data.get("thinking") or ""
                        if reasoning:
                            yield ("thinking", reasoning)
                        piece = (
                            ((data.get("choices") or [{}])[0].get("delta") or {}).get("content")
                            or message.get("content")
                            or data.get("response")
                            or ""
                        )
                        if piece:
                            answered += len(piece)
                            yield ("content", piece)
                    if not answered and not think:
                        last_error = "reasoning only; retrying with an explicit answer instruction"
                        continue
                return
            except DegenerateOutput:
                raise
            except Exception as err:  # noqa: BLE001 - surfaced to the caller
                last_error = str(err)
                # A timeout is not fixed by sending the identical request again:
                # that paid the full read timeout twice (2 x 180 s) and is what
                # turned one slow answer into minutes. A transient 5xx still gets
                # its one retry.
                if attempt["suffix"] or is_timeout(err):
                    raise RuntimeError(last_error)
        raise RuntimeError(last_error)

    def _demo_chunks(self, messages):
        systems = " ".join(
            str(message.get("content", "")) for message in messages if message.get("role") == "system"
        )
        if "COVERED or MISSING" in systems:
            yield (
                "content",
                "1. where the heat comes from COVERED\n"
                "2. why moving heat is efficient MISSING\n"
                "3. how it performs in winter MISSING",
            )
            return
        seed = str(messages[-1].get("content", ""))[:40]
        if "plan" in seed.lower() or "sub-question" in seed.lower():
            yield ("content", '{"questions": ["What is it made of?", "Where does it come from?", "Why does it matter?"]}')
            return
        time.sleep(0.05)
        speech = (
            "A draft answer that arrives in pieces so the client can render it "
            "before the whole reply exists, which is the entire point of streaming."
        )
        if "summar" in seed.lower():
            speech = "The user asked about gemstones, then about France; both were answered briefly."
        for index in range(0, len(speech), 8):
            time.sleep(0.01)
            yield ("content", speech[index: index + 8])

    def ask(self, messages, model=MODEL, max_tokens=MAX_TOKENS, sampling=None, on_token=None, kind="stream", on_thinking=None, guard=None, think=None, priority="interactive", stop_when_answered=False, read_timeout=None):
        if not self.lanes.acquire(priority, timeout=TIMEOUT):
            raise RuntimeError("another request never finished")
        try:
            return self.stream(
                messages,
                model=model,
                max_tokens=max_tokens,
                sampling=sampling,
                on_token=on_token,
                kind=kind,
                on_thinking=on_thinking,
                guard=guard,
                think=think,
                stop_when_answered=stop_when_answered,
                read_timeout=read_timeout,
            )
        finally:
            self.lanes.release(priority)

    def complete(self, messages, model=MODEL, max_tokens=MAX_TOKENS, sampling=None, kind="aux", priority="background", read_timeout=None):
        # [#12] Identical concurrent aux calls share one request. Research and
        # summary prompts repeat often enough for this to matter.
        key = hashlib.sha1(
            json.dumps([model, max_tokens, sampling or self.sampling, messages], sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
        with self.shared_lock:
            event = self.shared.get(key)
            owner = event is None
            if owner:
                event = threading.Event()
                self.shared[key] = event
        if not owner:
            event.wait(AUX_TIMEOUT)
            with self.shared_lock:
                shared = self.shared_results.get(key, "")
            if self.telemetry:
                self.telemetry.record(kind="coalesced", model=model, chars=len(shared))
            return shared
        text = ""
        try:
            text = self.ask(
                messages,
                model=model,
                max_tokens=max_tokens,
                sampling=sampling,
                kind=kind,
                priority=priority,
                read_timeout=read_timeout if read_timeout is not None else (AUX_TIMEOUT if priority == "background" else None),
            )["text"].strip()
            return text
        finally:
            with self.shared_lock:
                self.shared_results[key] = text
                self.shared.pop(key, None)
                if len(self.shared_results) > 200:
                    self.shared_results.clear()
            event.set()


def is_timeout(err):
    """Whether a request failure was a timeout, which a retry only doubles."""
    return "timeout" in type(err).__name__.lower() or "timed out" in str(err).lower()


def ctx_for(messages):
    """Context size to request: one floor, then only grow when a prompt needs it."""
    approx = sum(len(m.get("content", "")) for m in messages) // 4 + 256
    if approx <= NUM_CTX:
        return NUM_CTX
    for size in (8192, 16384):
        if approx <= size:
            return size
    return 16384


# --------------------------------------------------------------------------- #
# conversation
# --------------------------------------------------------------------------- #
FOLLOWUPS = (
    "example", "examples", "why", "how so", "more", "again", "expand", "explain",
    "that", "it", "this", "next", "and", "go on", "continue", "simpler",
    "shorter", "longer", "detail", "details", "elaborate", "summarize",
)


# --------------------------------------------------------------------------- #
# memory: text -> sentences -> token-bounded chunks -> retrievable turns
# --------------------------------------------------------------------------- #
STOPWORDS = set(
    """a an the and or but if then than that this these those of in on at to for from with
    without into over under about as is are was were be been being it its i you we they he
    she them us my your our their not no so do does did done can could should would will just
    very more most some any all what which who whom when where why how there here also make
    made get got like one two""".split()
)
MEMORY_BUDGET = setting("memory_budget", 700, int)


def content_words(text):
    found = re.findall(r"[a-z0-9']{3,}", str(text).lower())
    return {word for word in found if word not in STOPWORDS}


def token_count(text):
    """Rough token count for budgeting: ~4 chars per token, never zero."""
    return max(1, len(str(text)) // 4)


def trim_to_tokens(text, tokens):
    """Cut text to about `tokens`, backing off to a sentence boundary."""
    limit = max(1, int(tokens)) * 4
    text = str(text)
    if len(text) <= limit:
        return text
    cut = text[:limit]
    boundary = max(cut.rfind(". "), cut.rfind("\n"))
    return cut[: boundary + 1] if boundary > 40 else cut


def tidy_answer(text, limit_chars=900):
    """Bound a rambling answer locally, so fixing it costs no second model call."""
    body = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(body) <= limit_chars:
        return body
    head = body[:limit_chars]
    boundary = max(head.rfind(". "), head.rfind("! "), head.rfind("? "))
    if boundary > 200:
        return head[: boundary + 1]
    return head.rsplit(" ", 1)[0].rstrip(",;:") + "."


def image_size(payload):
    """(width, height) from a base64 image header, or None."""
    try:
        raw = base64.b64decode(str(payload)[:4096])
    except (ValueError, TypeError):
        return None
    return png_size(raw) if raw[:8] == b"\x89PNG\r\n\x1a\n" else jpeg_size(raw)


def image_tokens(payload, per_megapixel=1000):
    """Vision tokens for a base64 image, read from its header.

    1000 per megapixel matches this server: two 1920x1080 frames measured 4100
    tokens with a short question.
    """
    size = image_size(payload)
    if not size:
        return 700
    return int(size[0] * size[1] / 1e6 * per_megapixel) + 16


def shrink_payload(payload, factor):
    """Re-encode a PNG payload smaller by factor; other formats pass through."""
    try:
        raw = base64.b64decode(payload)
    except (ValueError, TypeError):
        return payload
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        try:
            width, height, channels, colour_type, palette, rows = png_pixels(raw)
        except Exception:  # noqa: BLE001 - unreadable PNG: better to send it than to fail
            return payload
        side = max(128, int(max(width, height) * max(0.2, min(1.0, factor))))
        if side >= max(width, height):
            return payload
        out = shrink_rows(width, height, channels, colour_type, palette, rows, side)
        return base64.b64encode(write_png(len(out[0]) // 3, len(out), out)).decode()
    size = jpeg_size(raw) if raw[:2] == b"\xff\xd8" else None
    if not size:
        return payload
    side = max(128, int(max(size) * max(0.2, min(1.0, factor))))
    if side >= max(size):
        return payload
    # GDI+ reads files, so the payload makes one round trip through a temp file.
    handle = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    try:
        handle.write(raw)
        handle.close()
        thumb = gdiplus_thumbnail(Path(handle.name), side)
        if not thumb:
            return payload
        width, height, rows, _original = thumb
        return base64.b64encode(write_png(width, height, rows)).decode()
    finally:
        try:
            os.unlink(handle.name)
        except OSError:
            pass


def fit_images(images, budget, max_tokens=400):
    """Shrink images until their tokens fit the budget. One shrink path, used
    both for the first attempt and for every retry."""
    images = list(images)
    for _ in range(3):
        used = sum(image_tokens(payload) for payload in images) + int(max_tokens)
        if used <= budget:
            break
        factor = math.sqrt(max(0.2, (budget - int(max_tokens)) / float(used)))
        images = [shrink_payload(payload, factor) for payload in images]
    return images


def message_tokens(message):
    """Text plus any images: a vision turn costs far more than its words."""
    total = token_count(message.get("content", ""))
    for payload in message.get("images") or []:
        total += image_tokens(payload)
    return total


def fit_messages(messages, budget_tokens=3000, force_drop=0, verbose=False):
    """Shed the oldest turns until the request fits the model's context.

    The system message and the current question never go: only the verbatim
    window in the middle, oldest first. Returns a new list; the caller is told
    when turns were dropped so silent context loss stays visible.
    """
    budget = max(400, int(budget_tokens))
    trimmed = [dict(item) for item in messages]

    def size():
        return sum(message_tokens(message) for message in trimmed)

    dropped = 0
    while len(trimmed) > 2 and (dropped < int(force_drop) or size() > budget):
        del trimmed[1]
        dropped += 1
    if trimmed and size() > budget:
        trimmed[0] = dict(trimmed[0])
        head = str(trimmed[0].get("content", ""))
        trimmed[0]["content"] = head[: max(0, len(head) - (size() - budget) * 4)]
    if dropped and verbose:
        print("[context: dropped %d old turn(s) to fit %d tokens]" % (dropped, budget))
    return trimmed


LIST_MARKERS = (
    "list ",
    "list,",
    "name as many",
    "as many as",
    "enumerate",
    "examples of",
    "give me examples",
    "bullet",
    "every one of",
)


CODE_FOLLOWUPS = (
    "improve",
    "add ",
    "fix",
    "change",
    "refactor",
    "modify",
    "update",
    "extend",
    "bug",
    "error",
    "make it",
    "keep going",
    "continue with",
)


def code_followup(prompt):
    """True when the turn is asking to change code that already exists."""
    low = str(prompt or "").lower()
    return any(marker in low for marker in CODE_FOLLOWUPS)


def extract_code(text):
    """Fenced blocks if present, otherwise the lines that look like code."""
    body = str(text or "")
    blocks = re.findall(r"```[a-zA-Z0-9_+-]*\s*\n(.*?)```", body, re.S)
    if blocks:
        return [block.strip() for block in blocks if block.strip()]
    lines = [
        line
        for line in body.splitlines()
        if re.match(
            r"\s*(import |from |def |class |return |print\(|for |while |if |elif |else:|@|[A-Za-z_]\w*\s*=)", line
        )
    ]
    if len(lines) >= 4:
        return ["\n".join(lines)]
    # a one-liner is still code when it starts like a definition or import
    stripped = body.strip()
    if lines and len(stripped.splitlines()) <= 3 and re.match(r"(def |class |import |from |return |print\()", stripped):
        return [stripped]
    return []


def score_answer(text, question, context="", seen=None):
    """Reward an answer: fresh wording, grounded in context, not rambling."""
    body = str(text or "")
    sentences = sentences_of(body) or ([body] if body.strip() else [])
    words = re.findall(r"[a-z0-9']+", body.lower())
    seen = seen or []
    fresh = novelty(body, seen) if seen and body.strip() else 1.0
    ctx = set(re.findall(r"[a-z0-9']+", str(context).lower()))
    if ctx:
        grounded = sum(
            1 for sentence in sentences if ctx & set(re.findall(r"[a-z0-9']+", sentence.lower()))
        ) / float(max(1, len(sentences)))
    else:
        grounded = 0.5  # nothing to ground against: neutral, not a reward
    six = [tuple(words[i : i + 6]) for i in range(max(0, len(words) - 5))]
    loop = 1.0 - (len(six) - len(set(six))) / float(len(six)) if six else 1.0
    clean = loop * (0.5 if rambles(body) else 1.0)
    total = round(0.4 * fresh + 0.3 * grounded + 0.3 * clean, 3)
    return {"total": total, "novelty": round(fresh, 3), "grounded": round(grounded, 3), "clean": round(clean, 3)}


# "code" and "script" mean the same thing here; so do program, snippet and macro.
CODE_NOUNS = (
    "code", "script", "program", "snippet", "macro", "cli", "app", "calc", "calculator",
    "function", "class", "bot", "tool", "page", "site", "game",
)
CODE_VERBS = (
    "write", "give", "make", "create", "build", "implement", "generate", "fix", "refactor",
    "rewrite", "improve", "update", "modify", "change", "extend", "optimize", "secure",
    "complete", "debug", "add", "need", "want", "show",
)
# A question about code wants prose, not a script.
CODE_QUESTIONS = ("what is", "what are", "what does", "what's", "explain", "why ", "how does", "how do", "difference between", "meaning of")


def wants_code(prompt):
    low = str(prompt or "").lower().strip()
    if any(marker in low for marker in CODE_QUESTIONS):
        return False
    if not any(noun in low for noun in CODE_NOUNS):
        return False
    if any(noun in low for noun in ("script", "snippet", "program")):
        return True
    return any(verb in low.split()[:7] for verb in CODE_VERBS)



CODE_LINE = re.compile(
    r"\s*(def |class |import |from |return |print\(|for |while |if |elif |else:|[A-Za-z_]\w*\s*=)"
)


def has_code_block(text):
    """Real code: a fence, or even one line that opens like a statement."""
    body = str(text or "")
    if "```" in body:
        return True
    if any(re.match(r"\s*(def |class |import |from |print\()", line) for line in body.splitlines()):
        return True
    run = 0
    for line in body.splitlines():
        if CODE_LINE.match(line):
            run += 1
            if run >= 2:
                return True
        elif line.strip():
            run = 0
    return False


BRACKET_PAIRS = {"(": ")", "[": "]", "{": "}"}
DEDENT_STARTS = ("elif ", "else:", "except", "finally:", ")", "]", "}")


def fix_indent(code):
    """Rebuild Python indentation from block colons: the 2B model gets this wrong often."""
    out, depth = [], 0
    for raw in str(code or "").splitlines():
        line = raw.strip()
        if not line:
            out.append("")
            continue
        if line.startswith(DEDENT_STARTS):
            depth = max(depth - 1, 0)
        out.append("    " * depth + line)
        if line.endswith(":") and not line.startswith("#"):
            depth += 1
    return "\n".join(out)


def script_issues(code):
    """What compile() accepts but execution will not: a main() that can never run.

    Name resolution is deliberately not checked here: the script is executed, and
    a static guess flagged valid code (match patterns, exec, __file__) far more
    often than it caught a real NameError.
    """
    try:
        tree = ast.parse(str(code))
    except SyntaxError as err:
        return ["SyntaxError: %s" % err.msg]
    issues = []
    parents = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[child] = parent
    called = {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or node.name != "main":
            continue
        if node.name in called:
            continue  # nested but actually called: legal
        # A class method named main is fine; a main() swallowed by a function is not.
        ancestor = parents.get(node)
        while ancestor is not None and not isinstance(
            ancestor, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        ):
            ancestor = parents.get(ancestor)
        if isinstance(ancestor, (ast.FunctionDef, ast.AsyncFunctionDef)):
            issues.append("main() is nested inside another function, so it never runs")
            break
    return issues


def script_ok(code, python=False):
    """A script that stops mid-statement is worse than none: reject it."""
    body = str(code or "").strip()
    if not body or not any(CODE_LINE.match(line) for line in body.splitlines()):
        return False
    tail = body.splitlines()[-1].rstrip()
    if tail.endswith((":", "(", ",", "\\", "+", "=", "and", "or", "return")):
        return False
    depth = 0
    for char in body:
        if char in BRACKET_PAIRS:
            depth += 1
        elif char in BRACKET_PAIRS.values():
            depth -= 1
            if depth < 0:
                return False
    if depth != 0:
        return False
    lines = [line.strip() for line in body.splitlines() if line.strip()]
    if lines and max(lines.count(line) for line in set(lines)) > 3:
        # The model collapsing onto one repeated line is not a script.
        return False
    if python:
        try:
            compile(body, "<script>", "exec")
        except SyntaxError:
            return False
        if script_issues(body):
            return False
    return True


# dimension, scale to the base unit, offset to the base unit (base = value * scale + offset)
UNITS = {
    "m": ("length", 1.0, 0.0),
    "km": ("length", 1000.0, 0.0),
    "cm": ("length", 0.01, 0.0),
    "mm": ("length", 0.001, 0.0),
    "um": ("length", 1e-6, 0.0),
    "nm": ("length", 1e-9, 0.0),
    "mi": ("length", 1609.344, 0.0),
    "yd": ("length", 0.9144, 0.0),
    "ft": ("length", 0.3048, 0.0),
    "in": ("length", 0.0254, 0.0),
    "nmi": ("length", 1852.0, 0.0),
    "kg": ("mass", 1.0, 0.0),
    "g": ("mass", 0.001, 0.0),
    "mg": ("mass", 1e-6, 0.0),
    "t": ("mass", 1000.0, 0.0),
    "lb": ("mass", 0.45359237, 0.0),
    "oz": ("mass", 0.028349523125, 0.0),
    "stone": ("mass", 6.35029318, 0.0),
    "s": ("time", 1.0, 0.0),
    "ms": ("time", 0.001, 0.0),
    "min": ("time", 60.0, 0.0),
    "h": ("time", 3600.0, 0.0),
    "day": ("time", 86400.0, 0.0),
    "week": ("time", 604800.0, 0.0),
    "j": ("energy", 1.0, 0.0),
    "kj": ("energy", 1000.0, 0.0),
    "mj": ("energy", 1e6, 0.0),
    "cal": ("energy", 4.184, 0.0),
    "kcal": ("energy", 4184.0, 0.0),
    "wh": ("energy", 3600.0, 0.0),
    "kwh": ("energy", 3.6e6, 0.0),
    "ev": ("energy", 1.602176634e-19, 0.0),
    "btu": ("energy", 1055.05585262, 0.0),
    "w": ("power", 1.0, 0.0),
    "kw": ("power", 1000.0, 0.0),
    "mw": ("power", 1e6, 0.0),
    "hp": ("power", 745.6998715822702, 0.0),
    "pa": ("pressure", 1.0, 0.0),
    "kpa": ("pressure", 1000.0, 0.0),
    "mpa": ("pressure", 1e6, 0.0),
    "bar": ("pressure", 1e5, 0.0),
    "atm": ("pressure", 101325.0, 0.0),
    "psi": ("pressure", 6894.757293168, 0.0),
    "mmhg": ("pressure", 133.322387415, 0.0),
    "torr": ("pressure", 133.322368421, 0.0),
    "l": ("volume", 1.0, 0.0),
    "ml": ("volume", 0.001, 0.0),
    "m3": ("volume", 1000.0, 0.0),
    "gal": ("volume", 3.785411784, 0.0),
    "qt": ("volume", 0.946352946, 0.0),
    "pt": ("volume", 0.473176473, 0.0),
    "cup": ("volume", 0.2365882365, 0.0),
    "floz": ("volume", 0.0295735295625, 0.0),
    "mps": ("speed", 1.0, 0.0),
    "kph": ("speed", 0.2777777777777778, 0.0),
    "mph": ("speed", 0.44704, 0.0),
    "knot": ("speed", 0.5144444444444445, 0.0),
    "m2": ("area", 1.0, 0.0),
    "km2": ("area", 1e6, 0.0),
    "ha": ("area", 10000.0, 0.0),
    "acre": ("area", 4046.8564224, 0.0),
    "ft2": ("area", 0.09290304, 0.0),
    "byte": ("data", 1.0, 0.0),
    "bit": ("data", 0.125, 0.0),
    "kb": ("data", 1024.0, 0.0),
    "mb": ("data", 1048576.0, 0.0),
    "gb": ("data", 1073741824.0, 0.0),
    "tb": ("data", 1099511627776.0, 0.0),
    "rad": ("angle", 1.0, 0.0),
    "deg": ("angle", 0.017453292519943295, 0.0),
    "grad": ("angle", 0.015707963267948967, 0.0),
    "turn": ("angle", 6.283185307179586, 0.0),
    "n": ("force", 1.0, 0.0),
    "kn": ("force", 1000.0, 0.0),
    "lbf": ("force", 4.4482216152605, 0.0),
    "dyn": ("force", 1e-5, 0.0),
    "hz": ("frequency", 1.0, 0.0),
    "khz": ("frequency", 1e3, 0.0),
    "mhz": ("frequency", 1e6, 0.0),
    "ghz": ("frequency", 1e9, 0.0),
    "k": ("temperature", 1.0, 0.0),
    "c": ("temperature", 1.0, 273.15),
    "f": ("temperature", 5.0 / 9.0, 273.15 - 32 * 5.0 / 9.0),
    "r": ("temperature", 5.0 / 9.0, 0.0),
}

UNIT_ALIASES = {
    "metre": "m", "meter": "m", "metres": "m", "meters": "m",
    "kilometre": "km", "kilometer": "km", "kilometres": "km", "kilometers": "km",
    "centimetre": "cm", "centimeter": "cm", "millimetre": "mm", "millimeter": "mm",
    "mile": "mi", "miles": "mi", "inch": "in", "inches": "in", "foot": "ft", "feet": "ft",
    "yard": "yd", "yards": "yd", "pound": "lb", "pounds": "lb", "ounce": "oz", "ounces": "oz",
    "gram": "g", "grams": "g", "kilogram": "kg", "kilograms": "kg", "tonne": "t", "tonnes": "t",
    "second": "s", "seconds": "s", "minute": "min", "minutes": "min",
    "hour": "h", "hours": "h", "days": "day", "weeks": "week",
    "joule": "j", "joules": "j", "calorie": "cal", "calories": "cal",
    "watt": "w", "watts": "w", "kilowatt": "kw", "kilowatts": "kw", "horsepower": "hp",
    "pascal": "pa", "pascals": "pa", "atmosphere": "atm", "atmospheres": "atm",
    "litre": "l", "liter": "l", "litres": "l", "liters": "l", "gallon": "gal", "gallons": "gal",
    "miles_per_hour": "mph", "kmh": "kph", "knots": "knot",
    "degree": "deg", "degrees": "deg", "radian": "rad", "radians": "rad",
    "newton": "n", "newtons": "n", "hertz": "hz",
    "celsius": "c", "fahrenheit": "f", "kelvin": "k", "rankine": "r",
    "bytes": "byte", "bits": "bit",
}

BASE_UNITS = {
    "length": "m", "mass": "kg", "time": "s", "temperature": "k", "energy": "j",
    "power": "w", "pressure": "pa", "volume": "l", "speed": "mps", "area": "m2",
    "data": "byte", "angle": "rad", "force": "n", "frequency": "hz",
}


def fmt_number(value):
    if value == int(value) and abs(value) < 1e16:
        return "%d" % value
    return "%.6g" % value


def unit_lookup(name):
    key = str(name).strip().lower().replace("°", "").rstrip(".")
    key = UNIT_ALIASES.get(key, key)
    if key in UNITS:
        return key, UNITS[key]
    if key.endswith("s") and key[:-1] in UNITS:
        return key[:-1], UNITS[key[:-1]]
    return "", None


def convert_units(text):
    """Convert between units and show the factor or formula that was applied."""
    body = str(text or "").strip()
    if not body:
        dims = sorted({entry[0] for entry in UNITS.values()})
        return "dimensions: " + ", ".join(dims) + "\nusage: /units 3 kWh to J", False
    match = re.match(
        r"^(-?[\d.]+(?:[eE][-+]?\d+)?)\s*([^\s]+)(?:\s*(?:to|in|as|->|=>)\s*([^\s]+))?$",
        body,
        re.I,
    )
    if not match:
        return "usage: /units <value> <unit> [to] <unit>   e.g. /units 3 kWh to J", False
    value = float(match.group(1))
    from_key, from_unit = unit_lookup(match.group(2))
    if not from_unit:
        return "unknown unit: %s" % match.group(2), False
    if not match.group(3):
        target_key = BASE_UNITS[from_unit[0]]
        target_unit = UNITS[target_key]
    else:
        target_key, target_unit = unit_lookup(match.group(3))
        if not target_unit:
            return "unknown unit: %s" % match.group(3), False
        if target_unit[0] != from_unit[0]:
            return (
                "cannot convert %s (%s) to %s (%s)"
                % (from_key, from_unit[0], target_key, target_unit[0]),
                False,
            )
    base = value * from_unit[1] + from_unit[2]
    result = (base - target_unit[2]) / target_unit[1]
    head = "%s %s = %s %s" % (fmt_number(value), from_key, fmt_number(result), target_key)
    base_key = BASE_UNITS[from_unit[0]]
    if from_unit[0] == "temperature":
        via = "  via: %s -> K: %s x %s %+g = %s K \u00b7 K -> %s: (%s %+g) / %s = %s %s" % (
            from_key, fmt_number(value), fmt_number(from_unit[1]), from_unit[2], fmt_number(base),
            target_key, fmt_number(base), -target_unit[2], fmt_number(target_unit[1]),
            fmt_number(result), target_key,
        )
    else:
        via = "  via: %s %s x %s = %s %s  (1 %s = %s %s)" % (
            fmt_number(value), from_key, fmt_number(from_unit[1]), fmt_number(base), base_key,
            from_key, fmt_number(from_unit[1]), base_key,
        )
        if target_key != base_key or target_unit[1] != 1:
            via += " \u00b7 %s %s / %s = %s %s  (1 %s = %s %s)" % (
                fmt_number(base), base_key, fmt_number(target_unit[1]), fmt_number(result),
                target_key, target_key, fmt_number(target_unit[1]), base_key,
            )
    return head + "\n" + via, True


def near_duplicate(first, second, limit=0.9):
    """True when two answers say the same thing, so a repeat is not shown again."""
    if not first or not second:
        return False
    return SequenceMatcher(None, str(first).strip(), str(second).strip()).ratio() > limit


def wants_continuation(text):
    """True when an answer was cut mid-sentence, so content is missing."""
    body = str(text or "").rstrip()
    if len(body.split()) < 60:
        return False
    return not body.endswith((".", "!", "?", ")", '"', "```"))


def sample_input(prompt):
    """A few plausible answers for input(), so a script can be run without a human."""
    low = str(prompt or "").lower()
    if "calc" in low:
        return "5\n+\n3\nquit\n"
    return "5\n3\nhello\n"


SANDBOX_PRELUDE = '''
import os, sys
_SANDBOX = os.path.realpath(os.getcwd())
_NET = ("socket.connect", "socket.getaddrinfo", "socket.bind", "socket.gethostbyname")
_PROC = ("subprocess.Popen", "os.system", "os.exec", "os.spawn")
_MUTATE = ("os.remove", "os.unlink", "os.rmdir", "os.rename", "os.chmod", "os.chown",
           "shutil.rmtree", "shutil.copyfile", "shutil.move")
def _inside(path):
    try:
        full = os.path.realpath(os.fspath(path))
    except Exception:
        return False
    return full == _SANDBOX or full.startswith(_SANDBOX + os.sep)
def _guard(event, args):
    if event in _NET or event in _PROC:
        raise RuntimeError("sandbox blocked " + event)
    if event in _MUTATE and args and not _inside(args[0]):
        raise RuntimeError("sandbox blocked " + event + " outside its folder")
    if event == "open":
        path, mode = args[0], args[1]
        if isinstance(path, int):
            return
        flags = args[2] if len(args) > 2 else 0
        writing = (str(mode)[:1] != "r") if mode is not None else bool(
            flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND))
        if not writing:
            return
        full = os.path.realpath(os.fspath(path))
        if full == _SANDBOX or full.startswith(_SANDBOX + os.sep):
            return
        raise RuntimeError("sandbox blocked a write outside its folder: " + full)
sys.addaudithook(_guard)
'''


def run_script(code, prompt=""):
    """Run generated code in a sandbox folder: no network, no writes outside it.

    An audit hook enforces this and a script cannot remove it. The folder is
    throwaway and the timeout stops a loop or an input wait. Only used when
    run_scripts is enabled.
    """
    folder = Path(tempfile.mkdtemp(prefix="fastchat-sandbox-"))
    script = folder / "main.py"
    try:
        script.write_text(SANDBOX_PRELUDE + "\n" + str(code), encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, "-I", str(script)],
            input=sample_input(prompt),
            capture_output=True,
            text=True,
            timeout=6,
            cwd=str(folder),
        )
    except subprocess.TimeoutExpired:
        return False, "timed out after 6s (waiting for input, or looping)"
    except Exception as err:  # noqa: BLE001
        return False, str(err)
    output = ((proc.stdout or "") + (proc.stderr or "")).strip()
    ok = proc.returncode == 0 and "Traceback" not in output
    return ok, output[-600:]


def split_intro(text):
    """Separate a natural-language lead-in from the fenced code that follows it."""
    body = str(text or "")
    index = body.find("```")
    if index <= 0:
        return "", body.strip()
    intro = " ".join(body[:index].split()).strip(" .:")
    return intro, body[index:].strip()


def code_fitness(code):
    """Prefer plain top-level programs over nested defs and placeholder stubs."""
    body = str(code or "")
    score = 0.0
    for line in body.splitlines():
        if re.match(r"\s+def ", line):
            score -= 1.5
        if "Placeholder" in line or "TODO" in line:
            score -= 1.0
    if re.search(r"\binput\(", body):
        score += 0.5
    if "__main__" in body:
        score += 0.5
    return score


def code_quality(text):
    """Rank a candidate reply: fenced and code-dense beats prose about code."""
    body = str(text or "")
    score = 2.0 if "```" in body else 0.0
    lines = [line for line in body.splitlines() if CODE_LINE.match(line)]
    score += min(3.0, len(lines) / 3.0)
    if re.search(r"\bthe code below\b|\bhere is\b|\bthis approach\b", body, re.I):
        score -= 1.0
    if len(body.split()) > 160:
        score -= 2.0
    return round(score, 2)


def wants_list(prompt):
    """True when a long list is what was actually asked for."""
    low = " " + str(prompt).lower() + " "
    return any(marker in low for marker in LIST_MARKERS)


def rambles(text):
    """A runaway enumeration: one huge comma chain instead of an answer.

    The 2B model's other failure mode, besides looping, is answering "what is a
    cat" with sixty unrelated animals. Returns why it rambles, or None.
    """
    body = str(text or "")
    sentences = sentences_of(body) or [body]
    longest = max(sentences, key=len)
    words = len(longest.split())
    # semicolons enumerate just as much as commas do
    commas = longest.count(",") + longest.count(";")
    if words >= 40 and commas >= 8 and commas >= words / 6.0:
        return "a %d-word sentence with %d list separators" % (words, commas)
    if len(body.split()) > 200 and len(sentences) < 3:
        return "a %d-word block with no structure" % len(body.split())
    # a list with its commas stripped: almost no function words between items.
    # Unique-word counts alone flagged ordinary prose, which has few repeats too.
    tokens = re.findall(r"[a-z]+", longest.lower())
    if len(tokens) >= 30:
        stop = sum(1 for token in tokens if token in STOPWORDS)
        if stop / float(len(tokens)) < 0.15:
            return "a %d-word list, not sentences" % len(tokens)
    return None


def sentences_of(text):
    # 16 chars, not 24: anything shorter was silently dropped, which made short
    # answers look 100% novel and unsplittable into chunks.
    parts = re.split(r"(?<=[.!?])\s+|\n+", str(text))
    return [re.sub(r"\s+", " ", part).strip() for part in parts if len(part.strip()) > 16]


def novelty(answer, seen, threshold=0.85):
    """Share of this answer's sentences that were not already said."""
    sentences = sentences_of(answer)
    if not sentences:
        # no sentence survived splitting: compare the whole text instead of
        # calling it new, which is how a repeated short answer slipped through
        low = re.sub(r"\s+", " ", str(answer).strip().lower())
        if not low:
            return 1.0
        return 0.0 if any(SequenceMatcher(None, low, old).ratio() > threshold for old in seen) else 1.0
    fresh = 0
    for sentence in sentences:
        low = sentence.lower()
        if not any(SequenceMatcher(None, low, old).ratio() > threshold for old in seen):
            fresh += 1
    return fresh / float(len(sentences))


def agreement(a, b):
    """How much two answers share by content, so paraphrase still counts."""
    words_a, words_b = content_words(a), content_words(b)
    if not words_a or not words_b:
        return SequenceMatcher(None, str(a).lower(), str(b).lower()).ratio()
    return len(words_a & words_b) / float(len(words_a | words_b))


def rrf_merge(*ranked, k=60):
    """Reciprocal rank fusion: merge keyword and vector hit lists by rank."""
    scores = {}
    items = {}
    for listing in ranked:
        for rank, item in enumerate(listing or []):
            key = (str(item.get("path", "")).split(" (")[0], str(item.get("body", ""))[:60])
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank + 1.0)
            items.setdefault(key, item)
    ordered = sorted(scores.items(), key=lambda pair: pair[1], reverse=True)
    return [items[key] for key, _score in ordered]


def chunk_by_tokens(text, budget=70):
    """Greedy sentence packing: chunks that fit a token budget, no split mid-sentence."""
    chunks = []
    current = []
    used = 0
    for sentence in sentences_of(text) or [str(text).strip()]:
        cost = token_count(sentence)
        if current and used + cost > budget:
            chunks.append(" ".join(current))
            current, used = [], 0
        current.append(sentence)
        used += cost
    if current:
        chunks.append(" ".join(current))
    return chunks


SIMPLER = ("simpler", "simply", "in simple terms", "eli5", "plain english", "short version", "shorter", "summarise", "summarize", "tldr", "one sentence")
DEEPER = ("more", "detail", "elaborate", "expand", "continue", "go on", "keep going", "next", "another", "example", "instance")
LISTY = ("list", "steps", "checklist", "ideas", "options", "ways", "examples", "bullet")
CONTRASTY = ("compare", "contrast", "difference", "differ", "versus", " vs ", "better than", "instead", "combine", "both", "merge", "why not")


def classify_intent(prompt, last_prompt, last_answer):
    """Name what this turn is asking for, so a million phrasings need no extra call."""
    text = re.sub(r"\s+", " ", str(prompt).strip().lower())
    previous = re.sub(r"\s+", " ", str(last_prompt or "").strip().lower())
    if not last_answer:
        return "new"
    if text == previous or SequenceMatcher(None, text, previous).ratio() > 0.9:
        return "repeat"
    if any(word in text for word in CONTRASTY):
        return "contrast"
    if any(word in text for word in SIMPLER):
        return "simpler"
    if any(word in text for word in LISTY):
        return "list"
    overlap = content_words(text) & content_words(str(last_prompt or "") + " " + str(last_answer or ""))
    words = text.split()
    # "more" continues; "what is a sapphire" does not, even though it is just as
    # short. Short only counts as continuation when the subject is shared.
    if any(word in text for word in DEEPER) and (len(words) <= 8 or overlap):
        return "extend"
    if len(words) <= 4 and overlap:
        return "extend"
    return "deeper" if len(overlap) >= 2 else "new"


def chunk_terms(chunk):
    """The terms stored with a chunk; stores written before then only have the text."""
    return chunk.get("words") or content_words(chunk["text"])


class Memory:
    """Turns kept verbatim for a few messages, older material kept as chunks.

    The window is what the model reads as real messages; pack() adds token-bounded,
    retrieval-selected fragments of everything older, so the context grows in
    quality rather than in length.
    """

    def __init__(self, path, limit=None, chunk_budget=70):
        self.path = Path(path)
        self.log_path = self.path.with_name("chat_memory.jsonl")
        # memory_limit 0 means every turn is kept; older turns are read back
        # through pack()/retrieve() instead of being dropped.
        self.limit = int(limit if limit is not None else setting("memory_limit", 0, int))
        self.chunk_budget = chunk_budget
        self.turns = []
        self.chunks = []
        self.index = {}
        self.indexed = 0
        self.goal = ""
        self.lock = threading.Lock()
        self.dirty = False
        self.last_save = 0.0
        self.saves = 0
        self.load()
        atexit.register(lambda: self.save(force=True))

    # -- persistence ------------------------------------------------------- #
    def load(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self.turns = data.get("turns") or []
            self.chunks = data.get("chunks") or []
            self.indexed = int(data.get("indexed") or 0)
            self.goal = data.get("goal") or ""
        except (OSError, json.JSONDecodeError):
            self.turns = []
            self.chunks = []
            self.indexed = 0
        if self.limit:
            del self.turns[:-self.limit]
        if not self.chunks or self.indexed < (self.turns[-1]["n"] if self.turns else 0):
            # Only a store written before chunks were persisted needs a full pass.
            self.rebuild()
        else:
            self.rebuild_index()

    def save(self, force=False):
        """Snapshot the store, throttled: rewriting the whole file every turn is O(n)."""
        if not force:
            if not self.dirty:
                return
            interval = setting("memory_save_interval", 2.0, float)
            if time.time() - self.last_save < interval:
                return
        self.dirty = False
        self.last_save = time.time()
        try:
            # turns and chunks are already within their limits (load/add bound them),
            # so the snapshot is a plain dump rather than another slice of everything.
            self.path.write_text(
                json.dumps(
                    {
                        "turns": self.turns,
                        "chunks": self.chunks,
                        "indexed": self.indexed,
                        "goal": self.goal,
                    }
                ),
                encoding="utf-8",
            )
            self.saves += 1
        except OSError as err:
            print("memory save failed:", err)

    def rebuild(self):
        """Full re-index: only for a store that predates persisted chunks."""
        self.chunks = []
        turns = self.turns[-self.limit :] if self.limit else self.turns
        for turn in turns:
            for source, role in ((turn.get("user"), "asked"), (turn.get("answer"), "answered")):
                for text in chunk_by_tokens(source or "", self.chunk_budget):
                    self.chunks.append(
                        {
                            "turn": turn.get("n"),
                            "text": text,
                            "role": role,
                            "words": sorted(content_words(text)),
                        }
                    )
        self.indexed = turns[-1].get("n", 0) if turns else 0
        self.rebuild_index()

    def rebuild_index(self):
        """term -> chunk positions, so a query only scores chunks that can match."""
        self.index = {}
        for position, chunk in enumerate(self.chunks):
            for term in chunk_terms(chunk):
                self.index.setdefault(term, set()).add(position)

    def log(self, event, **fields):
        row = {"ts": round(time.time(), 3), "event": event}
        row.update(fields)
        try:
            with self.lock:
                with self.log_path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            pass
        rotate_jsonl(self.log_path)

    # -- writing ----------------------------------------------------------- #
    def add(self, user, answer):
        number = (self.turns[-1]["n"] + 1) if self.turns else 1
        turn = {
            "n": number,
            "user": str(user),
            "answer": str(answer),
            "topics": sorted(content_words(str(user) + " " + str(answer)))[:24],
        }
        self.turns.append(turn)
        if self.limit:
            del self.turns[:-self.limit]
        # Chunk only the new turn. Older chunks stay as they are; when chunk_keep is
        # set the oldest are dropped instead of re-chunking the whole history.
        start = len(self.chunks)
        # The user's own words are indexed too: a fact the user stated (".my workshop
        # code is 4821.") is only recallable if it was chunked, and the answer may
        # never repeat it. Terms are stored once here, never recomputed per query.
        for source, role in ((str(user), "asked"), (str(answer), "answered")):
            for text in chunk_by_tokens(source, self.chunk_budget):
                self.chunks.append(
                    {
                        "turn": number,
                        "text": text,
                        "role": role,
                        "words": sorted(content_words(text)),
                    }
                )
        self.indexed = number
        keep = setting("chunk_keep", 0, int)
        if keep and len(self.chunks) > keep:
            self.chunks = self.chunks[-keep:]
            self.rebuild_index()
        else:
            for position in range(start, len(self.chunks)):
                for term in chunk_terms(self.chunks[position]):
                    self.index.setdefault(term, set()).add(position)
        self.dirty = True
        self.save()
        self.log("turn", n=number, user=str(user)[:200], chars=len(str(answer)), topics=turn["topics"][:8])

    # -- reading ----------------------------------------------------------- #
    def window(self, budget_tokens=None, drop_last=False, max_turns=None):
        """Verbatim recent turns, newest first, only while they fit the token budget.

        A turn count let two long answers fill the prompt: the model then imitated
        their length and the client paid for rewrite calls. Budgeting tokens keeps
        the prompt flat however long earlier answers were.
        """
        budget = (
            setting("memory_window_tokens", 300, int) if budget_tokens is None else int(budget_tokens)
        )
        cap = setting("memory_window", 4, int) if max_turns is None else int(max_turns)
        turns = self.turns[:-1] if drop_last else self.turns
        picked = []
        used = 0
        for turn in reversed(turns[-cap:] if cap else turns):
            user = str(turn.get("user", ""))
            answer = str(turn.get("answer", ""))
            cost = token_count(user) + token_count(answer) + 6
            if budget <= 0 or used + cost > budget:
                # Keep the newest exchange trimmed rather than handing the model
                # nothing at all; anything older simply does not fit.
                room = budget - used - token_count(user) - 6
                if not picked and room > 60:
                    picked.append((user, trim_to_tokens(answer, room)))
                break
            picked.append((user, answer))
            used += cost
        messages = []
        for user, answer in reversed(picked):
            messages.append({"role": "user", "content": user})
            messages.append({"role": "assistant", "content": answer})
        return messages

    def retrieve(self, query, k=4, before_turn=None):
        words = content_words(query)
        if not words:
            return []
        candidates = set()
        for term in words:
            candidates |= self.index.get(term, set())
        scored = []
        for position in candidates:
            chunk = self.chunks[position]
            if before_turn is not None and (chunk.get("turn") or 0) >= before_turn:
                continue
            overlap = len(words & set(chunk_terms(chunk)))
            if overlap >= 2:
                # longer chunks do not automatically win: normalise by size
                scored.append((overlap / math.sqrt(len(chunk["text"]) / 100.0 + 1.0), chunk))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [chunk for _, chunk in scored[:k]]

    def pack(self, query, skip_turns=4, budget_tokens=None):
        budget_tokens = MEMORY_BUDGET if budget_tokens is None else budget_tokens
        if not self.turns:
            return ""
        older = self.turns[:-skip_turns] if skip_turns and len(self.turns) > skip_turns else []
        before = older[-1]["n"] + 1 if older else None
        lines = []
        if older:
            asked = [turn["user"] for turn in older[-6:]]
            lines.append("Earlier the user asked: " + " | ".join(text[:90] for text in asked))
        chunks = self.retrieve(query, k=4, before_turn=before if before is not None else (self.turns[0]["n"] + 1))
        if chunks:
            lines.append(
                "Relevant earlier turns:\n"
                + "\n".join(
                    "- " + ("user said: " if chunk.get("role") == "asked" else "") + chunk["text"]
                    for chunk in chunks
                )
            )
        packed = []
        used = 0
        for line in lines:
            cost = token_count(line)
            if used + cost > budget_tokens:
                room = budget_tokens - used
                if room > 50:
                    cut = line[: room * 4]
                    # never end the context mid-sentence: back off to a boundary
                    boundary = max(cut.rfind(". "), cut.rfind("\n"))
                    packed.append(cut[: boundary + 1] if boundary > 40 else cut)
                break
            packed.append(line)
            used += cost
        return "\n\n".join(packed)

    def emitted_sentences(self, turns=3, limit=40):
        seen = []
        for turn in self.turns[-turns:]:
            seen.extend(sentence.lower() for sentence in sentences_of(turn.get("answer", "")))
        return seen[-limit:]

    def goal_progress(self):
        if not self.goal:
            return 0.0
        words = content_words(self.goal)
        if not words:
            return 0.0
        recent = " ".join(turn["answer"] for turn in self.turns[-3:])
        return len(words & content_words(recent)) / float(len(words))

    def clear(self):
        self.turns = []
        self.chunks = []
        self.save()
        self.log("clear")


# --------------------------------------------------------------------------- #
# images: pixels first, from the standard library, then the vision model
# --------------------------------------------------------------------------- #
VISION_SYSTEM = (
    "You are looking at an image. Answer only from what is visible in it. Be specific "
    "about what is where. At most three sentences, no preamble."
)
COLOUR_WORDS = (
    "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "magenta",
    "brown", "grey", "gray", "white", "black", "beige", "teal", "gold", "silver",
)
PREPLY_THRESHOLD = setting("preply_threshold", 1200, int)


def resolve_path(text):
    """Accept the paths people actually paste: plain, quoted, or MSYS /c/Users/..."""
    raw = str(text).strip().strip('"\'')
    candidate = Path(raw)
    if candidate.exists():
        return candidate
    match = re.match(r"^/([a-zA-Z])/(.*)$", raw.replace("\\", "/"))
    if match:
        alternate = Path("%s:/%s" % (match.group(1).upper(), match.group(2)))
        if alternate.exists():
            return alternate
    return candidate


def split_args(argument):
    """Whitespace split that survives Windows backslashes (shlex would eat them)."""
    text = str(argument)
    try:
        tokens = shlex.split(text, posix=(os.name != "nt"))
    except ValueError:
        tokens = text.split()
    return [token.strip('"\'') for token in tokens if token.strip('"\'')]


def colour_name(r, g, b):
    hue, saturation, value = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
    if value < 0.12:
        return "black"
    if saturation < 0.14:
        return "white" if value > 0.92 else "grey"
    degrees = hue * 360.0
    if degrees < 15 or degrees >= 345:
        return "red"
    if degrees < 40:
        return "orange" if value > 0.55 else "brown"
    if degrees < 70:
        return "yellow"
    if degrees < 165:
        return "green"
    if degrees < 200:
        return "cyan"
    if degrees < 255:
        return "blue"
    return "purple" if degrees < 300 else "pink"


def png_pixels(data):
    """Decode a non-interlaced 8-bit PNG. Returns rows of raw samples."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos = 8
    width = height = 0
    depth = colour_type = interlace = 0
    palette = b""
    parts = []
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width, height, depth, colour_type, _comp, _filt, interlace = struct.unpack(">IIBBBBB", body)
        elif kind == b"PLTE":
            palette = body
        elif kind == b"IDAT":
            parts.append(body)
        elif kind == b"IEND":
            break
    if not width or not height:
        raise ValueError("no IHDR")
    if depth != 8:
        raise ValueError("%d-bit PNG not supported" % depth)
    if interlace:
        raise ValueError("interlaced PNG not supported")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(colour_type)
    if channels is None:
        raise ValueError("colour type %d not supported" % colour_type)
    raw = zlib.decompress(b"".join(parts))
    stride = width * channels
    rows = []
    previous = bytearray(stride)
    offset = 0
    for _ in range(height):
        filter_type = raw[offset]
        line = bytearray(raw[offset + 1:offset + 1 + stride])
        offset += 1 + stride
        step = channels
        if filter_type == 1:
            for i in range(step, stride):
                line[i] = (line[i] + line[i - step]) & 0xFF
        elif filter_type == 2:
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif filter_type == 3:
            for i in range(stride):
                left = line[i - step] if i >= step else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif filter_type == 4:
            for i in range(stride):
                a = line[i - step] if i >= step else 0
                b = previous[i]
                c = previous[i - step] if i >= step else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                predictor = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + predictor) & 0xFF
        elif filter_type != 0:
            raise ValueError("filter %d not supported" % filter_type)
        rows.append(bytes(line))
        previous = line
    return width, height, channels, colour_type, palette, rows


def write_png(width, height, rgb_rows):
    raw = b"".join(b"\x00" + bytes(row) for row in rgb_rows)

    def chunk(kind, body):
        payload = kind + body
        return struct.pack(">I", len(body)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def jpeg_size(data):
    pos = 2
    while pos + 9 < len(data):
        if data[pos] != 0xFF:
            pos += 1
            continue
        marker = data[pos + 1]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            height, width = struct.unpack(">HH", data[pos + 5:pos + 9])
            return width, height
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            pos += 2
            continue
        pos += 2 + struct.unpack(">H", data[pos + 2:pos + 4])[0]
    return None


_FACTS_CACHE = {}


def pixel_facts(path):
    """Cached: decoding a 1920x1080 PNG is the expensive part of /image."""
    target = resolve_path(path)
    try:
        stat = target.stat()
        key = (str(target), stat.st_mtime_ns, stat.st_size)
    except OSError:
        key = None
    if key is not None and key in _FACTS_CACHE:
        return _FACTS_CACHE[key]
    facts = _pixel_facts_uncached(target)
    if key is not None:
        if len(_FACTS_CACHE) > 40:
            _FACTS_CACHE.pop(next(iter(_FACTS_CACHE)))
        _FACTS_CACHE[key] = facts
    return facts


def _stats_from_rows(width, height, channels, colour_type, palette, rows):
    """Mean colour, contrast, colour names and a 32x18 luminance signature."""
    # 3x oversampling per grid cell is plenty; 5x cost 3x the time for no detail
    step_x = max(1, width // 96)
    step_y = max(1, height // 54)
    grid = [[0.0] * 32 for _ in range(18)]
    counts = [[0] * 32 for _ in range(18)]
    total = [0, 0, 0]
    samples = 0
    buckets = {}
    for y in range(0, height, step_y):
        row = rows[y]
        for x in range(0, width, step_x):
            r, g, b = pixel_rgb(row, x, channels, colour_type, palette)
            total[0] += r
            total[1] += g
            total[2] += b
            samples += 1
            luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
            gx = min(31, x * 32 // width)
            gy = min(17, y * 18 // height)
            grid[gy][gx] += luminance
            counts[gy][gx] += 1
            name = colour_name(r, g, b)
            buckets[name] = buckets.get(name, 0) + 1
    samples = samples or 1
    mean = (total[0] / samples, total[1] / samples, total[2] / samples)
    luminances = []
    for gy in range(18):
        for gx in range(32):
            if counts[gy][gx]:
                luminances.append(grid[gy][gx] / counts[gy][gx])
    mean_luminance = sum(luminances) / max(1, len(luminances))
    variance = sum((value - mean_luminance) ** 2 for value in luminances) / max(1, len(luminances))
    return {
        "width": width,
        "height": height,
        "mean_rgb": (round(mean[0]), round(mean[1]), round(mean[2])),
        "dominant_colour": colour_name(*mean),
        "mean_luminance": round(mean_luminance, 1),
        "contrast": round(math.sqrt(variance), 1),
        "colours": [name for name, _ in sorted(buckets.items(), key=lambda pair: pair[1], reverse=True)[:3]],
        "signature": [
            [round(grid[gy][gx] / counts[gy][gx], 1) if counts[gy][gx] else 0.0 for gx in range(32)]
            for gy in range(18)
        ],
        "decoded": True,
    }


def gdiplus_thumbnail(path, max_side=256):
    """Decode any GDI+ format (JPEG included) to a small RGB thumbnail.

    Windows only. Returns (width, height, rgb_rows, (original_w, original_h))
    or None. This is a thumbnail on purpose: mean colour and the 32x18 signature
    do not need a full-resolution decode.
    """
    if os.name != "nt":
        return None
    try:
        gdiplus = ctypes.windll.gdiplus
    except Exception:  # noqa: BLE001
        return None

    class StartupInput(ctypes.Structure):
        _fields_ = [
            ("GdiplusVersion", ctypes.c_uint32),
            ("DebugEventCallback", ctypes.c_void_p),
            ("SuppressBackgroundThread", ctypes.c_int),
            ("SuppressExternalCodecs", ctypes.c_int),
        ]

    class GpRect(ctypes.Structure):
        _fields_ = [("X", ctypes.c_int), ("Y", ctypes.c_int), ("Width", ctypes.c_int), ("Height", ctypes.c_int)]

    class BitmapData(ctypes.Structure):
        _fields_ = [
            ("Width", ctypes.c_uint32),
            ("Height", ctypes.c_uint32),
            ("Stride", ctypes.c_int),
            ("PixelFormat", ctypes.c_int),
            ("Scan0", ctypes.c_void_p),
            ("Reserved", ctypes.c_void_p),
        ]

    gdiplus.GdiplusStartup.argtypes = [ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(StartupInput), ctypes.c_void_p]
    gdiplus.GdiplusShutdown.argtypes = [ctypes.c_size_t]
    gdiplus.GdipLoadImageFromFile.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_void_p)]
    gdiplus.GdipGetImageWidth.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    gdiplus.GdipGetImageHeight.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    gdiplus.GdipGetImageThumbnail.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.c_void_p,
    ]
    gdiplus.GdipBitmapLockBits.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(GpRect), ctypes.c_uint32, ctypes.c_int, ctypes.POINTER(BitmapData)
    ]
    gdiplus.GdipBitmapUnlockBits.argtypes = [ctypes.c_void_p, ctypes.POINTER(BitmapData)]
    gdiplus.GdipDisposeImage.argtypes = [ctypes.c_void_p]

    token = ctypes.c_size_t()
    startup = StartupInput()
    startup.GdiplusVersion = 1
    if gdiplus.GdiplusStartup(ctypes.byref(token), ctypes.byref(startup), None) != 0:
        return None
    image = ctypes.c_void_p()
    thumb = ctypes.c_void_p()
    try:
        if gdiplus.GdipLoadImageFromFile(str(path), ctypes.byref(image)) != 0:
            return None
        width = ctypes.c_uint32()
        height = ctypes.c_uint32()
        if gdiplus.GdipGetImageWidth(image, ctypes.byref(width)) != 0:
            return None
        if gdiplus.GdipGetImageHeight(image, ctypes.byref(height)) != 0:
            return None
        original = (width.value, height.value)
        scale = min(1.0, float(max_side) / float(max(original) or 1))
        tw = max(1, int(original[0] * scale))
        th = max(1, int(original[1] * scale))
        if gdiplus.GdipGetImageThumbnail(image, tw, th, ctypes.byref(thumb), None, None) != 0:
            return None
        rect = GpRect(0, 0, tw, th)
        bits = BitmapData()
        if gdiplus.GdipBitmapLockBits(thumb, ctypes.byref(rect), 1, 0x26200A, ctypes.byref(bits)) != 0:
            return None
        try:
            buffer = ctypes.string_at(bits.Scan0, bits.Stride * th)
            stride = bits.Stride
        finally:
            gdiplus.GdipBitmapUnlockBits(thumb, ctypes.byref(bits))
        rows = []
        for y in range(th):
            offset = y * stride
            line = bytearray()
            for x in range(tw):
                base = offset + x * 4
                line.extend((buffer[base + 2], buffer[base + 1], buffer[base]))
            rows.append(bytes(line))
        return tw, th, rows, original
    finally:
        if thumb:
            gdiplus.GdipDisposeImage(thumb)
        if image:
            gdiplus.GdipDisposeImage(image)
        gdiplus.GdiplusShutdown(token)


def _pixel_facts_uncached(target):
    """What the file actually contains: size, mean colour, contrast, 32x18 signature."""
    data = target.read_bytes()
    facts = {"path": target.name, "bytes": len(data), "format": "unknown", "decoded": False}
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        facts["format"] = "png"
        try:
            width, height, channels, colour_type, palette, rows = png_pixels(data)
        except Exception as err:  # noqa: BLE001
            facts["error"] = str(err)
            return facts
        facts.update(_stats_from_rows(width, height, channels, colour_type, palette, rows))
        return facts
    if data[:2] == b"\xff\xd8":
        facts["format"] = "jpeg"
        size = jpeg_size(data)
        if size:
            facts["width"], facts["height"] = size
        thumb = gdiplus_thumbnail(target)
        if thumb:
            tw, th, rows, original = thumb
            facts.update(_stats_from_rows(tw, th, 3, 2, b"", rows))
            facts["thumbnail"] = "%dx%d from %dx%d" % (tw, th, original[0], original[1])
            # report the real dimensions, not the thumbnail's
            facts["width"], facts["height"] = original
        else:
            facts["error"] = "no JPEG decoder on this platform"
        return facts
    return facts


_SIGNATURE_CACHE = {}


def signature_of(path, max_side=None):
    # Measured on a 1920x1920 PNG: the pure decoder takes 46.7 ms, a GDI+
    # thumbnail takes 57.7 ms, so PNG uses the decoder and only JPEG needs GDI+.
    """Change-detection facts only: dimensions, mean colour and the 32x18 grid.

    Comparing two frames needs no full-resolution pixels, so this asks GDI+ for
    a 64 px thumbnail (native, no re-encode) instead of decoding a 1920x1920 PNG
    in Python and shipping the result. Falls back to the full decoder when there
    is no native thumbnail available.
    """
    max_side = int(max_side or setting("signature_max_side", 64, int))
    target = resolve_path(path)
    try:
        stat = target.stat()
        key = (str(target), stat.st_mtime_ns, stat.st_size, max_side)
    except OSError:
        key = None
    if key is not None and key in _SIGNATURE_CACHE:
        return _SIGNATURE_CACHE[key]
    data = target.read_bytes() if target.exists() else b""
    facts = {"path": target.name, "bytes": len(data), "format": "unknown", "decoded": False}
    if not data:
        return facts
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        facts["format"] = "png"
        try:
            facts["width"], facts["height"] = png_size(data)
        except Exception:  # noqa: BLE001
            pass
    elif data[:2] == b"\xff\xd8":
        facts["format"] = "jpeg"
        size = jpeg_size(data)
        if size:
            facts["width"], facts["height"] = size
    if facts["format"] == "png":
        facts = pixel_facts(target)
        facts["signature_source"] = "decoder"
    else:
        thumb = gdiplus_thumbnail(target, max_side)
        if thumb:
            tw, th, rows, original = thumb
            facts.update(_stats_from_rows(tw, th, 3, 2, b"", rows))
            facts["width"], facts["height"] = original
            facts["signature_source"] = "thumbnail %dx%d" % (tw, th)
        else:
            facts = pixel_facts(target)
            facts["signature_source"] = "full decode"
    if key is not None:
        _remember(_SIGNATURE_CACHE, key, facts, limit=40)
    return facts


def region_name(gx, gy):
    vertical = "top" if gy < 6 else ("middle" if gy < 12 else "bottom")
    horizontal = "left" if gx < 11 else ("centre" if gx < 21 else "right")
    return "%s %s" % (vertical, horizontal)


def frame_change(before, after):
    if not (before.get("decoded") and after.get("decoded")):
        return None
    grid_a, grid_b = before["signature"], after["signature"]
    changed = []
    for gy in range(18):
        for gx in range(32):
            if abs(grid_a[gy][gx] - grid_b[gy][gx]) > 12:
                changed.append((gx, gy))
    return {
        "fraction": len(changed) / 576.0,
        "regions": sorted({region_name(gx, gy) for gx, gy in changed}),
    }


def pixel_agreement(text, facts):
    """Does the model's colour claim match what the pixels measure?"""
    if not facts.get("decoded"):
        return None
    said = [word for word in COLOUR_WORDS if re.search(r"\b%s\b" % word, str(text).lower())]
    measured = facts.get("dominant_colour")
    agree = None
    if said:
        agree = measured in said or (measured == "grey" and "gray" in said) or (measured == "pink" and "magenta" in said)
    return {"said": said, "measured": measured, "agree": agree}


_PAYLOAD_CACHE = {}


def _remember(cache, key, value, limit=20):
    """Bounded insert: an image cache must not become a memory leak."""
    if key in cache:
        cache.pop(key)
    elif len(cache) >= limit:
        cache.pop(next(iter(cache)))
    cache[key] = value


def png_size(data):
    """Width and height from the header alone, without decoding the image."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    if data[12:16] != b"IHDR":
        raise ValueError("no IHDR first")
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def pixel_rgb(row, x, channels, colour_type, palette):
    """One RGB triple from a decoded row, for every PNG colour type."""
    index = x * channels
    if colour_type in (2, 6):
        return row[index], row[index + 1], row[index + 2]
    if colour_type in (0, 4):
        value = row[index]
        return value, value, value
    offset = row[index] * 3
    if offset + 2 < len(palette):
        return palette[offset], palette[offset + 1], palette[offset + 2]
    return 0, 0, 0


def orientation_of(width, height):
    if width > height * 1.05:
        return "landscape"
    if height > width * 1.05:
        return "portrait"
    return "square"


def shrink_rows(width, height, channels, colour_type, palette, rows, max_side):
    """Nearest-neighbour downscale using strided slices, not per-pixel Python."""
    step = max(1, int(math.ceil(max(width, height) / float(max(1, max_side)))))
    out = []
    if colour_type in (2, 6) and channels in (3, 4):
        span = channels * step
        for y in range(0, height, step):
            row = rows[y]
            red = row[0::span]
            green = row[1::span]
            blue = row[2::span]
            line = bytearray(len(red) * 3)
            line[0::3] = red
            line[1::3] = green
            line[2::3] = blue
            out.append(bytes(line))
        return out
    for y in range(0, height, step):
        row = rows[y]
        line = bytearray()
        for x in range(0, width, step):
            line.extend(pixel_rgb(row, x, channels, colour_type, palette))
        out.append(bytes(line))
    return out


def image_payload(path, max_side=None):
    """Base64 for the model: header read first, decode only when resizing."""
    max_side = int(max_side or setting("vision_max_side", 1280, int))
    target = resolve_path(path)
    try:
        stat = target.stat()
        cache_key = (str(target), stat.st_mtime_ns, stat.st_size, max_side)
    except OSError:
        cache_key = None
    if cache_key is not None and cache_key in _PAYLOAD_CACHE:
        return _PAYLOAD_CACHE[cache_key]
    data = target.read_bytes()
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        try:
            width, height = png_size(data)
        except Exception:  # noqa: BLE001
            width = height = 0
        if width and max(width, height) <= max_side:
            result = (base64.b64encode(data).decode(), "sent whole %dx%d %s" % (width, height, orientation_of(width, height)))
            if cache_key is not None:
                _remember(_PAYLOAD_CACHE, cache_key, result)
            return result
        try:
            width, height, channels, colour_type, palette, rows = png_pixels(data)
        except Exception:  # noqa: BLE001
            return base64.b64encode(data).decode(), "sent whole (not decodable)"
        if max(width, height) > max_side:
            scale = max_side / float(max(width, height))
            new_w = max(1, int(width * scale))
            new_h = max(1, int(height * scale))
            out = shrink_rows(width, height, channels, colour_type, palette, rows, max_side)
            new_w = len(out[0]) // 3
            new_h = len(out)
            shrunk = write_png(new_w, new_h, out)
            result = (
                base64.b64encode(shrunk).decode(),
                "downscaled %dx%d %s -> %dx%d" % (width, height, orientation_of(width, height), new_w, new_h),
            )
            if cache_key is not None:
                _remember(_PAYLOAD_CACHE, cache_key, result)
            return result
    if data[:2] == b"\xff\xd8":
        width, height = jpeg_size(data) or (0, 0)
        if width and max(width, height) > max_side:
            thumb = gdiplus_thumbnail(target, max_side)
            if thumb:
                tw, th, rows, _original = thumb
                result = (
                    base64.b64encode(write_png(tw, th, rows)).decode(),
                    "downscaled %dx%d jpeg -> %dx%d png" % (width, height, tw, th),
                )
                if cache_key is not None:
                    _remember(_PAYLOAD_CACHE, cache_key, result)
                return result
        result = (base64.b64encode(data).decode(), "sent whole %dx%d jpeg" % (width, height))
        if cache_key is not None:
            _remember(_PAYLOAD_CACHE, cache_key, result)
        return result
    result = (base64.b64encode(data).decode(), "sent whole")
    if cache_key is not None:
        _remember(_PAYLOAD_CACHE, cache_key, result)
    return result


def describe_pixels(facts):
    if not facts.get("decoded"):
        return "[%s %s, %d bytes, pixels not decoded: %s]" % (
            facts.get("format"),
            "%sx%s" % (facts.get("width"), facts.get("height")) if facts.get("width") else "",
            facts["bytes"],
            facts.get("error", "no pixel data"),
        )
    return "[pixels %dx%d %s%s | mean rgb %s | dominant %s | contrast %.1f | colours %s]" % (
        facts["width"],
        facts["height"],
        facts.get("format", "live"),
        (" (%s)" % facts["thumbnail"]) if facts.get("thumbnail") else "",
        facts["mean_rgb"],
        facts["dominant_colour"],
        facts["contrast"],
        ", ".join(facts.get("colours") or []),
    )


class Preplies:
    """Long material set aside instead of dropped: append it later on request."""

    def __init__(self, path):
        self.path = Path(path)
        self.items = []
        try:
            self.items = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self.items = []

    def add(self, title, text):
        number = (self.items[-1]["id"] + 1) if self.items else 1
        self.items.append({"id": number, "title": str(title)[:90], "text": str(text), "at": round(time.time())})
        self.items = self.items[-40:]
        self.save()
        return number

    def save(self):
        try:
            self.path.write_text(json.dumps(self.items), encoding="utf-8")
        except OSError:
            pass

    def get(self, number):
        for item in self.items:
            if item["id"] == number:
                return item
        return None

    def drop(self, number):
        item = self.get(number)
        if not item:
            return False
        self.items.remove(item)
        self.save()
        return True


# --------------------------------------------------------------------------- #
# live capture: the screen itself, through ctypes/GDI, no dependencies
# --------------------------------------------------------------------------- #
OCR_MODEL = setting("ocr_model", "glm-ocr:bf16")
CHECK_MODEL = setting("check_model", "qwen2.5:7b")


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", ctypes.c_uint32),
        ("biWidth", ctypes.c_int32),
        ("biHeight", ctypes.c_int32),
        ("biPlanes", ctypes.c_uint16),
        ("biBitCount", ctypes.c_uint16),
        ("biCompression", ctypes.c_uint32),
        ("biSizeImage", ctypes.c_uint32),
        ("biXPelsPerMeter", ctypes.c_int32),
        ("biYPelsPerMeter", ctypes.c_int32),
        ("biClrUsed", ctypes.c_uint32),
        ("biClrImportant", ctypes.c_uint32),
    ]


def capture_screen(max_side=1280):
    """Grab the primary screen as (width, height, rgb rows). Windows only."""
    if os.name != "nt":
        raise RuntimeError("live capture needs Windows (ctypes/GDI here)")
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    try:
        user32.SetProcessDPIAware()
    except Exception:  # noqa: BLE001
        pass
    user32.GetDC.restype = ctypes.c_void_p
    user32.GetDC.argtypes = [ctypes.c_void_p]
    user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
    gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
    gdi32.CreateCompatibleBitmap.restype = ctypes.c_void_p
    gdi32.CreateCompatibleBitmap.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    gdi32.SelectObject.restype = ctypes.c_void_p
    gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    gdi32.BitBlt.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_uint32,
    ]
    gdi32.GetDIBits.argtypes = [
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32,
        ctypes.c_void_p, ctypes.POINTER(BITMAPINFOHEADER), ctypes.c_uint32,
    ]
    gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
    gdi32.DeleteDC.argtypes = [ctypes.c_void_p]

    width = user32.GetSystemMetrics(0)
    height = user32.GetSystemMetrics(1)
    if width <= 0 or height <= 0:
        raise RuntimeError("screen size reported as %sx%s" % (width, height))
    screen = user32.GetDC(None)
    memory = gdi32.CreateCompatibleDC(screen)
    bitmap = gdi32.CreateCompatibleBitmap(screen, width, height)
    header = BITMAPINFOHEADER()
    header.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    header.biWidth = width
    header.biHeight = -height  # top-down rows
    header.biPlanes = 1
    header.biBitCount = 32
    header.biCompression = 0
    buffer = ctypes.create_string_buffer(width * height * 4)
    try:
        gdi32.SelectObject(memory, bitmap)
        if not gdi32.BitBlt(memory, 0, 0, width, height, screen, 0, 0, 0x00CC0020):
            raise RuntimeError("BitBlt failed")
        if not gdi32.GetDIBits(memory, bitmap, 0, height, buffer, ctypes.byref(header), 0):
            raise RuntimeError("GetDIBits failed")
    finally:
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(memory)
        user32.ReleaseDC(None, screen)
    raw = buffer.raw
    step = max(1, max(width, height) // max_side)
    rows = []
    span = 4 * step
    for y in range(0, height, step):
        base = y * width * 4
        line = raw[base:base + width * 4]
        # strided slice assignment: BGRA -> RGB in C, 54x faster than a loop
        red = line[2::span]
        green = line[1::span]
        blue = line[0::span]
        out = bytearray(len(red) * 3)
        out[0::3] = red
        out[1::3] = green
        out[2::3] = blue
        rows.append(bytes(out))
    return len(rows[0]) // 3, len(rows), rows


def capture_frame(label="frame"):
    """Write the current screen to a PNG in the state dir and return its path."""
    width, height, rows = capture_screen()
    folder = Path(state_dir()) / "live_frames"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / ("%s-%s.png" % (label, time.strftime("%H%M%S")))
    path.write_bytes(write_png(width, height, rows))
    for old in sorted(folder.glob("*.png"))[:-8]:
        try:
            old.unlink()
        except OSError:
            pass
    return path


# --------------------------------------------------------------------------- #
# document store: every chunk on disk, searchable, for large collections
# --------------------------------------------------------------------------- #
class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.db = sqlite3.connect(str(self.path))
        self.db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(path, body)")
        self.db.commit()

    def add_many(self, rows):
        self.db.executemany("INSERT INTO chunks(path, body) VALUES (?, ?)", rows)
        self.db.commit()

    def search(self, query, limit=6):
        # quote every term so punctuation in a query cannot become FTS syntax
        terms = re.findall(r"[A-Za-z0-9_]{2,}", str(query))
        safe = " OR ".join('"%s"' % term for term in terms) or '""'
        try:
            rows = self.db.execute(
                "SELECT path, body, rank FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT ?", (safe, limit)
            ).fetchall()
        except sqlite3.Error:
            return []
        return [{"path": path, "body": body} for path, body, _rank in rows]

    def count(self):
        try:
            return self.db.execute("SELECT count(*) FROM chunks").fetchone()[0]
        except sqlite3.Error:
            return 0

    def clear(self):
        self.db.execute("DELETE FROM chunks")
        self.db.commit()



# --------------------------------------------------------------------------- #
# [constraints] the user's standing requirements, as a numbered checklist
# --------------------------------------------------------------------------- #
# A standing requirement ("from now on, under 60 words") is forgotten by turn ten
# unless it is repeated: a small model follows the last thing it read, and a long
# answer pushes the original ask out of the window. This register keeps the rule,
# checks every answer against it, and re-sends the open rules as a numbered list
# at the end of the system prompt on every turn.
#
# Not everything the user says is standing. "Briefly", "short" or a one-off "in 3
# sentences" is a remark about the answer being written, and filing it as a
# permanent cap made every later answer short too. So a requirement carries a
# scope: "standing" when it is phrased that way (from now on / always / every
# answer) or added with /constraints add, and "once" otherwise. A one-off is sent
# beside its own question and then dropped; only standing rules reach the register.
CONSTRAINT_NUMBERS = {
    "a": 1, "an": 1, "one": 1, "single": 1, "two": 2, "three": 3, "four": 4,
    "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "twelve": 12, "couple": 2, "few": 3,
}

MAX_LENGTH = re.compile(
    r"(?:under|below|less than|fewer than|at most|max|maximum|no more than|"
    r"not more than|up to)\s+(?:of\s+)?(\d+|[a-z]+)\s+"
    r"(words?|sentences?|lines?|bullets?|points?|items?)"
)
MIN_LENGTH = re.compile(
    r"(?:over|more than|at least|minimum(?: of)?|min|no less than)\s+(\d+|[a-z]+)\s+"
    r"(words?|sentences?|lines?|bullets?|points?|items?)"
)
IN_LENGTH = re.compile(r"\bin\s+(\d+|[a-z]+)\s+(words?|sentences?|lines?)")

# Scope of what was stated. Only a promise of repetition makes a rule standing;
# everything else ("briefly", "in 3 sentences") belongs to the turn that said it.
STANDING = re.compile(
    r"\bfrom now on\b|\bfrom here on(?:ward|wards)?\b|\bgoing forward\b|\balways\b|"
    r"\bevery (?:answer|reply|response|time|turn)\b|"
    r"\beach (?:answer|reply|response|time|turn)\b|"
    r"\bin (?:all|any) (?:(?:future|your) )?(?:answers?|replies?|responses?)\b|"
    r"\bfor (?:all|every) (?:(?:future|your) )?(?:answers?|replies?|responses?)\b|"
    r"\b(?:as a )?(?:standing|permanent) (?:rule|instruction|requirement)\b|\bpermanently\b"
)
ONE_OFF = re.compile(
    r"\bthis (?:time|once|turn|answer|reply|response|message|one)\b|"
    r"\bjust (?:this|for) (?:time|once|now)\b|\bfor now\b|\bfor the moment\b|"
    r"\bonly (?:this|for) (?:time|once)\b|\bright now\b|"
    r"\bfor the rest of this (?:answer|reply|response)\b"
)

# (pattern, kind, label). Banned shapes come first so "no bullets" is not also
# read as "use bullets"; the reasons are kind, tone, format and library.
CONSTRAINT_RULES = (
    (r"\b(?:no|without|avoid|don'?t use|do not use|never use)\s+(?:any\s+)?"
     r"(?:bullet(?:ed)?\s+(?:list|points?)|bullets|lists?|numbered lists?)\b",
     "no_list", "Do not use bullet points or numbered lists"),
    (r"\b(?:no|never use|avoid)\s+(?:a\s+)?tables?\b", "no_table", "Do not use a table"),
    (r"\b(?:only|just)\s+(?:the\s+)?(?:code|script)\b|\bcode only\b|"
     r"\bno (?:prose|explanation|commentary)\b", "only_code", "Code only, no prose"),
    (r"\b(?:no|without|avoid|don'?t use|do not use)\s+emojis?\b|\bemoji[- ]free\b",
     "no_emoji", "No emoji"),
    (r"\b(?:no|without|avoid)\s+(?:jargon|buzzwords?)\b|\bplain (?:english|language|words?)\b|"
     r"\bsimple (?:words|language)\b|\blayman'?s terms\b", "no_jargon", "Plain English, no jargon"),
    (r"\b(?:be|keep it|stay)\s+(?:blunt|direct|candid)\b|\bget to the point\b|"
     r"\bno (?:fluff|filler|hedging|preamble|small talk)\b|\bto the point\b",
     "blunt", "Be blunt: no filler, no preamble"),
    (r"\b(?:use|using|with)\s+(?:only\s+)?(?:the\s+)?(?:python\s+)?(?:standard library|stdlib)\b|"
     r"\bstdlib only\b|\bno (?:external|third[- ]party)\s+(?:libraries|packages|dependencies|modules?)\b|"
     r"\bno (?:new )?dependencies\b|\bwithout (?:any )?dependencies\b",
     "stdlib", "Use only the Python standard library"),
    (r"\bnumbered (?:list|points?|steps?)\b", "numbered", "Use a numbered list"),
    (r"\bbullet(?:ed)?(?: list| points?|s)\b|\bas a list\b|\bin a list\b", "list", "Use bullet points"),
    (r"\b(?:as a|in a|markdown)\s+table\b|\btable format\b", "table", "Use a table"),
    (r"\b(?:reply|respond|answer|return|output|give me)\b[^.\n]{0,20}"
     r"\b(?:as|in|with)?\s*(?:valid\s+)?json\b|\bjson only\b", "json", "Reply in JSON"),
    (r"\binclude (?:unit )?tests?\b|\bwith tests\b", "tests", "Include tests"),
    (r"\b(?:be|keep it|in a)\s+formal\b|\bformally\b|\bprofessional tone\b", "note", "Formal tone"),
    (r"\b(?:be|keep it|in a)\s+casual\b|\bcasual tone\b", "note", "Casual tone"),
    (r"\b(?:use|using|with|via)\s+(?:the\s+)?(numpy|pandas|requests|tkinter|flask|fastapi|"
     r"django|sqlite3|matplotlib|pillow|selenium|playwright|httpx|aiohttp|pyside6)\b", "library", ""),
)

EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F]")
# "no filler" means no throat-clearing, not no contrast: only the opening and
# the stock phrases are checked, so a normal answer never trips it.
PREAMBLE = (
    "sure,", "sure!", "certainly", "of course", "great question", "good question",
    "that's a great", "that's a good", "i'd be happy to", "let's dive", "let us dive",
    "it's worth noting", "it is worth noting", "needless to say", "as an ai",
)
BUZZWORDS = (
    "paradigm", "leverage", "synergy", "holistic", "seamless", "best-in-class",
    "actionable", "circle back", "low-hanging fruit", "move the needle", "utilize",
)


def constraint_number(token):
    token = str(token or "").strip().lower()
    if token.isdigit():
        return int(token)
    return CONSTRAINT_NUMBERS.get(token)


def _length_rule(unit, value, bound):
    """Map "60 words" to a checkable rule. Units that cannot be counted are dropped."""
    unit = unit.rstrip("s").lower()
    if unit == "word":
        return ("max_words" if bound == "max" else "min_words", value)
    if unit == "sentence":
        return (("max_sentences" if bound == "max" else None), value)
    if unit == "line":
        return (("max_lines" if bound == "max" else None), value)
    if unit in ("bullet", "point", "item"):
        return ("max_bullets" if bound == "max" else "min_bullets", value)
    return (None, value)


def constraint_label(kind, value):
    if kind == "max_words":
        return "At most %d words" % value
    if kind == "min_words":
        return "At least %d words" % value
    if kind == "max_sentences":
        return "At most %d sentences" % value
    if kind == "max_lines":
        return "At most %d lines" % value
    if kind == "max_bullets":
        return "At most %d bullet points" % value
    if kind == "min_bullets":
        return "At least %d bullet points" % value
    if kind == "library":
        return "Use %s" % value
    return ""


def detect_constraints(text, scope=None):
    """The requirements in one user message, each with the scope it was stated in.

    Scope is what stops a passing remark from becoming a standing rule. "briefly"
    or "in 3 sentences" shaped the answer it was said in, so it comes back as
    scope "once": it is sent with that turn's question and then forgotten. Only
    wording that promises repetition ("from now on", "always", "every answer")
    is scope "standing" and reaches the register; /constraints add passes the
    scope in itself.

    Pattern-based on purpose: it costs nothing and must not add a call to every
    turn. Anything it misses can be added by hand with /constraints add.
    """
    low = re.sub(r"\s+", " ", str(text or "").lower())
    # Sentence by sentence, because "From now on keep it under 70 words. This
    # time, 300 words." states both scopes and one scope per message has to get
    # one of them wrong. ", but" starts a clause that may switch scope on its own.
    sentences = [
        part.strip()
        for part in re.split(r"(?<=[.!?;])\s+|,\s+but\s+", low)
        if part.strip()
    ]
    sentences = sentences or [low]
    # A standing phrase anywhere also covers the unmarked requirements beside it:
    # "from now on keep it under 70 words, and use bullets" states two rules.
    message_scope = "standing" if any(STANDING.search(part) for part in sentences) else "once"
    found, seen = [], set()

    def keep(kind, value=None, label=None, sentence=""):
        if not kind:
            return
        key = (kind, str(value) if value is not None else kind)
        if key in seen:
            return
        shown = label or constraint_label(kind, value)
        if not shown:
            return
        if scope:
            item_scope = scope
        elif ONE_OFF.search(sentence):
            item_scope = "once"
        elif STANDING.search(sentence):
            item_scope = "standing"
        else:
            item_scope = message_scope
        seen.add(key)
        found.append({"kind": kind, "value": value, "text": shown, "scope": item_scope})

    for sentence in sentences:
        for match in MAX_LENGTH.finditer(sentence):
            keep(
                *_length_rule(match.group(2), constraint_number(match.group(1)), "max"),
                sentence=sentence,
            )
        for match in MIN_LENGTH.finditer(sentence):
            keep(
                *_length_rule(match.group(2), constraint_number(match.group(1)), "min"),
                sentence=sentence,
            )
        for match in IN_LENGTH.finditer(sentence):
            # "in three sentences" is a ceiling on length; "in 40 words" too
            keep(
                *_length_rule(match.group(2), constraint_number(match.group(1)), "max"),
                sentence=sentence,
            )
        if re.search(r"\b(?:just|only|exactly|a single)\s+(?:one\s+)?sentence\b", sentence):
            keep("max_sentences", 1, sentence=sentence)
        if re.search(
            r"\b(?:brief(?:ly)?|concise(?:ly)?|terse|keep it short|in a nutshell|tl;?dr)\b",
            sentence,
        ):
            keep("max_words", 60, sentence=sentence)
        if re.search(
            r"\b(?:detailed|in depth|in-depth|thorough(?:ly)?|comprehensive|exhaustive|as much detail)\b",
            sentence,
        ):
            keep("min_words", 150, sentence=sentence)
        for pattern, kind, label in CONSTRAINT_RULES:
            match = re.search(pattern, sentence)
            if not match:
                continue
            if kind == "library":
                keep("library", match.group(1), "Use %s" % match.group(1), sentence=sentence)
            else:
                keep(kind, None, label, sentence=sentence)
    return found


def answer_words(text):
    return len(re.findall(r"[A-Za-z0-9']+", str(text or "")))


def answer_lines(text):
    return [line.strip() for line in str(text or "").splitlines() if line.strip()]


def answer_sentences(text):
    parts = re.split(r"(?<=[.!?])\s+|\n+", str(text or ""))
    return [part for part in parts if part.strip()]


def bullet_lines(text):
    """Lines that read as list items: a bullet, or a number followed by . or )"""
    return [
        line for line in answer_lines(text)
        if re.match(r"^(?:[-*\u2022\u2013]|\d+[.)])\s+\S", line)
    ]


def strip_fences(text):
    return "\n".join(
        line for line in str(text or "").splitlines() if not line.strip().startswith("```")
    )


def non_stdlib_imports(text):
    modules = set(getattr(sys, "stdlib_module_names", ()) or ())
    found = []
    for match in re.finditer(r"^\s*(?:import|from)\s+([A-Za-z_][\w.]*)", str(text or ""), re.M):
        top = match.group(1).split(".")[0]
        if modules and top not in modules:
            found.append(top)
    return found


def constraint_holds(item, answer):
    """True or False when the rule can be measured, None when it is a matter of tone.

    Only measurable rules are scored, so a compliance figure never counts a guess
    about "formal tone" as either a pass or a failure.
    """
    kind = str(item.get("kind") or "")
    value = item.get("value")
    text = str(answer or "")
    low = text.lower()
    try:
        if kind == "max_words":
            return answer_words(text) <= int(value)
        if kind == "min_words":
            return answer_words(text) >= int(value)
        if kind == "max_sentences":
            return len(answer_sentences(text)) <= int(value)
        if kind == "max_lines":
            return len(answer_lines(text)) <= int(value)
        if kind == "max_bullets":
            return len(bullet_lines(text)) <= int(value)
        if kind == "min_bullets":
            return len(bullet_lines(text)) >= int(value)
    except (TypeError, ValueError):
        return None
    if kind in ("list", "numbered"):
        # a reader accepts either shape for "use a list"
        return len(bullet_lines(text)) >= 2
    if kind == "no_list":
        return not bullet_lines(text)
    if kind == "no_table":
        return not any(line.count("|") >= 2 for line in answer_lines(text))
    if kind == "table":
        return any(line.count("|") >= 2 for line in answer_lines(text))
    if kind == "json":
        try:
            json.loads(strip_fences(text).strip())
            return True
        except (ValueError, TypeError):
            return False
    if kind == "no_emoji":
        return not EMOJI.search(text)
    if kind == "no_jargon":
        return not any(word in low for word in BUZZWORDS)
    if kind == "blunt":
        opening = answer_lines(text)[0].lower() if answer_lines(text) else ""
        return not any(low.startswith(phrase) or opening.startswith(phrase) for phrase in PREAMBLE)
    if kind == "library":
        return str(value).lower() in low
    if kind == "stdlib":
        return not non_stdlib_imports(text)
    if kind == "only_code":
        return "```" in text and answer_words(strip_fences(text)) < 25
    if kind == "tests":
        return any(marker in low for marker in ("assert ", "def test_", "unittest", "pytest"))
    return None


def constraint_report(items, answer):
    """Every rule against one answer, plus the measurable score."""
    rows = [(item, constraint_holds(item, answer)) for item in items]
    checked = sum(1 for _, ok in rows if ok is not None)
    held = sum(1 for _, ok in rows if ok is True)
    return {
        "rows": rows,
        "checked": checked,
        "held": held,
        "rate": (held / float(checked)) if checked else None,
    }


class Constraints:
    """The user's standing requirements, kept across turns and re-sent every turn.

    Only scope "standing" rules are filed here: a one-off remark is sent with its
    own turn and never seen again, so it cannot silently cap later answers.
    """

    LENGTH_KINDS = ("max_words", "min_words", "max_sentences", "max_lines", "max_bullets", "min_bullets")

    def __init__(self, path, limit=12):
        self.path = Path(path)
        self.limit = limit
        self.items = []
        self.load()

    def load(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            items = data.get("items") or []
        except (OSError, json.JSONDecodeError, AttributeError):
            items = []
        self.items = [item for item in items if isinstance(item, dict) and item.get("text")][-self.limit:]

    def save(self):
        try:
            self.path.write_text(
                json.dumps({"items": self.items}, ensure_ascii=False), encoding="utf-8"
            )
        except OSError as err:
            print("constraints save failed:", err)

    def add(self, item, turn=0):
        """Store one rule. True when the register changed.

        A restated length replaces the earlier number instead of sitting beside it:
        "under 60 words" followed by "actually under 30" must not leave both open.
        """
        kind = str(item.get("kind") or "")
        value = item.get("value")
        text = str(item.get("text") or "").strip()
        if not kind or not text:
            return False
        entry = {"kind": kind, "value": value, "text": text, "turn": turn}
        for index, existing in enumerate(self.items):
            if existing.get("kind") != kind:
                continue
            same_value = str(existing.get("value")) == str(value)
            if same_value and existing.get("text") == text:
                return False
            if same_value or kind in self.LENGTH_KINDS or kind == "library":
                self.items[index] = entry
                self.save()
                return True
        self.items.append(entry)
        if len(self.items) > self.limit:
            self.items = self.items[-self.limit:]
        self.save()
        return True

    def drop(self, number):
        try:
            index = int(number) - 1
        except (TypeError, ValueError):
            index = -1
        if 0 <= index < len(self.items):
            removed = self.items.pop(index)
            self.save()
            print("[dropped %d. %s]" % (index + 1, removed["text"]))
            return True
        print("usage: /constraints drop <number>   (numbers come from /constraints)")
        return False

    def clear(self):
        self.items = []
        self.save()

    def reminder(self):
        """The same list, short, for the message the model reads last."""
        if not self.items:
            return ""
        lines = ["Standing requirements that still apply to this answer:"]
        for index, item in enumerate(self.items, 1):
            lines.append("%d. %s." % (index, item["text"].rstrip(".")))
        return "\n".join(lines)

    def checklist(self):
        if not self.items:
            return ""
        lines = [
            "The user stated these requirements and they still apply to this reply. "
            "The numbers are fixed, so the user can change one by number:",
        ]
        for index, item in enumerate(self.items, 1):
            lines.append("%d. %s." % (index, item["text"].rstrip(".")))
        return "\n".join(lines)


def constraint_summary(rows):
    """Turn rows from one arm -> overall, early/late and per-rule compliance."""
    checked = sum(row["report"]["checked"] for row in rows)
    held = sum(row["report"]["held"] for row in rows)

    def slice_rate(pred):
        picked = [row for row in rows if pred(row["turn"])]
        total = sum(row["report"]["checked"] for row in picked)
        good = sum(row["report"]["held"] for row in picked)
        return (good / float(total)) if total else None

    rules = {}
    for row in rows:
        for item, ok in row["report"]["rows"]:
            if ok is None:
                continue
            tally = rules.setdefault(item["text"], [0, 0])
            tally[0] += 1
            tally[1] += 1 if ok else 0
    words = [row["words"] for row in rows] or [0]
    secs = [row["secs"] for row in rows] or [0.0]
    longest = max(row["turn"] for row in rows) if rows else 0
    return {
        "turns": len(rows),
        "checked": checked,
        "held": held,
        "rate": (held / float(checked)) if checked else None,
        "early": slice_rate(lambda turn: turn <= 10),
        "late": slice_rate(lambda turn: turn > max(10, longest - 10)),
        "rules": {name: (tally[1] / float(tally[0])) if tally[0] else None
                  for name, tally in rules.items()},
        "words": sum(words) / float(len(words)),
        "secs": sum(secs) / float(len(secs)),
    }


# 30 questions, fixed, so both arms of the bench answer exactly the same thing.
CONSTRAINT_BENCH_PROMPTS = (
    "What makes a mechanical keyboard feel different from a membrane one?",
    "How does a heat pump move heat instead of making it?",
    "Why does a cast iron pan need seasoning?",
    "How does a car's catalytic converter reduce pollution?",
    "What causes thunder after a lightning strike?",
    "How does sourdough starter raise bread without added yeast?",
    "What is the difference between a stock and a broth?",
    "How does noise cancelling work in headphones?",
    "Why do steel ships float?",
    "How does a refrigerator keep food cold?",
    "What makes an espresso shot taste sour or bitter?",
    "How does a solar panel turn light into electricity?",
    "What is the difference between cement and concrete?",
    "Why does bread go stale, and does the fridge help?",
    "How does a moving bicycle stay upright?",
    "What does a GPU do that a CPU does not?",
    "How do vaccines train the immune system?",
    "Why does salt melt ice on a road?",
    "How does a GPS receiver know where it is?",
    "What makes a diamond hard but brittle?",
    "How does a wood stove heat a room differently from a radiator?",
    "Why do some metals rust and others do not?",
    "How does a camera autofocus on a moving subject?",
    "What is the difference between a virus and a bacterium?",
    "Why does a bicycle pump warm up when inflating a tyre?",
    "Why does coffee taste different when brewed cold?",
    "How does a hard drive store data magnetically?",
    "What makes a bridge strong enough for trucks?",
    "How does the body cool itself in hot weather?",
    "What is the difference between AC and DC current?",
)

# Stated in the first six turns; all six stay in force for the rest of the run.
# These conflict with what a long-form answer does on its own, which is the
# point: a free rule (no emoji) cannot show whether a checklist works.
CONSTRAINT_BENCH_RULES = (
    "From now on keep every answer under 70 words.",
    "Also use bullet points in every answer from now on.",
    "Also keep every answer to at most 4 sentences.",
    "Also write every answer in plain English, no jargon.",
    "Also be blunt in every answer: no filler, no preamble.",
    "Also never use a table in any answer.",
)


# --------------------------------------------------------------------------- #
# [plan] a per-turn checklist, ticked off as the answer covers it
# --------------------------------------------------------------------------- #
# A long answer drifts: the model writes the first three things that come to mind
# and stops, so the fourth part of the question is silently missing. This layer
# asks for the checklist as soon as the answer is on screen - the model marks
# each step COVERED or MISSING itself - and appends only what is missing: notes
# first (free), then at most a fixed number of model passes, then one thinking
# review - and none of that past plan_budget. By default only the assess call runs.
# It never delays the answer: Lanes makes an interactive call wait for any
# running background call to drain, so a checklist call placed before the stream
# would queue the answer behind it. Nothing is stored and there is no command: the
# list belongs to one turn, which is why it cannot become another standing rule.
PLAN_LINE = re.compile(r"^\s*(?:[-*\u2022]|\d+[.)])\s+(.+\S)\s*$", re.M)
PLAN_STOPWORDS = frozenset(
    """a an the and or but if then than that this these those of in on at to for from with
    without into over under about as is are was were be been being it its their there here
    what which who how why when where do does did can could should would will you your we our
    they them he she his her not no nor so such very just also more most less least other
    another same own only too each every any all some few many much both either neither""".split()
)
PLAN_SYSTEM = (
    "List the things a complete answer must cover. One per line, numbered, at most 5 lines, "
    "each ending with COVERED or MISSING for the answer you were given. No introduction, "
    "no explanation, no closing line."
)
# Unambiguous on purpose: "how it is done" must not read as a finished step.
PLAN_MARKS = (
    ("not covered", False),
    ("missing", False),
    ("absent", False),
    ("todo", False),
    ("covered", True),
)


def plan_marks(text, limit=6):
    """The checklist, each step with the model's own COVERED/MISSING mark.

    Returns [(step, True/False/None)]: None means the line carried no mark, and the
    caller scores that step locally instead of guessing.
    """
    rows, seen = [], set()
    for match in PLAN_LINE.finditer(str(text or "")):
        step = match.group(1).strip(" .:;-*[]()")
        done = None
        low = step.lower()
        for word, flag in PLAN_MARKS:
            if word in low:
                done = flag
                step = re.sub(
                    r"[\[(]?\s*" + re.escape(word) + r"\s*[\])]?", "", step, flags=re.I
                )
                break
        step = step.strip(" .:;-*[]()")
        if len(step.split()) < 2:
            continue
        key = re.sub(r"[^a-z0-9 ]+", " ", step.lower()).strip()
        if key in seen:
            continue
        seen.add(key)
        rows.append((step[:120], done))
    return rows[:limit]


def plan_steps(text, limit=6):
    """Just the steps, without the marks."""
    return [step for step, _ok in plan_marks(text, limit)]


def step_words(step):
    """The words of a step that a lookup can actually look for."""
    return [
        word for word in re.findall(r"[a-z0-9']{3,}", str(step or "").lower())
        if word not in PLAN_STOPWORDS
    ]


def step_covered(step, answer, share=0.6):
    """True when the answer already says something about this step.

    Local and deterministic: scoring a checklist with a model call per step would
    cost more than the answer it is checking. Words match on a six-letter stem, so
    "heat" and "heating" count together.
    """
    words = step_words(step)
    if not words:
        return True
    low = str(answer or "").lower()
    hits = sum(1 for word in words if word[:6] in low)
    return hits >= max(1, int(math.ceil(len(words) * share)))


def plan_summary(rows):
    missing = [step for step, ok in rows if not ok]
    return {"rows": rows, "done": len(rows) - len(missing), "total": len(rows), "missing": missing}


def plan_report(steps, answer):
    """The same summary, scored locally against one answer."""
    return plan_summary([(step, step_covered(step, answer)) for step in steps])


class Chat:
    def __init__(self, client, cache, notes, telemetry, use_draft=DEFAULT_DRAFT):
        self.client = client
        self.cache = cache
        self.notes = notes
        self.telemetry = telemetry
        self.use_draft = use_draft
        self.history = []
        self.summary = ""
        self.last_prompt = ""
        self.last_answer = ""
        # /think controls when a separate reasoning pass runs: auto decides from
        # the question, on forces it, off never runs it. Simple questions stay one
        # call so speed is not spent on thinking they do not need.
        self.think_mode = str(setting("think_mode", "auto"))
        self.state_path = Path(STATE) / "chat_state.json"
        self.code_path = Path(STATE) / "chat_code.json"
        self.reward_path = Path(STATE) / "chat_rewards.json"
        self.code = self.load_code()
        self.rewards = self.load_rewards()
        self.code_streamed_text = ""
        self.last_image = ""
        self._told_sandbox = False
        # The memory is the part that makes turn two continue turn one: recent
        # turns go verbatim, older ones as retrieved chunks.
        self.memory = Memory(
            Path(STATE) / "chat_memory.json", limit=setting("memory_turns", 40, int)
        )
        self.turns_window = max(1, setting("memory_window", 4, int))
        # Tokens, not turns, bound the verbatim window; the count above stays as a
        # hard cap so a burst of tiny turns cannot flood the prompt either.
        self.window_tokens = max(120, setting("memory_window_tokens", 300, int))
        # Layers: 1 shows the first answer (fastest). Each extra layer is one
        # critique call plus one rewrite call for the same answer.
        self.layers = max(1, setting("layers", 1, int))
        # /fast skips memory assembly entirely: the plain single call, kept so
        # the slow path can be measured against the fast one on this machine.
        self.fast_mode = as_bool("fast_mode", False)
        self.auto_goal = True
        self.last_intent = ""
        self.goal_reported = False
        self.peer_answer = ""
        self.preplies = Preplies(Path(STATE) / "chat_preplies.json")
        self.vision_cache = self._load_vision_cache()
        # A separate answer from the model's own point of view, off by default
        # so the normal reply stays one call.
        self.viewpoint = as_bool("viewpoint", False)
        # How many independent reads of one image measure its consistency.
        self.vision_samples = max(1, setting("vision_samples", 2, int))
        self.store = Store(Path(STATE) / "chat_store.db")
        # Opt-in parallel image calls: the default is sequential because two
        # calls at once measured 2794 ms against 579 ms for one combined call.
        self.parallel = as_bool("parallel", False)
        self.autonote = as_bool("autonote", True)
        self.long_mode = as_bool("long_form", False)
        # The extension hooks three points in a turn: after_answer, the recall
        # fallback and the parallel worker count. All settings come from
        # fast_chat_ext.SETTINGS via setting(), so there is one place to edit.
        self.ext = EXT if (EXT is not None and getattr(EXT, "ENABLED", False)) else None
        # /constraints: a requirement stated once is re-sent as a numbered
        # checklist on every turn, so turn twenty still knows about turn one.
        self.constraints = Constraints(Path(STATE) / "chat_constraints.json")
        self.constraint_inject = as_bool("constraints", True)
        # Measured: the system prompt alone was ignored once the session had
        # history, so the same list is repeated next to the question too.
        self.constraint_recency = as_bool("constraint_recency", True)
        self.last_constraint_report = {}
        # The rules this turn stated without promising they would last. They are
        # sent with this question and replaced on the next turn, never stored.
        self.turn_constraints = []
        # [plan] per-turn checklist: asked in the background, ticked off locally,
        # appended to but never stored, so there is nothing to switch on or clear.
        # "auto" keeps the call off the one-line questions that have nothing to tick.
        self.plan_mode = str(setting("plan_mode", "auto")).lower()
        # Cheap by default: the assess call and nothing else. Two appends plus a
        # thinking review made four extra model calls on every 14+ word prompt;
        # set plan_appends: 2 and plan_review: true to get that pass back.
        self.plan_appends = max(0, setting("plan_appends", 0, int))
        self.plan_review = as_bool("plan_review", False)
        self.plan_think = as_bool("plan_think", True)
        self.plan_budget = max(0.0, setting("plan_budget", PLAN_BUDGET, float))
        self.last_plan = {}
        self.load_state()

    # -- durable conversation state --------------------------------------- #
    def load_state(self):
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
            self.history = data.get("history") or []
            self.summary = data.get("summary") or ""
        except (OSError, json.JSONDecodeError):
            pass

    def save_state(self):
        try:
            self.state_path.write_text(
                json.dumps({"history": self.history[-400:], "summary": self.summary}), encoding="utf-8"
            )
        except OSError as err:
            print("state save failed:", err)

    # -- [Q3] follow-up resolution ---------------------------------------- #
    def expand(self, prompt):
        text = prompt.strip()
        low = text.lower()
        # An exact repeat is a repeat, not a follow-up: expanding it would both
        # miss the cache and hand the model a confusing question.
        if not self.last_prompt or low == self.last_prompt.lower():
            return text
        short = len(text.split()) <= 6 or any(low.startswith(f) for f in FOLLOWUPS)
        if not short:
            return text
        previous = (self.last_answer or "").strip()[:1400]
        return (
            "Earlier question: %s\n\nEarlier answer: %s\n\nFollow-up: %s\n\n"
            "Continue from the earlier answer and expand on it: keep every fact in it that "
            "was correct, add the facts, examples or detail the follow-up asks for, correct "
            "anything that was wrong, and follow any instruction in the follow-up. Give the "
            "complete answer rather than a summary of the earlier one."
            % (self.last_prompt, previous, text)
        )

    # -- [Q4][Q5] context assembly ---------------------------------------- #
    def context_for(self, prompt):
        parts = []
        if self.fast_mode:
            return ""
        packed = self.memory.pack(prompt, skip_turns=self.turns_window)
        if packed:
            parts.append(packed)
        if self.summary:
            parts.append("Earlier conversation: " + self.summary)
        key = re.sub(r"\s+", " ", str(prompt).strip().lower())[:80]
        for item in self.notes.search(prompt, limit=5):
            # Never hand the model its own answer to this exact question: it
            # reproduces it verbatim, which is why /vary looked like a no-op.
            same_question = re.sub(r"\s+", " ", item.get("title", "").strip().lower()) == key
            if same_question and item.get("kind") in ("qa", "variants"):
                continue
            parts.append("[%s] %s" % (item["title"], item["text"][:900]))
        return "\n\n".join(parts)[:4500]

    def messages_for(self, prompt, context, extra_system="", long=False, window_tokens=None):
        system = LONG_SYSTEM if long else SYSTEM
        if context:
            system += "\n\nUse this context when it is relevant; ignore it otherwise:\n" + context
        if extra_system:
            system += "\n\n" + extra_system
        # Last in the system prompt: on a small model the most recent instruction
        # is the one that survives a long answer.
        checklist = self.constraints.checklist() if self.constraint_inject else ""
        if checklist:
            system += "\n\n" + checklist
        messages = [{"role": "system", "content": system}]
        # A change of subject gets NO verbatim turns: feeding the previous answer
        # made the model clone its wording. Explicit now, so /ab and /research do
        # not inherit the window from an unrelated ask(). The budget, not a turn
        # count, decides how much of the recent history is spent verbatim.
        messages.extend(
            self.memory.window(
                self.window_tokens if window_tokens is None else window_tokens,
                drop_last="Earlier answer:" in prompt,
                max_turns=self.turns_window,
            )
        )
        messages.append({"role": "user", "content": prompt})
        # The checklist was in a system prompt that is now two hundred words back;
        # the model's own last answer is much closer, so the same numbered list is
        # repeated here, after the question. Same numbers, no extra call.
        if self.constraint_inject and self.constraint_recency:
            reminder = self.constraints.reminder()
            if reminder:
                messages[-1]["content"] = prompt + "\n\n" + reminder
        # Sent whatever the checklist setting says: this is not the register, it is
        # the user's instruction for this one answer, and it is gone next turn.
        one_off = self.one_off_reminder()
        if one_off:
            messages[-1]["content"] = messages[-1]["content"] + "\n\n" + one_off
        return messages

    # -- answering --------------------------------------------------------- #
    def ask(self, prompt):
        raw = prompt.strip()
        if not raw:
            return ""
        self.last_plan = {}
        # Before the answer, not after: a requirement in this turn applies to the
        # reply being written now and to every reply after it.
        self.capture_constraints(raw)
        intent = classify_intent(raw, self.last_prompt, self.last_answer)
        self.last_intent = intent
        # No follow-up expansion when the subject changed: it only made the
        # question long enough to trigger the reasoning pass for free.
        prompt = raw if intent == "new" else self.expand(raw)
        memory_note = self.memory_instruction(intent, prompt)
        # Cache on the question alone. Folding the retrieved context into the key
        # missed every repeat, because answering adds a note that changes it.
        cache_key = prompt

        # A repeat inside the cooldown window is answered fresh. The earlier text
        # is handed to the model as a draft to improve, never replayed verbatim.
        min_gap = setting("cache_min_turns", 10, int)
        turn_now = self.turn_number()
        hit = self.cache.get(cache_key, turn=turn_now, min_gap=min_gap)
        stale = None
        if hit and rambles(hit[0]):
            hit, stale = None, hit[0]
        if hit:
            answer, score = hit
            label = "AI (cached)" if score >= 1.0 else "AI (cached %.0f%% similar)" % (score * 100)
            print("%s: %s" % (label, answer))
            self.telemetry.record(kind="answer", model="cache", ms=0.0, ttft_ms=0.0, cache_score=round(score, 3))
            self.remember(raw, answer)
            return answer
        # Assembled only after the cache misses: a hit returns before this work.
        context = self.context_for(prompt)
        if stale is None:
            stale = self.cache.recent(cache_key)
        if stale:
            memory_note = (memory_note + "\n\n" + self.rework_instruction(stale)).strip()
        code_hint = self.code_context(raw)
        if code_hint:
            memory_note = (memory_note + "\n\n" + code_hint).strip()
        # Coding requests go straight to the code model: the prose pass wrote a
        # streamed paragraph that was then thrown away, doubling the wait.
        script = ""
        # "improve on the app" is a request for the next script, not for advice.
        code_intent = wants_code(raw) or (bool(self.code) and code_followup(raw))
        if code_intent and not self.long_mode:
            intro, script, shown = self.code_reply(prompt, context, memory_note if code_followup(raw) else "")
            if intro and not shown:
                print("AI: %s" % intro)
            if script:
                if not shown:
                    print("AI (script): %s" % script)
                if not script_ok(script, "python" in raw.lower()):
                    print("[script may be incomplete - check it before running]")
                if shown and script.strip() and script.strip() not in (self.code_streamed_text or ""):
                    # The streamed attempt failed validation; show the one that passed.
                    print("AI (final script):")
                    print(script)
            else:
                print("[no script from the code model - answering normally]")

        # The same question twice gets the same greedy answer; a fresh seed and a
        # warmer temperature are what actually make the second reply differ.
        repeat_prompt = bool(self.last_prompt) and raw.lower() == str(self.last_prompt).lower().strip()
        sampling = None
        if repeat_prompt:
            sampling = dict(SAMPLING)
            sampling["seed"] = random.randint(1, 10 ** 9)
            sampling["temperature"] = min(1.0, float(sampling.get("temperature", 0.7)) + 0.15)
        turn_window = 0 if intent == "new" else self.window_tokens
        budget = setting("context_budget", 3000, int)
        messages = fit_messages(
            self.messages_for(prompt, context, memory_note, long=self.long_mode, window_tokens=turn_window),
            budget,
            verbose=True,
        )

        def on_thinking(_piece, _result):
            pass

        reasoning = ""
        if not script and self.wants_reasoning(prompt):
            reasoning = self.reason(prompt, context)
            if reasoning:
                context = (context + "\n\nReasoning already done for this question:\n" + reasoning[:1800]).strip()
                messages = fit_messages(
                    self.messages_for(prompt, context, memory_note, long=self.long_mode, window_tokens=turn_window),
                    budget,
                )

        result = None
        text = script
        retried = False
        while not text:
            writer = Writer()
            guard = LoopGuard()
            pieces = []

            def on_token(piece, _result, _pieces=pieces, _writer=writer):
                _pieces.append(piece)
                _writer.write(piece)

            writer.start("AI: ")
            try:
                result = self.client.ask(
                    messages,
                    on_token=on_token,
                    on_thinking=on_thinking,
                    guard=guard,
                    max_tokens=setting("long_max_tokens", 1200, int) if self.long_mode else MAX_TOKENS,
                    sampling=sampling,
                )
                writer.end()
                text = result["text"].strip()
                break
            except DegenerateOutput:
                text, result = self.recover_from_loop(writer, pieces, prompt, context, reasoning)
                break
            except Exception as err:  # noqa: BLE001
                writer.end()
                # The estimate can still be wrong (a server with a smaller window
                # than configured): drop a turn and retry once with half the budget.
                if not retried and "context" in str(err).lower() and len(messages) > 2:
                    retried = True
                    messages = fit_messages(
                        messages, max(600, int(budget * 0.5)), force_drop=1, verbose=True
                    )
                    print("[request was too large - retried with %d message(s)]" % len(messages))
                    continue
                print("request failed:", err)
                return ""

        if not text:
            print("(empty response - try /think on to see the reasoning)")
            return ""
        extended = False
        if not self.fast_mode:
            # Two stages after the first answer: add what was missing, then
            # rewrite it as many times as /layers asks for.
            before_extend = text
            text = self.extend_if_repetitive(prompt, text, context, intent)
            # The repetition fixup already added new material. Asking for a
            # different angle now would replace it and cost another full call.
            extended = text != before_extend
            if self.layers > 1:
                text = self.refine(raw, text, context, self.layers)
        # A long-form answer, or a list the user asked for, is not a rambling failure.
        if code_intent and not has_code_block(text):
            # A prose answer to a coding request is the failure the user notices most.
            print("[no code in that answer - asking for a script]")
            intro, better, _shown = self.code_reply(prompt, context, memory_note)
            if intro:
                print("AI: %s" % intro)
            if better and has_code_block(better):
                text = better
                # The prose above was already streamed; the script has to be shown.
                print("AI (script): %s" % text)
                if not script_ok(text, "python" in raw.lower()):
                    print("[script may be incomplete - check it before running]")
            else:
                print("[the model would not return a script - showing its prose answer]")
        problem = None if (self.long_mode or wants_list(raw) or has_code_block(text)) else rambles(text)
        if problem:
            # A model rewrite cost a second (sometimes third) call worth seconds on
            # every rambling answer. Trim locally instead: the text stays the
            # model's own and the reply cannot run on into a wall of words.
            before = len(text)
            text = tidy_answer(text, setting("tidy_chars", 900, int))
            print("[answer was %s - trimmed %d -> %d chars]" % (problem, before, len(text)))
        # Same question, same answer: ask for a different one instead of repeating it.
        if not extended and len(text.split()) >= 15 and near_duplicate(text, self.last_answer):
            print("[that repeats the last answer - asking for a different angle]")
            alt = self.different_answer(prompt, context, text)
            if alt:
                text = alt
                print("AI (variant): %s" % text)
        # A reply cut off mid-sentence is missing content: keep appending chunks until
        # it ends properly, then set anything past the preply threshold aside.
        rounds = 0
        added = 0
        max_rounds = setting("append_rounds", 3, int)
        limit_chars = setting("long_limit", 6000, int)
        budget = setting("append_budget", 1200, int)
        while (
            not self.fast_mode
            and not has_code_block(text)
            and wants_continuation(text)
            and not rambles(text)
            and len(text) < limit_chars
            and added < budget
            and rounds < max_rounds
        ):
            rounds += 1
            # Stream the tail: the turn used to sit silent through a second full
            # request right after the first answer had already arrived.
            writer = Writer()
            pieces = []

            def on_chunk(piece, _result, _writer=writer, _pieces=pieces):
                _pieces.append(piece)
                _writer.write(piece)

            writer.start("AI (+chunk %d): " % rounds)
            more = self.append_answer(prompt, text, on_token=on_chunk)
            writer.end()
            if not more:
                if pieces:
                    print("[dropped that tail - it repeated the answer]")
                break
            added += len(more)
            text = text.rstrip() + " " + more
        # [plan] After the answer, never in front of it: the checklist call and
        # every gap it fills are appended to an answer the user can already read.
        if self.wants_plan(raw) and text and not has_code_block(text):
            text = self.plan_turn(raw, text, context)
        if len(text) > PREPLY_THRESHOLD:
            self.stash(text, raw[:60])
        reward = score_answer(text, raw, context, sentences_of(self.last_answer) if self.last_answer else [])
        self.rewards.append(
            {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "total": reward["total"], "q": raw[:80]}
        )
        del self.rewards[:-200]
        self.save_rewards()
        if reward["total"] < 0.5:
            print(
                "[reward %.2f: novelty %.2f | grounded %.2f | clean %.2f]"
                % (reward["total"], reward["novelty"], reward["grounded"], reward["clean"])
            )
        self.remember_code(raw, text)
        self.cache.put(
            cache_key, text, result["model"] if result else MODEL, turn=turn_now, reward=reward["total"]
        )
        self.notes.add("qa", raw[:80], text, tags="answer")
        self.remember(raw, text)
        self.track_goal(raw, text)
        if self.viewpoint and not self.fast_mode:
            self._viewpoint(raw, text)
        if self.autonote and not self.fast_mode:
            # Off the prompt path: this is an extra model call nobody waits for.
            self.background(self.auto_note, raw, text, quiet=True)
        if self.ext is not None:
            try:
                self.ext.after_answer(self, raw, text, intent)
            except Exception as err:  # noqa: BLE001
                print("[ext after_answer failed: %s]" % err)
        self.memory.log("answer", intent=intent, layers=self.layers, fast=self.fast_mode, chars=len(text))
        self.telemetry.record(
            kind="answer",
            model=result["model"] if result else MODEL,
            ms=round(result["total_ms"], 1) if result else None,
            ttft_ms=round(result["ttft_ms"], 1) if result else None,
            tps=result["tps"] if result else None,
            chars=len(text),
            context_chars=len(context),
        )
        self.background(self.maybe_summarize)
        return text

    # -- what this turn is asking for --------------------------------------- #
    def memory_instruction(self, intent, prompt):
        previous = (self.last_answer or "").strip()
        lines = []
        if self.memory.goal:
            lines.append("The user's standing goal is: %s" % self.memory.goal[:300])
        if intent in ("extend", "deeper", "list") and previous:
            lines.append(
                "This turn continues the previous answer. Do not repeat any sentence from it. "
                "Continue from where it stopped, extend it with new facts, and stay on the subject."
            )
        elif intent == "contrast" and previous:
            lines.append(
                "Compare and contrast this with what was said before, then combine the best of both "
                "into one answer: where they agree, where they differ, and the combined conclusion."
            )
        elif intent == "simpler" and previous:
            lines.append("Restate the previous answer more simply and more briefly. No new facts, no jargon.")
        elif intent == "repeat" and previous:
            lines.append(
                "The user asked the same thing again. Give a different and better answer: new wording, "
                "new detail, or the next step. Never reproduce the previous answer."
            )
        elif intent == "new" and previous:
            lines.append("The subject changed: answer only the new question, ignore the previous subject.")
        if intent == "list":
            lines.append("Answer as a numbered list, one idea per line.")
        return "\n".join(lines)

    # -- if the answer only restates what was said, fetch the missing part --- #
    def extend_if_repetitive(self, prompt, text, context, intent):
        seen = self.memory.emitted_sentences()
        if not seen or intent == "repeat":
            return text
        fresh = novelty(text, seen)
        if fresh >= 0.6:
            return text
        print("[%.0f%% of that was already said - asking only for the missing part]" % ((1 - fresh) * 100))
        instruction = (
            "You already told the user this:\n%s\n\nThey asked: %s\n\nAdd only what is missing: "
            "new facts, examples, numbers, or the next step. Do not repeat any sentence above."
            % ("\n".join("- " + sentence for sentence in seen[-8:]), prompt)
        )
        try:
            more = self.client.complete(
                self.messages_for(prompt, context, instruction),
                max_tokens=MAX_TOKENS,
                sampling={"temperature": 0.5, "repeat_penalty": 1.2},
                kind="extend",
            )
        except Exception:  # noqa: BLE001
            return text
        more = str(more).strip()
        if not more or novelty(more, seen) < 0.4:
            return text
        print("[extended with %d new chars]" % len(more))
        print(more)
        return text.rstrip() + "\n\n" + more

    # -- layers: critique, then rewrite, stopping when nothing changes ------ #
    def refine(self, question, answer, context, layers):
        text = answer
        for layer in range(2, layers + 1):
            try:
                critique = self.client.complete(
                    [
                        {
                            "role": "system",
                            "content": (
                                "List only what is wrong or missing in this answer: factual errors first, "
                                "then missing facts. One line each, no praise. If it is correct and "
                                "complete, reply exactly OK."
                            ),
                        },
                        {"role": "user", "content": question + "\n\nAnswer:\n" + text[:1600]},
                    ],
                    max_tokens=220,
                    sampling={"temperature": 0.2},
                    kind="critique",
                )
            except Exception as err:  # noqa: BLE001
                print("[layer %d: critique failed: %s]" % (layer, err))
                break
            notes = str(critique).strip()
            if not notes or notes.upper().startswith("OK"):
                print("[layer %d: no errors found, stopped early]" % layer)
                break
            messages = self.messages_for(question, context)
            messages.append({"role": "assistant", "content": text[:1600]})
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Apply this review and rewrite the answer: fix every error, add what is missing, "
                        "keep it the same length or shorter, no preamble, never repeat a sentence.\n\n"
                        + notes[:900]
                    ),
                }
            )
            try:
                rewritten = self.client.complete(
                    messages,
                    max_tokens=MAX_TOKENS,
                    sampling={"temperature": 0.3, "repeat_penalty": 1.25},
                    kind="layer-rewrite",
                )
            except Exception as err:  # noqa: BLE001
                print("[layer %d: rewrite failed: %s]" % (layer, err))
                break
            new_text = str(rewritten).strip()
            if not new_text:
                break
            change = SequenceMatcher(None, text.lower(), new_text.lower()).ratio()
            text = new_text
            print("[layer %d: %.0f%% changed]" % (layer, (1.0 - change) * 100))
            if change > 0.97:
                print("[layer %d: rewrite was identical, stopped]" % layer)
                break
        print("[final after %d layer(s)]" % self.layers)
        print(text)
        return text

    # -- goal: auto-created from the first real question, then tracked ----- #
    def track_goal(self, prompt, answer):
        if self.auto_goal and not self.memory.goal and len(str(prompt).split()) >= 3:
            self.memory.goal = str(prompt).strip()[:300]
            self.memory.save()
            print("[goal set from your first question: %s]" % self.memory.goal[:90])
        if not self.memory.goal or self.goal_reported or len(self.memory.turns) < 3:
            return
        progress = self.memory.goal_progress()
        if progress >= 0.85:
            self.goal_reported = True
            print(
                "[goal looks covered (%.0f%% of its words in recent answers) - /goal clear to move on]"
                % (progress * 100)
            )

    # -- named sessions: save and restore a whole conversation -------------- #
    def _sessions_dir(self):
        path = Path(STATE) / "sessions"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def save_session(self, name):
        raw = str(name or "").strip()
        if not raw:
            raw = time.strftime("session-%Y%m%d-%H%M%S")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,60}", raw):
            print("name it with letters, numbers, dash or underscore")
            return
        payload = {
            "history": self.history,
            "summary": self.summary,
            "goal": self.memory.goal,
            "turns": self.memory.turns,
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        try:
            (self._sessions_dir() / (raw + ".json")).write_text(json.dumps(payload), encoding="utf-8")
        except OSError as err:
            print("save failed:", err)
            return
        print("saved %d turn(s) as session '%s'" % (len(self.memory.turns), raw))

    def load_session(self, name):
        raw = str(name or "").strip()
        try:
            payload = json.loads((self._sessions_dir() / (raw + ".json")).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            print("no session named '%s' (/sessions lists them)" % raw)
            return
        self.history = payload.get("history") or []
        self.summary = payload.get("summary") or ""
        self.memory.turns = payload.get("turns") or []
        self.memory.goal = payload.get("goal") or ""
        self.memory.rebuild()
        self.memory.save()
        self.save_state()
        self.goal_reported = False
        if self.memory.turns:
            last = self.memory.turns[-1]
            self.last_prompt = last.get("user", "")
            self.last_answer = last.get("answer", "")
        print(
            "loaded session '%s': %d turn(s)%s"
            % (raw, len(self.memory.turns), (" from " + payload["saved_at"]) if payload.get("saved_at") else "")
        )

    def list_sessions(self):
        files = sorted(self._sessions_dir().glob("*.json"))
        if not files:
            print("no saved sessions (/save <name> makes one)")
            return
        for path in files[-15:]:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                print(
                    "  %-24s %3d turn(s)  %s"
                    % (path.stem, len(payload.get("turns") or []), payload.get("saved_at", ""))
                )
            except (OSError, json.JSONDecodeError):
                print("  %-24s (unreadable)" % path.stem)

    def _vision_cache_path(self):
        return Path(STATE) / "chat_vision.json"

    def _load_vision_cache(self):
        try:
            data = json.loads(self._vision_cache_path().read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_vision_cache(self):
        try:
            self._vision_cache_path().write_text(json.dumps(self.vision_cache), encoding="utf-8")
        except OSError:
            pass

    def show_memory(self):
        print(
            "turns: %d | chunks: %d | window: %d turns / %d tokens verbatim"
            % (len(self.memory.turns), len(self.memory.chunks), self.turns_window, self.window_tokens)
        )
        print("goal: %s" % (self.memory.goal or "(none)"))
        print("layers: %d | fast mode: %s | last intent: %s" % (self.layers, "on" if self.fast_mode else "off", self.last_intent or "-"))
        for turn in self.memory.turns[-5:]:
            print("  #%d %s" % (turn["n"], turn["user"][:70]))
            print("      -> %s" % turn["answer"][:90].replace("\n", " "))
        if self.memory.chunks:
            print("  sample chunk: %s" % self.memory.chunks[-1]["text"][:110])

    # -- peer: an independent second answer, then adopt or merge ------------ #
    def peer(self, argument=""):
        argument = argument.strip()
        if argument.lower() in ("keep", "merge") and not self.peer_answer:
            print("no peer answer yet - run /peer first")
            return
        if argument.lower() == "keep" and self.peer_answer:
            self.last_answer = self.peer_answer
            print("adopted the peer answer")
            Writer().answer(self.peer_answer)
            return
        if argument.lower() == "merge" and self.peer_answer and self.last_answer:
            merged = self.client.complete(
                [
                    {
                        "role": "system",
                        "content": (
                            "Combine these two answers into one: keep every fact both agree on, "
                            "resolve contradictions, drop repetition. At most four sentences, no preamble."
                        ),
                    },
                    {"role": "user", "content": "A: %s\n\nB: %s" % (self.last_answer[:1200], self.peer_answer[:1200])},
                ],
                max_tokens=MAX_TOKENS,
                sampling={"temperature": 0.3},
                kind="peer-merge",
            )
            merged = str(merged).strip()
            if merged:
                self.last_answer = merged
                self.memory.add(self.last_prompt, merged)
                Writer().answer(merged)
            return
        question = (argument or self.last_prompt).strip()
        if not question:
            print("ask something first")
            return
        their = self.client.complete(
            [
                {"role": "system", "content": "Answer independently and factually in at most four sentences. No preamble."},
                {"role": "user", "content": question},
            ],
            max_tokens=MAX_TOKENS,
            sampling={"temperature": 0.7},
            kind="peer",
        )
        their = str(their).strip()
        self.peer_answer = their
        ours = (self.last_answer or "").strip()
        print("\npeer: " + (their[:400] or "(empty)"))
        if ours:
            print("ours: " + ours[:400])
            print(
                "similarity %.2f | /peer keep to adopt, /peer merge to combine"
                % SequenceMatcher(None, ours.lower(), their.lower()).ratio()
            )
        if their:
            self.notes.add("peer", question[:80], their, tags="peer")

    # -- what the memory actually costs on the wire ------------------------- #
    def compare_memory(self, question=""):
        question = (question or "why is the sky blue").strip()
        saved = self.fast_mode
        self.last_intent = "new"
        self.fast_mode = True
        plain = []
        try:
            for _ in range(2):
                started = now_ms()
                self.client.ask(self.messages_for(question, ""), max_tokens=MAX_TOKENS, kind="mem-plain")
                plain.append(now_ms() - started)
        except Exception as err:  # noqa: BLE001
            self.fast_mode = saved
            print("plain call failed:", err)
            return
        self.fast_mode = saved
        self.last_intent = classify_intent(question, self.last_prompt, self.last_answer)
        packed = self.context_for(question)
        instruction = self.memory_instruction(self.last_intent, question)
        full = []
        try:
            for _ in range(2):
                started = now_ms()
                self.client.ask(
                    self.messages_for(question, packed, instruction), max_tokens=MAX_TOKENS, kind="mem-full"
                )
                full.append(now_ms() - started)
        except Exception as err:  # noqa: BLE001
            print("memory call failed:", err)
            return
        plain_ms, full_ms = min(plain), min(full)
        print("plain one call      %6.0f ms   (best of 2: %s)" % (plain_ms, [round(v) for v in plain]))
        print(
            "memory + directive  %6.0f ms   (best of 2: %s, %d chars of memory)"
            % (full_ms, [round(v) for v in full], len(packed))
        )
        print("memory costs %+.0f ms on this machine" % (full_ms - plain_ms))
        self.notes.add(
            "bench", "memory cost", "plain %.0f ms, memory %.0f ms" % (plain_ms, full_ms), tags="bench"
        )

    # -- /hard: the strict review, run on the last answer ------------------- #
    def hard_review(self):
        if not self.last_answer:
            print("no answer to review yet")
            return
        self.layers = max(self.layers, 2)
        self.refine(self.last_prompt, self.last_answer, self.context_for(self.last_prompt), 2)

    # -- the loop fallback, named and separated from the happy path --------- #
    def recover_from_loop(self, writer, pieces, prompt, context, reasoning=""):
        """A looping stream was cut: replace it with a clean answer.

        Returns (text, None): no single stream produced this text.
        """
        writer.end()
        partial = "".join(pieces).strip()
        writer.status("[repetition after %d chars - sampling alternatives in one call]" % len(partial))
        picked, others = self.best_of(prompt, context, reasoning=reasoning)
        if picked:
            writer.answer(picked)
            writer.status("[replaced the looping answer with the best of %d samples]" % (len(others) + 1))
            return picked, None
        text = self.revise(prompt, partial, context)
        if text:
            writer.answer(text)
        return text, None

    # -- reasoning pass ----------------------------------------------------- #
    def wants_reasoning(self, prompt):
        # /fast means one call: no memory assembly and no separate reasoning pass.
        if self.fast_mode:
            return False
        if self.think_mode == "on":
            return True
        if self.think_mode == "off":
            return False
        low = str(prompt).lower()
        return len(str(prompt)) > 90 or any(
            key in low for key in ("why", "how", "compare", "difference", "explain", "step", "plan", "calculate", "prove")
        )

    def reason(self, prompt, context=""):
        pieces = []
        try:
            result = self.client.ask(
                self.messages_for(prompt, context),
                max_tokens=400,
                on_thinking=lambda piece, _r: pieces.append(piece),
                kind="reasoning",
                think=True,
                stop_when_answered=True,
            )
        except Exception as err:  # noqa: BLE001
            print("[reasoning pass failed: %s]" % err)
            return ""
        reasoning = "".join(pieces).strip()
        if reasoning:
            self.notes.add("reasoning", prompt[:80], reasoning, tags="thinking")
            print("[reasoned %d chars - saved to notes]" % len(reasoning))
        elif result["text"].strip():
            self.notes.add("reasoning", prompt[:80], result["text"].strip(), tags="thinking")
        else:
            print("[the model produced no reasoning]")
        return reasoning

    def background(self, fn, *args, **kwargs):
        """Run an auxiliary model call without holding up the prompt."""
        threads = getattr(self, "_background_threads", None)
        if threads is None:
            threads = self._background_threads = []

        def run():
            try:
                fn(*args, **kwargs)
            except Exception as err:  # noqa: BLE001
                print("[background %s failed: %s]" % (getattr(fn, "__name__", "task"), err))

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        threads.append(thread)
        del threads[:-8]
        return thread

    def flush_background(self, timeout=4.0):
        """Give queued notes and summaries a moment to finish before exit."""
        deadline = time.time() + float(timeout)
        for thread in list(getattr(self, "_background_threads", [])):
            thread.join(max(0.0, deadline - time.time()))

    def load_code(self):
        try:
            data = json.loads(self.code_path.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def save_code(self):
        try:
            self.code_path.write_text(json.dumps(self.code[-6:]), encoding="utf-8")
        except OSError as err:
            print("[code memory not saved: %s]" % err)

    def remember_code(self, question, answer):
        blocks = extract_code(answer)
        if not blocks:
            return
        self.code.append(
            {
                "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "question": str(question)[:160],
                "code": blocks[0][:6000],
            }
        )
        del self.code[:-6]
        self.save_code()

    def code_context(self, prompt):
        """Hand the model the code it wrote so a follow-up edits it instead of restarting."""
        if not self.code or not code_followup(prompt):
            return ""
        latest = self.code[-1]
        return (
            "The current code from an earlier turn is below (%s). Change that code instead of "
            "starting over: keep what works and say what changed.\n%s"
            % (latest.get("question", "earlier turn"), latest.get("code", "")[:4000])
        )

    def show_code(self, argument):
        if str(argument).strip().lower() in ("clear", "reset"):
            self.code = []
            self.save_code()
            print("[code memory cleared]")
            return
        if not self.code:
            print("[no code remembered yet]")
            return
        latest = self.code[-1]
        print("[%s · %s]" % (latest.get("at"), latest.get("question", "")))
        print(latest.get("code", ""))

    def load_rewards(self):
        try:
            data = json.loads(self.reward_path.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def save_rewards(self):
        try:
            self.reward_path.write_text(json.dumps(self.rewards[-200:]), encoding="utf-8")
        except OSError as err:
            print("[rewards not saved: %s]" % err)

    def rate_answer(self, delta):
        if not self.last_answer:
            print("[nothing to rate yet]")
            return
        if not self.rewards or self.rewards[-1].get("q") != str(self.last_prompt)[:80]:
            self.rewards.append(
                {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "total": 0.5, "q": str(self.last_prompt)[:80]}
            )
        entry = self.rewards[-1]
        entry["total"] = round(max(0.0, min(1.0, float(entry.get("total", 0.5)) + 0.25 * delta)), 3)
        entry["rated"] = "good" if delta > 0 else "bad"
        self.save_rewards()
        if delta < 0:
            # Poisoning beats scoring: the cache must never serve this answer again.
            if self.cache.poison(self.last_prompt):
                print("[cached answer marked bad and will not be replayed]")
        elif self.cache.promote(self.last_prompt):
            print("[cached answer marked good]")
        print("[reward %.2f for the last answer]" % entry["total"])

    def different_answer(self, prompt, context, previous):
        """Rewrite an answer that came back identical: new facts, new structure."""
        instruction = (
            "Your previous answer to this question is below. Write a different answer: new "
            "facts and a new structure, and do not reuse any of its sentences.\nPrevious answer:\n"
            + str(previous)[:800]
        )
        try:
            reply = self.client.complete(
                self.messages_for(prompt, context, instruction, window_tokens=0),
                max_tokens=MAX_TOKENS,
                sampling={"temperature": 0.85, "repeat_penalty": 1.3},
                kind="variant",
            )
        except Exception:  # noqa: BLE001
            return ""
        alt = str(reply or "").strip()
        if not alt or near_duplicate(alt, previous):
            return ""
        return alt

    def append_answer(self, prompt, text, on_token=None, system=None, max_tokens=None, read_timeout=None):
        """Ask for only the missing tail of an answer that stopped mid-sentence.

        Streamed, so the tail appears token by token instead of the turn pausing
        in silence for a second request. The plan layer reuses it with its own
        system prompt and token cap to add one gap at a time.
        """
        try:
            result = self.client.ask(
                [
                    {
                        "role": "system",
                        "content": system or (
                            "Continue this answer from exactly where it stops. Output only the "
                            "new sentences: no repetition, no summary of what came before."
                        ),
                    },
                    {"role": "user", "content": "Question: %s\n\nAnswer so far:\n%s" % (prompt, text[-1200:])},
                ],
                max_tokens=max_tokens or setting("append_tokens", 160, int),
                sampling={"temperature": 0.3, "repeat_penalty": 1.15},
                on_token=on_token,
                read_timeout=read_timeout,
                kind="append",
            )
        except Exception:  # noqa: BLE001
            return ""
        more = str(result["text"] or "").strip()
        if not more or novelty(more, sentences_of(text)) < 0.5:
            return ""
        return more

    # -- [plan] a checklist for this turn, not a standing rule --------------- #
    def wants_plan(self, prompt):
        """Whether this turn is worth a checklist at all.

        "auto" plans only the asks that want several things covered: a one-line
        factual question has nothing to tick off, and a call there is pure cost.
        """
        if self.plan_mode in ("off", "0", "false", "no", "never"):
            return False
        if self.fast_mode:
            return False
        if self.plan_mode in ("on", "always", "1", "true", "yes"):
            return True
        low = str(prompt or "").lower()
        multi = re.search(
            r"\b(?:and also|as well as|pros and cons|step[- ]by[- ]step|compare|contrast|"
            r"everything|all of|cover|both)\b",
            low,
        )
        return low.count("?") >= 2 or bool(multi) or len(str(prompt).split()) >= 14

    def plan_assess(self, prompt, context, answer, read_timeout=None):
        """One short call: the checklist, each step already marked by the model.

        After the answer, not before: Lanes makes an interactive call wait for a
        running background call to drain, so a plan call started first would delay
        the answer it exists to check.
        """
        body = (
            "Question: %s\n\nAnswer so far:\n%s\n\n"
            "List at most 5 things a complete answer to the question must cover, numbered, "
            "each followed by COVERED or MISSING for the answer above."
            % (str(prompt)[:500], str(answer)[-1600:])
        )
        try:
            text = self.client.complete(
                [
                    {"role": "system", "content": PLAN_SYSTEM},
                    {"role": "user", "content": body},
                ],
                max_tokens=setting("plan_tokens", 120, int),
                sampling={"temperature": 0.2, "repeat_penalty": 1.1},
                read_timeout=read_timeout,
                kind="plan",
            )
        except Exception:  # noqa: BLE001
            return []
        rows = plan_marks(text if isinstance(text, str) else "")
        # The model's marks are the ones the user asked for; a line it left unmarked
        # is scored locally rather than counted as missed.
        return [(step, ok if ok is not None else step_covered(step, answer)) for step, ok in rows]

    def notes_fill(self, missing):
        """Paragraphs already in the notes that answer a missing step.

        Free: no model call, and only used when two of the step's own words appear
        in the note, so an unrelated note cannot be pasted into the answer.
        """
        if not missing:
            return ""
        picked, seen = [], set()
        for step in missing:
            words = set(step_words(step))
            if len(words) < 2:
                continue
            for note in self.notes.search(step, limit=2):
                body = str(note.get("text") or "").strip()
                if not body or body[:80] in seen:
                    continue
                low = (body + " " + str(note.get("title") or "")).lower()
                if sum(1 for word in words if word[:6] in low) < 2:
                    continue
                seen.add(body[:80])
                picked.append(body)
        return " ".join(picked)[:400].strip()

    def missing_answer(self, prompt, text, missing, read_timeout=None):
        """One capped call that adds only the steps the answer has not covered."""
        writer = Writer()
        writer.start("AI (+plan): ")

        def on_chunk(piece, _result):
            writer.write(piece)

        more = self.append_answer(
            "Add the missing parts only: %s" % "; ".join(missing),
            text,
            on_token=on_chunk,
            system=(
                "Add only the missing content to this answer. Output only new sentences: "
                "no repetition of the answer, no summary of what came before."
            ),
            max_tokens=setting("plan_step_tokens", 150, int),
            read_timeout=read_timeout,
        )
        writer.end()
        return more

    def review_missing(self, prompt, text, missing, read_timeout=None):
        """One thinking review: re-read the answer and the list, add what is absent."""
        writer = Writer()
        writer.start("AI (+review): ")

        def on_chunk(piece, _result):
            writer.write(piece)

        instruction = (
            "A reader is about to get this answer. These parts of the question are not "
            "covered yet:\n%s\n\nWrite only the new sentences that cover them. No repetition, "
            "no preamble, no summary.\n\nQuestion: %s\n\nAnswer:\n%s"
            % ("\n".join("- " + step for step in missing), str(prompt)[:400], str(text)[-1600:])
        )
        try:
            result = self.client.ask(
                [
                    {"role": "system", "content": "Write only the missing sentences."},
                    {"role": "user", "content": instruction},
                ],
                max_tokens=setting("plan_review_tokens", 180, int),
                sampling={"temperature": 0.35},
                on_token=on_chunk,
                think=True if self.plan_think else None,
                read_timeout=read_timeout,
                kind="plan-review",
            )
            writer.end()
        except Exception:  # noqa: BLE001
            writer.end()
            return ""
        more = str(result["text"] or "").strip()
        if not more or novelty(more, sentences_of(text)) < 0.5:
            return ""
        return more

    def plan_turn(self, prompt, text, context=""):
        """Tick the answer off against the checklist and append what is missing.

        Bounded twice on purpose: notes first (free), then at most plan_appends
        model passes and one review - and nothing at all once plan_budget seconds
        have gone by. One assess call is the default; the extra passes are opt-in,
        because the checklist is a luxury after the answer, not a second answer.
        Returns the answer, extended in place and already on screen.
        """
        began = time.time()
        deadline = began + self.plan_budget if self.plan_budget > 0 else None

        def left():
            """Seconds left in the budget, or None when it has no ceiling."""
            return None if deadline is None else max(0.0, deadline - time.time())

        calls = 1
        rows = self.plan_assess(prompt, context, text, read_timeout=left())
        if not rows:
            self.last_plan = {
                "steps": [],
                "done": 0,
                "total": 0,
                "appends": 0,
                "reviewed": 0,
                "notes": False,
                "calls": calls,
                "stopped": "",
                "secs": round(time.time() - began, 2),
            }
            return text
        report = plan_summary(rows)
        appended = reviewed = 0
        stopped = ""
        filled = self.notes_fill(report["missing"])
        if filled:
            text = text.rstrip() + "\n\n" + filled
            print("AI (+from notes): %s" % filled)
            report = plan_report([step for step, _ok in report["rows"]], text)
        while (
            report["missing"]
            and appended < self.plan_appends
            and len(text) < setting("long_limit", 6000, int)
        ):
            room = left()
            if room is not None and room <= 0.0:
                stopped = "budget"
                break
            appended += 1
            calls += 1
            more = self.missing_answer(prompt, text, report["missing"], read_timeout=room)
            if not more:
                break
            text = text.rstrip() + " " + more
            report = plan_report([step for step, _ok in report["rows"]], text)
        if self.plan_review and report["missing"]:
            room = left()
            if room is None or room > 0.0:
                reviewed = 1
                calls += 1
                more = self.review_missing(prompt, text, report["missing"], read_timeout=room)
                if more:
                    text = text.rstrip() + " " + more
                    report = plan_report([step for step, _ok in report["rows"]], text)
            else:
                stopped = "budget"
        self.last_plan = {
            "steps": [{"step": step, "done": ok} for step, ok in report["rows"]],
            "done": report["done"],
            "total": report["total"],
            "appends": appended,
            "reviewed": reviewed,
            "notes": bool(filled),
            "calls": calls,
            "stopped": stopped,
            "secs": round(time.time() - began, 2),
        }
        print(
            "[plan %d/%d covered after %d append(s)%s%s | %d model call(s) | %.1fs extra]"
            % (
                report["done"],
                report["total"],
                appended,
                " + review" if reviewed else "",
                " (budget reached)" if stopped == "budget" else "",
                calls,
                self.last_plan["secs"],
            )
        )
        self.telemetry.record(
            kind="plan",
            model=MODEL,
            ms=round(self.last_plan["secs"] * 1000, 1),
            chars=len(text),
            calls=calls,
            cache_score=(
                round(report["done"] / float(report["total"]), 3) if report["total"] else None
            ),
        )
        return text

    def capture_constraints(self, text):
        """File this turn's standing rules; keep the rest for this turn only.

        Detection always runs, even with the checklist switched off: turning the
        checklist off means "stop sending it", and the register is also the ruler
        the bench scores both arms with.

        Returns the rules stored. A one-off ("briefly", "in 3 sentences") is not
        stored at all: it lands in self.turn_constraints, is sent with this turn's
        question, and is replaced on the next turn.
        """
        found = detect_constraints(text)
        self.turn_constraints = [item for item in found if item.get("scope") == "once"]
        added = []
        for item in found:
            if item.get("scope") != "standing":
                continue
            if self.constraints.add(item, turn=self.turn_number()):
                added.append(item)
                print("[constraint %d stored: %s]" % (len(self.constraints.items), item["text"]))
        for item in self.turn_constraints:
            print(
                "[this turn only, not stored: %s - /constraints add keeps it]" % item["text"]
            )
        return added

    def one_off_reminder(self):
        """This turn's one-off rules, in the same numbered shape as the checklist."""
        if not self.turn_constraints:
            return ""
        lines = ["For this answer only (not a standing rule):"]
        for index, item in enumerate(self.turn_constraints, 1):
            lines.append("%d. %s." % (index, item["text"].rstrip(".")))
        return "\n".join(lines)

    def show_constraints(self):
        items = self.constraints.items
        once = self.turn_constraints
        state = (
            "off" if not self.constraint_inject else
            ("on: system prompt + beside the question" if self.constraint_recency
             else "on: system prompt only")
        )
        if not items and not once:
            print(
                "[no standing requirements (checklist %s) - state one for good, "
                'e.g. "from now on keep it under 60 words", or /constraints add ...]' % state
            )
            return
        print(
            "[%d standing requirement(s) - stored, re-sent every turn | checklist %s]"
            % (len(items), state)
        )
        report = (
            constraint_report(items, self.last_answer) if (items and self.last_answer) else None
        )
        for index, item in enumerate(items, 1):
            mark = ""
            if report:
                ok = report["rows"][index - 1][1]
                mark = "  -" if ok is None else ("  ok" if ok else "  BROKEN")
            print("  %2d. %-62s %s" % (index, item["text"], mark))
        if report and report["checked"]:
            print("  [last answer: %d/%d checks held]" % (report["held"], report["checked"]))
            print("  /constraints check re-tests it; /fix rewrites it")
        if once:
            # Not in the register and not numbered: it came from the wording of the
            # last turn, went out with that one question, and is already gone.
            print("  [last turn only - sent beside that question, not stored]")
            for item in once:
                print("    - %s" % item["text"])
            print("  /constraints add <rule> stores one of these for good")

    def constraint_check(self, text=None):
        answer = self.last_answer if text is None else text
        if not answer:
            print("[nothing to check yet]")
            return {}
        report = constraint_report(self.constraints.items, answer)
        if report["checked"]:
            print("[%d/%d checks held]" % (report["held"], report["checked"]))
        else:
            print("[no machine-checkable requirement in the register]")
        for item, ok in report["rows"]:
            if ok is False:
                print("  broke: %s" % item["text"])
            elif ok is None:
                print("  not measurable, sent anyway: %s" % item["text"])
        self.last_constraint_report = report
        self.telemetry.record(
            kind="constraints", model=MODEL, chars=len(answer),
            cache_score=round(report["rate"], 3) if report["rate"] is not None else None,
        )
        return report

    def constraints_command(self, argument=""):
        parts = str(argument or "").strip().split(None, 1)
        action = parts[0].lower() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        if action in ("clear", "reset"):
            count = len(self.constraints.items)
            self.constraints.clear()
            print("[constraints cleared: %d dropped]" % count)
        elif action == "off":
            self.constraint_inject = False
            print("[checklist off - the register is kept but no longer sent]")
        elif action == "on":
            self.constraint_inject = True
            print("[checklist on - %d requirement(s) sent every turn]" % len(self.constraints.items))
        elif action == "recency":
            self.constraint_recency = rest.lower() not in ("off", "0", "false", "no")
            print(
                "[checklist repeated beside the question: %s]"
                % ("on" if self.constraint_recency else "off")
            )
        elif action == "add":
            if not rest:
                print("usage: /constraints add <requirement>")
                return
            # Explicit: whatever was typed here is meant to last, even when the
            # wording alone ("briefly") would have read as a one-off.
            items = detect_constraints(rest, scope="standing") or [
                {"kind": "note", "value": None, "text": rest}
            ]
            for item in items:
                if self.constraints.add(item, turn=self.turn_number()):
                    print("[constraint %d stored: %s]" % (len(self.constraints.items), item["text"]))
        elif action in ("drop", "remove"):
            self.constraints.drop(rest)
        elif action == "check":
            self.constraint_check()
        elif action == "bench":
            self.constraint_bench(constraint_number(rest) or 30)
        else:
            self.show_constraints()

    def bench_session(self):
        """A Chat on a throwaway state folder: the bench must not touch the real one."""
        folder = Path(tempfile.mkdtemp(prefix="fastchat-constraints-"))
        saved = globals()["STATE"]
        globals()["STATE"] = str(folder)
        try:
            made = Chat(
                self.client,
                AnswerCache(folder / "cache.json"),
                Notes(folder / "notes.json"),
                Telemetry(folder / "telemetry.jsonl"),
                use_draft=False,
            )
        finally:
            globals()["STATE"] = saved
        return made

    def bench_arm(self, prompts, arm="checklist"):
        rows = []
        for index, prompt in enumerate(prompts, 1):
            line = prompt
            if index <= len(CONSTRAINT_BENCH_RULES):
                # Stated in the user turn, so both arms hear it. The only difference
                # between the arms is whether it is still on the checklist later.
                line = CONSTRAINT_BENCH_RULES[index - 1] + " " + prompt
                self.capture_constraints(line)
            context = self.context_for(line)
            started = time.time()
            try:
                result = self.client.ask(
                    self.messages_for(line, context, long=True),
                    max_tokens=setting("constraint_bench_tokens", 220, int),
                    sampling=dict(SAMPLING),
                    kind="constraint-bench",
                )
                text = str(result["text"] or "").strip()
            except Exception as err:  # noqa: BLE001
                print("  %-9s turn %2d failed: %s" % (arm, index, err))
                continue
            secs = time.time() - started
            self.memory.add(line, text)
            report = constraint_report(self.constraints.items, text)
            rows.append(
                {"turn": index, "report": report, "words": answer_words(text), "secs": secs}
            )
            print(
                "  %-9s turn %2d  %d/%d held  %3d words  %4.1fs"
                % (arm, index, report["held"], report["checked"], answer_words(text), secs)
            )
        return rows

    def constraint_bench(self, turns=30, prompts=None):
        """Run the same turns three ways: no checklist, system prompt only, and
        system prompt plus the list repeated beside the question."""
        turns = max(6, min(30, int(turns or 30)))
        prompts = list(prompts or CONSTRAINT_BENCH_PROMPTS)[:turns]
        stated = min(len(CONSTRAINT_BENCH_RULES), turns)
        print(
            "[constraint bench: %d turns per arm | turns 1-%d state a requirement, "
            "the rest are plain questions]" % (turns, stated)
        )
        arms = (("plain", False, False), ("system", True, False), ("both", True, True))
        runs = {}
        for name, inject, recency in arms:
            session = self.bench_session()
            session.long_mode = True
            session.think_mode = "off"
            session.autonote = False
            # The register is always filled, so all three arms are scored against
            # the same rules; only what reaches the model differs.
            session.constraints.clear()
            session.constraint_inject = inject
            session.constraint_recency = recency
            runs[name] = session.bench_arm(prompts, name)
        summary = {name: constraint_summary(rows) for name, rows in runs.items()}

        def pct(value):
            return "  n/a " if value is None else "%5.1f%%" % (value * 100)

        print("\n[constraint bench: %d turns per arm, same questions, same prompt path]"
              % summary["plain"]["turns"])
        for name, _inject, _recency in arms:
            row = summary[name]
            print(
                "  %-6s %s of %d checks held | turns 1-10 %s | last ten %s | "
                "%3.0f words, %.1fs per answer"
                % (name, pct(row["rate"]), row["checked"], pct(row["early"]),
                   pct(row["late"]), row["words"], row["secs"])
            )
        base = summary["plain"]
        for name in ("system", "both"):
            if base["rate"] is None or summary[name]["rate"] is None:
                continue
            late = None
            if base["late"] is not None and summary[name]["late"] is not None:
                late = (summary[name]["late"] - base["late"]) * 100
            print(
                "  %-6s vs plain: %+.1f points overall, %s in the last ten turns"
                % (name, (summary[name]["rate"] - base["rate"]) * 100,
                   "n/a" if late is None else "%+.1f points" % late)
            )
        print("  per rule (plain / system / both):")
        for rule in summary["both"]["rules"]:
            print(
                "    %-44s %s / %s / %s"
                % (rule[:44], pct(base["rules"].get(rule)),
                   pct(summary["system"]["rules"].get(rule)),
                   pct(summary["both"]["rules"].get(rule)))
            )
        self.telemetry.record(
            kind="constraint-bench", model=MODEL, chars=int(summary["both"]["words"] * 6)
        )
        return summary

    def measure_variation(self, argument=""):
        """Ask one question n times and report how different the answers are.

        Answered with no memory window on purpose: history is what makes repeats
        look alike, and this number should describe the model, not the session.
        """
        parts = str(argument or "").split(None, 1)
        count = 7
        prompt = ""
        if parts and parts[0].isdigit():
            count = max(2, min(12, int(parts[0])))
            prompt = parts[1].strip() if len(parts) > 1 else ""
        else:
            prompt = str(argument or "").strip()
        prompt = prompt or str(self.last_prompt or "").strip()
        if not prompt:
            print("usage: /variation [n] <question>   (default 7 answers)")
            return {}
        print("[asking %d times: %s]" % (count, prompt))
        answers = []
        secs = []
        for index in range(count):
            sampling = dict(SAMPLING)
            sampling["seed"] = random.randint(1, 10 ** 9)
            sampling["temperature"] = min(1.0, float(sampling.get("temperature", 0.7)) + 0.15)
            started = time.time()
            try:
                result = self.client.ask(
                    self.messages_for(prompt, "", window_tokens=0),
                    max_tokens=MAX_TOKENS,
                    sampling=sampling,
                    kind="variation",
                )
            except Exception as err:  # noqa: BLE001
                print("  %d/%d failed: %s" % (index + 1, count, err))
                continue
            text = str(result["text"] or "").strip()
            answers.append(text)
            secs.append(time.time() - started)
            print(
                "  %d/%d  %5.2fs  %4d chars  %s"
                % (index + 1, count, secs[-1], len(text), text[:70].replace("\n", " "))
            )
        stats = variation_stats(answers)
        if not stats["answers"]:
            print("[no answers - the endpoint did not reply]")
            return stats
        ordered = sorted(secs)
        print(
            "[variation: %d/%d distinct | mean pairwise similarity %.2f | closest pair %.2f | "
            "avg %d chars / %d words | median %.2fs]"
            % (
                stats["distinct"], stats["answers"], stats["mean"], stats["max"],
                stats["chars"], stats["words"], ordered[len(ordered) // 2],
            )
        )
        self.telemetry.record(kind="variation", model=MODEL, chars=stats["chars"])
        return stats

    def multi_image(self, argument):
        """Send several images in one request so the model compares them together."""
        tokens = split_args(argument)
        paths = [resolve_path(token) for token in tokens if resolve_path(token).exists()]
        question = " ".join(token for token in tokens if not resolve_path(token).exists())
        if len(paths) < 2:
            print("usage: /multi <image> <image> [more...] [question]")
            return ""
        question = question or "Compare these images: what is the same, what differs, what matters."
        payloads = []
        for path in paths:
            payload, note = image_payload(path, max_side=setting("multi_max_side", 800, int))
            payloads.append(payload)
            print("%s | %s" % (path.name, note))
        print("[%d images in one request - they share the vision budget]" % len(payloads))
        text = self._vision_call(question, payloads, kind="multi")
        if not text:
            return ""
        self.notes.add("multi", ", ".join(path.name for path in paths)[:80], text, tags="multi")
        self.memory.add("/multi %s" % question, text)
        self.last_prompt, self.last_answer = question, text
        return text

    def units(self, argument):
        """Convert units and show the factor or formula that was used."""
        message, ok = convert_units(argument)
        print(message)
        return message

    def last_script(self):
        """The script from the latest turn: code memory first, then the last answer."""
        if self.code:
            return str(self.code[-1].get("code", ""))
        return (extract_code(self.last_answer or "") or [""])[0]

    def continue_last(self):
        """Append the rest of the remembered script and verify the result."""
        code = self.last_script()
        if not code:
            print("[no script to continue - ask for one first]")
            return ""
        prompt = self.last_prompt or "continue this script"
        try:
            reply = self.client.complete(
                [
                    {
                        "role": "system",
                        "content": (
                            "This script stops before it is finished. Continue it from the last "
                            "line. Output only the remaining lines: no fences, no explanation."
                        ),
                    },
                    {"role": "user", "content": "Request: %s\n\nScript so far:\n%s" % (prompt, code[:2000])},
                ],
                model=setting("code_model", "qwen3.5:4b", str) or MODEL,
                max_tokens=400,
                sampling={"temperature": 0.2, "repeat_penalty": 1.15},
                kind="continue",
            )
        except Exception:  # noqa: BLE001
            reply = ""
        more = "\n".join(
            line for line in str(reply or "").splitlines() if not line.strip().startswith("```")
        ).strip()
        if not more:
            print("[nothing came back to continue with]")
            return ""
        joined = code.rstrip() + "\n" + more
        ok, report = self.check_script(joined, "python" in joined.lower())
        Writer().answer(joined)
        if ok:
            print("[continued and it runs]")
        else:
            print(
                "[continued but still failing: %s]"
                % (report.splitlines()[-1][:90] if report else "unknown")
            )
        self.remember_code(prompt, joined)
        return joined

    def append_last(self, argument=""):
        """Append the remembered script to a file, on explicit request only."""
        code = self.last_script()
        if not code:
            print("[no script to append]")
            return ""
        raw = (argument or "script.py").strip().strip('"')
        target = Path(raw).expanduser()
        stamp = "# %s - %s" % (time.strftime("%Y-%m-%d %H:%M"), (self.last_prompt or "")[:80])
        try:
            if target.parent and str(target.parent) not in ("", "."):
                target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("a", encoding="utf-8") as handle:
                handle.write("\n" + stamp + "\n" + str(code).rstrip() + "\n")
        except OSError as err:
            print("[could not append: %s]" % err)
            return ""
        print("[appended to %s]" % target)
        return str(target)

    def improve_script(self, argument="", source=""):
        """Re-analyze a script, run it, repair or rewrite it, then show the result."""
        code = str(argument or "").strip() or source or self.last_script()
        if not code:
            print("[no script to improve - ask for one first]")
            return ""
        prompt = self.last_prompt or "improve this script"
        python = "python" in (code + " " + prompt).lower()
        ok, report = self.check_script(code, python)
        print("[check: %s]" % ("it runs" if ok else (report.splitlines()[-1][:100] if report else "failed")))
        if not ok:
            code = self.fix_script(code, prompt, report, python)
            ok, report = self.check_script(code, python)
        if not ok:
            print("[rewriting from the original request]")
            _intro, code, _shown = self.code_reply(prompt, self.context_for(prompt), "")
            ok, report = self.check_script(code, python)
        if not code:
            print("[nothing came back]")
            return ""
        Writer().answer(code)
        ran = as_bool("run_scripts", True)
        print(
            "[%s]"
            % (
                "verified by running it"
                if ok and ran
                else ("syntax check passed" if ok else "still failing - shown anyway")
            )
        )
        self.remember_code(prompt, code)
        self.last_answer = code
        return code

    def redo(self, argument=""):
        """Re-analyze the last answer: script first, then image, then documents."""
        hint = str(argument or "").strip()
        if extract_code(self.last_answer or ""):
            return self.improve_script("", self.last_answer)
        if self.last_image:
            print("[re-reading %s]" % self.last_image)
            return self.image("%s %s" % (self.last_image, hint or self.last_prompt or ""))
        if self.notes.documents():
            print("[re-researching with your documents]")
            return self.research((self.last_prompt or "") + " " + hint)
        prompt = (self.last_prompt or "").strip()
        if not prompt:
            print("[nothing to redo]")
            return ""
        picked, _others = self.best_of(prompt, self.context_for(prompt), early_exit=True)
        if picked:
            Writer().answer(picked)
            self.remember(prompt, picked)
        return picked

    def show_rewards(self):
        if not self.rewards:
            print("[no rewards yet]")
            return
        average = sum(float(entry.get("total", 0)) for entry in self.rewards) / len(self.rewards)
        print("[%d answer(s), average reward %.2f]" % (len(self.rewards), average))
        for entry in self.rewards[-5:]:
            print(
                "  %.2f %s %s"
                % (float(entry.get("total", 0)), entry.get("rated", "auto"), entry.get("q", "")[:60])
            )

    def warm_up(self):
        """Load both models off the prompt path: a cold model is the slow first answer."""
        for model in {MODEL, setting("code_model", "", str)}:
            if not model:
                continue
            try:
                self.client.complete(
                    [{"role": "user", "content": "hi"}],
                    model=model,
                    max_tokens=1,
                    sampling={"temperature": 0.0},
                    kind="warm",
                )
            except Exception:  # noqa: BLE001
                continue

    def turn_number(self):
        turns = self.memory.turns
        return turns[-1]["n"] if turns else 0

    def rework_instruction(self, previous):
        return (
            "You answered this question before. That answer is below. Read it, then write a better "
            "one: keep what is right, cut anything rambling or unrelated, and do not reuse its "
            "sentences.\nEarlier answer:\n" + previous[:1200]
        )

    def code_reply(self, prompt, context="", memory_note=""):
        """One streamed script, then at most one silent retry. Returns (intro, code).

        The reply is printed as it arrives and its natural-language intro is kept,
        so a coding answer still reads like an answer instead of a bare dump.
        """
        python = "python" in prompt.lower()
        # One attempt. Checking and repairing below is cheaper than a second sample.
        variants = (
            (
                "Start with one short sentence saying what the script does, then one fenced "
                "code block with real logic on every line.",
                0.2,
                "",
            ),
        )
        code_model = setting("code_model", "qwen3.5:4b", str) or MODEL
        models = [code_model, MODEL] if code_model != MODEL else [MODEL]
        best, best_score, intro, streamed_ok = "", 0.0, None, False
        for index, (instruction, temperature, prefill) in enumerate(variants):
            # A clean system message, not the usual answer prompt: folding this into
            # the three-sentence instructions made the model answer in prose.
            messages = [{"role": "system", "content": instruction}]
            if context:
                messages.append({"role": "system", "content": "Context the code may need:\n" + context[:1500]})
            if memory_note:
                messages.append({"role": "system", "content": memory_note[:2000]})
            messages.append({"role": "user", "content": prompt})
            if prefill:
                # Starting the assistant turn inside a fence is what finally makes
                # the 2B model emit code instead of prose about code.
                messages.append({"role": "assistant", "content": prefill})
            reply, writer = None, None
            if not index:
                # Chunks land as they arrive: waiting for the whole script was the
                # slowest part of a code request.
                writer = Writer()
                writer.start("AI: ")
                streamed = []

                def on_token(piece, _result, _pieces=streamed, _writer=writer):
                    _pieces.append(piece)
                    _writer.write(piece)
            for model in models:
                try:
                    options = dict(
                        model=model,
                        max_tokens=min(setting("long_max_tokens", 1200, int), 400),
                        sampling={"temperature": temperature, "repeat_penalty": 1.25, "top_p": 0.9},
                        kind="code",
                    )
                    if writer:
                        reply = self.client.ask(
                            messages, priority="interactive", on_token=on_token, **options
                        )["text"]
                        writer.end()
                        streamed_ok = True
                    else:
                        reply = self.client.complete(messages, **options)
                    break
                except Exception as err:  # noqa: BLE001
                    if writer:
                        writer.end()
                        writer = None
                    if model != MODEL:
                        print("[code model %s unavailable - using %s]" % (model, MODEL))
                    else:
                        print("[code retry failed: %s]" % err)
            if reply is None:
                continue
            candidate = prefill + str(reply or "").strip() if prefill else str(reply or "").strip()
            blocks = extract_code(candidate)
            if not blocks:
                continue
            code = blocks[0]
            if index == 0:
                self.code_streamed_text = candidate
            if intro is None:
                intro = split_intro(candidate)[0]
            score = (
                code_quality(candidate)
                + (1.0 if script_ok(code, python) else 0.0)
                + code_fitness(code)
            )
            if score > best_score:
                best, best_score = code, score
            if best and script_ok(best, python):
                break
        if not best:
            return intro or "", "", streamed_ok
        ok, report = self.check_script(best, python)
        if not ok:
            best = self.fix_script(best, prompt, report, python)
            ok, report = self.check_script(best, python)
        if ok and as_bool("run_scripts", True):
            print("[ran it with sample input - no errors]")
        elif ok:
            print("[syntax check passed - run_scripts is off]")
        elif report:
            print("[still failing after one repair: %s]" % report.splitlines()[-1][:90])
        else:
            print("[syntax check failed - review it before running]")
        return intro or "", best, streamed_ok

    def check_script(self, code, python):
        """Syntax check always; execute only when verification is opted into."""
        if not code:
            return False, ""
        issues = script_issues(code) if python else []
        if issues:
            # Static faults are reported even with execution off, so repair runs.
            return False, "; ".join(issues)
        if python and as_bool("run_scripts", True):
            if not self._told_sandbox:
                print(
                    "[verification: model code runs in a sandbox - network and writes "
                    "outside its folder are blocked]"
                )
                self._told_sandbox = True
            return run_script(code, self.last_prompt or "")
        return script_ok(code, python), ""

    def fix_script(self, code, prompt, report, python):
        """Two steps and no more: one repair call, then local re-indentation."""
        fixed = self.repair_code(code, prompt, report)
        if fixed and self.check_script(fixed, python)[0]:
            print("[repaired a script that failed]")
            return fixed
        tidied = fix_indent(code) if python else code
        if tidied != code and self.check_script(tidied, python)[0]:
            print("[re-indented the script]")
            return tidied
        return code

    def repair_code(self, code, prompt, error=""):
        """Ask for the same script with the reported failure fixed."""
        messages = [
            {
                "role": "system",
                "content": (
                    "This script fails. Return the corrected, complete script inside one fenced "
                    "code block. Keep it short and runnable. No explanation."
                ),
            },
            {"role": "user", "content": "Request: %s\n\nScript:\n%s" % (prompt, code[:2000])},
        ]
        if error:
            messages.insert(
                1, {"role": "system", "content": "It was run and failed with:\n" + str(error)[-600:]}
            )
        previous = self.code[-1].get("code", "") if self.code else ""
        if previous and previous.strip() not in code:
            # Reuse what it wrote before instead of starting from a blank page.
            messages.insert(1, {"role": "system", "content": "Earlier working code:\n" + previous[:1200]})
        try:
            reply = self.client.complete(
                messages,
                model=setting("code_model", "qwen3.5:4b", str) or MODEL,
                max_tokens=500,
                sampling={"temperature": 0.1, "repeat_penalty": 1.1},
                kind="repair",
            )
        except Exception as err:  # noqa: BLE001
            print("[repair failed: %s]" % err)
            return ""
        blocks = extract_code(str(reply or ""))
        return blocks[0] if blocks else ""

    # -- [Q2] rewrite a looping answer ------------------------------------- #
    def revise(self, prompt, partial, context=""):
        instruction = (
            "The answer below started repeating itself and was cut off. Rewrite it as a "
            "fresh, non-repetitive answer to the question, at most three sentences, no preamble."
        )
        text = self.client.complete(
            self.messages_for(prompt, context, instruction)
            + [{"role": "assistant", "content": partial[:1200]}],
            max_tokens=MAX_TOKENS,
            sampling={"temperature": 0.35, "repeat_penalty": 1.3, "top_p": 0.9},
            kind="rewrite",
        )
        self.telemetry.record(kind="rewrite", model=MODEL, chars=len(text))
        return text

    # -- [Q6] multi-call research ------------------------------------------ #
    def research(self, question):
        question = question.strip()
        if not question:
            return ""
        writer = Writer()
        writer.status("[1/3] planning sub-questions")
        plan_text = self.client.complete(
            [
                {"role": "system", "content": 'Return JSON only: {"questions": ["...", "..."]} with 3 short research sub-questions.'},
                {"role": "user", "content": question},
            ],
            max_tokens=220,
            sampling={"temperature": 0.2},
            kind="research-plan",
        )
        questions = []
        try:
            data = json.loads(plan_text[plan_text.find("{"): plan_text.rfind("}") + 1])
            questions = [str(q).strip() for q in data.get("questions") or [] if str(q).strip()]
        except Exception:
            questions = []
        if not questions:
            questions = [question]

        # Measured on this endpoint: two requests in flight take ~2.8 s each
        # instead of ~0.5 s, while one call carrying both questions takes ~0.6 s.
        # So the sub-questions go out as ONE request, not one per question.
        findings = []
        questions = questions[:4]
        writer.status("[2/3] gathering %d sub-question(s) in one call" % len(questions))
        packed = "\n".join("%d. %s" % (index, sub) for index, sub in enumerate(questions, start=1))
        packed_answer = self.client.complete(
            [
                {
                    "role": "system",
                    "content": "Answer each numbered question in at most two sentences. Start every answer with its number.",
                },
                {"role": "user", "content": packed},
            ],
            max_tokens=min(1400, 300 * len(questions)),
            sampling={"temperature": 0.4},
            kind="research-gather",
        )
        for match in re.finditer(r"^\s*(\d+)[.)]\s*(.+?)(?=^\s*\d+[.)]\s|\Z)", packed_answer, re.S | re.M):
            index = int(match.group(1)) - 1
            body = match.group(2).strip()
            if 0 <= index < len(questions) and body:
                findings.append((questions[index], body))
                self.notes.add("research", questions[index][:80], body, tags="research")
        if not findings:
            writer.status("[2/3] numbered reply unreadable; asking one at a time")
            for sub in questions:
                answer = self.client.complete(
                    self.messages_for(sub, self.context_for(sub + " " + question)),
                    max_tokens=250,
                    sampling={"temperature": 0.4},
                    kind="research-gather",
                )
                if answer:
                    findings.append((sub, answer))
                    self.notes.add("research", sub[:80], answer, tags="research")

        if not findings:
            writer.status("research produced nothing; answering directly")
            return self.ask(question)

        writer.status("[3/3] synthesizing")
        brief = "\n".join("- %s -> %s" % (sub, answer[:400]) for sub, answer in findings)
        writer.start("AI: ")
        text = ""
        try:
            result = self.client.ask(
                [
                    {"role": "system", "content": SYSTEM + "\n\nUse only these notes. End with one line starting 'Next:' giving the next step."},
                    {"role": "user", "content": question + "\n\nNotes:\n" + brief},
                ],
                on_token=lambda piece, _r: writer.write(piece),
                guard=LoopGuard(),
            )
            writer.end()
            text = result["text"].strip()
        except DegenerateOutput:
            writer.end()
            text = self.revise(question, brief, "")
            writer.answer(text)
        self.notes.add("research", question[:80], text, tags="conclusion")
        self.remember(question, text)
        return text

    # -- [Q1] variations --------------------------------------------------- #
    def vary(self, prompt):
        prompt = (prompt or self.last_prompt).strip()
        if not prompt:
            print("nothing to vary")
            return ""
        # No early exit here: /vary exists to show alternatives, so it pays for
        # the extra samples (2-3 calls) instead of stopping at the first clean one.
        picked, others = self.best_of(prompt, self.context_for(prompt), early_exit=False)
        if not picked:
            print("no variations produced")
            return ""
        Writer().answer(picked)
        best_score = score_candidate(picked, prompt)
        # Only show alternatives that are still on topic; low-scoring ones are
        # kept in the notes for inspection but not printed over the answer.
        shown = [alt for alt in others if score_candidate(alt, prompt) >= best_score - 1.2]
        for index, alternative in enumerate(shown, start=2):
            print("  alt %d: %s" % (index, alternative[:300]))
        if others:
            print("[best of %d kept; all of them are in /notes under 'variants']" % (len(others) + 1))
        self.last_variation = (prompt, picked)
        return picked

    def best_of(self, prompt, context="", n=None, reasoning="", early_exit=True):
        """Sample up to n answers with different seeds and keep the best.

        This model ignores "give me three numbered answers" and returns a single
        paragraph, so candidates come from separate calls with different sampling
        instead. The first clean sample wins: once a candidate scores GOOD_ENOUGH
        the remaining calls are skipped, so the normal cost is one call.
        """
        limit = max(1, int(n or VARIANTS))
        # Different angle per attempt: the sampler helps, but an explicit change
        # of viewpoint is what actually makes the candidates differ.
        angles = [
            "",
            "Answer from a different angle: lead with a concrete example instead of a definition.",
            "Answer from a different angle again: lead with the most surprising or least obvious fact.",
            "Answer from a different angle once more: answer in a single sentence with one telling detail.",
        ]
        # Extra attempts are allowed so duplicates can be replaced; /vary samples
        # up to twice the requested count, a fixup stops as soon as it is clean.
        max_samples = limit if early_exit else limit * 2
        ranked = []
        for attempt in range(max_samples):
            messages = self.messages_for(prompt, context, angles[attempt % len(angles)])
            if reasoning:
                messages = messages[:-1] + [
                    {"role": "user", "content": "Reasoning already done:\n%s\n\nQuestion: %s" % (reasoning[:1200], prompt)}
                ]
            sampling = {
                # A 2B model degrades into nonsense above ~1.0, so the ladder
                # climbs gently: variety without losing the plot.
                "temperature": min(0.95, 0.45 + 0.22 * attempt),
                "repeat_penalty": min(1.4, 1.15 + 0.1 * attempt),
                "top_p": 0.95,
                "seed": random.randint(1, 10 ** 6),
            }
            try:
                result = self.client.ask(messages, max_tokens=MAX_TOKENS, sampling=sampling, kind="variants")
            except Exception as err:  # noqa: BLE001
                print("sampling failed:", err)
                break
            body = result["text"].strip()
            for candidate in split_candidates(body, limit) or ([body] if body else []):
                if len(candidate) > 20:
                    ranked.append((score_candidate(candidate, prompt), candidate))
            distinct = dedupe_candidates(ranked)
            if early_exit and distinct and max(score for score, _ in distinct) >= GOOD_ENOUGH:
                break
            if len(distinct) >= limit:
                break
        if not ranked:
            return "", []
        ranked = dedupe_candidates(sorted(ranked, key=lambda pair: pair[0], reverse=True))
        if len(ranked) > 1:
            self.notes.add(
                "variants",
                prompt[:80],
                "\n\n".join("#%d (score %.2f) %s" % (i + 1, s, c) for i, (s, c) in enumerate(ranked)),
                tags="variation",
            )
        return ranked[0][1], [c for _, c in ranked[1:]]

    def keep(self):
        prompt, text = getattr(self, "last_variation", ("", ""))
        if not text:
            print("no variation to keep")
            return
        # Replace what the conversation will use from now on: the cache entry,
        # the follow-up base and the note all point at the kept variation.
        self.cache.put(prompt, text, MODEL)
        self.notes.add("qa", prompt[:80], text, tags="chosen")
        self.last_prompt = prompt
        self.last_answer = text
        self.save_state()
        print("saved as the answer for: %s" % prompt[:70])

    # -- [#11] parallel vs combined, measured on the real server ------------ #
    def compare_concurrency(self, text):
        parts = [p.strip() for p in re.split(r"\s*\|\|\s*", text) if p.strip()]
        if len(parts) < 2:
            print("usage: /batch question one || question two")
            return
        first, second = parts[0], parts[1]
        solo = {}

        def run(tag, prompt):
            # Deliberately bypasses the lanes: this measures what the SERVER does
            # with two requests in flight, not what our scheduler does with them.
            started = now_ms()
            try:
                result = self.client.stream(
                    self.messages_for(prompt, self.context_for(prompt)),
                    kind="concurrency-test",
                    read_timeout=CONCURRENCY_TIMEOUT,
                )
                solo[tag] = (now_ms() - started, result["total_ms"])
            except Exception as err:  # noqa: BLE001
                solo[tag] = (now_ms() - started, None)
                solo[tag + "-error"] = str(err)[:120]

        wall_start = now_ms()
        workers = [
            threading.Thread(target=run, args=("a", first)),
            threading.Thread(target=run, args=("b", second)),
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=CONCURRENCY_TIMEOUT + 15)
        parallel_wall = now_ms() - wall_start
        stalled = [w for w in workers if w.is_alive()]
        if stalled:
            print(
                "  -> the server did not finish both requests: at least one stalled for %d s.\n"
                "     That is the slowdown you noticed: two in flight do not run in parallel."
                % CONCURRENCY_TIMEOUT
            )
            for tag in ("a-error", "b-error"):
                if solo.get(tag):
                    print("     %s: %s" % (tag, solo[tag]))
            return

        combined_prompt = "Answer both questions, numbered 1 and 2, briefly.\n1. %s\n2. %s" % (first, second)
        started = now_ms()
        combined = self.client.stream(self.messages_for(combined_prompt, ""), kind="concurrency-test")
        combined_wall = now_ms() - started

        print(
            "\n  two at once   : %6.0f ms wall (call a %.0f ms, call b %.0f ms)"
            % (parallel_wall, solo["a"][1] or 0.0, solo["b"][1] or 0.0)
        )
        print("  one combined  : %6.0f ms wall" % combined_wall)
        if combined_wall < parallel_wall:
            print(
                "  -> one call is %.0f ms faster for the same two answers (shared prefill)"
                % (parallel_wall - combined_wall)
            )
        else:
            print("  -> this server does overlap requests; two calls win by %.0f ms" % (combined_wall - parallel_wall))
        print("\ncombined answer:\n" + combined["text"].strip()[:500])
        self.notes.add(
            "note",
            "concurrency test",
            "two at once %.0f ms vs one combined %.0f ms" % (parallel_wall, combined_wall),
        )

    # -- /test-loop: prove the guard fires and the fixup replaces the answer -- #
    def test_loop_fixup(self):
        guard = LoopGuard()
        synthetic = "a ruby is red and hard " * 4
        fired = any(guard.feed(piece + " ") for piece in synthetic.split(" "))
        print("guard on synthetic repetition:", "fired" if fired else "MISSED")

        # A prompt the model cannot answer without repeating itself, so the
        # guard is guaranteed to be exercised rather than hopefully exercised.
        prompt = "Print this exact sentence five times, one per line: 'Rubies are red and very hard stones.'"
        writer = Writer()
        pieces = []
        caught = False
        writer.start("AI: ")
        try:
            result = self.client.ask(
                self.messages_for(prompt, ""),
                on_token=lambda piece, _r: (pieces.append(piece), writer.write(piece)),
                guard=LoopGuard(),
                kind="loop-test",
            )
        except DegenerateOutput:
            caught = True
            writer.end()
            print("[guard fired after %d chars]" % len("".join(pieces)))
            picked, others = self.best_of(prompt, "", early_exit=False, reasoning="")
            if picked:
                print("[fixup replaced it with the best of %d distinct samples]" % (len(others) + 1))
                Writer().answer(picked)
            else:
                print("[fixup produced nothing]")
            return
        except Exception as err:  # noqa: BLE001
            writer.end()
            print("loop test could not run:", err)
            return
        writer.end()
        text = result["text"].strip()
        print(
            "[the model did not loop this run: %d chars, no guard fire]\n%s"
            % (len(text), text[:300])
        )

    # -- /review: ask the model to review a file ---------------------------- #
    def review(self, path_text):
        target = Path(str(path_text).strip().strip('"'))
        if not target.exists():
            print("no such file:", target)
            return
        try:
            body = target.read_text(encoding="utf-8", errors="replace")
        except OSError as err:
            print("cannot read %s: %s" % (target, err))
            return
        if len(body) > 14000:
            body = body[:7000] + "\n... (truncated) ...\n" + body[-7000:]
        writer = Writer()
        writer.start("Review: ")
        try:
            result = self.client.ask(
                [
                    {
                        "role": "system",
                        "content": (
                            "Review this code. List real problems only, worst first, each as "
                            "'line or function - problem - concrete fix'. No praise, no summary of "
                            "what the code does. Finish with one line starting 'Verdict:'."
                        ),
                    },
                    {"role": "user", "content": "File: %s\n\n%s" % (target.name, body)},
                ],
                on_token=lambda piece, _r: writer.write(piece),
                max_tokens=700,
                sampling={"temperature": 0.2, "repeat_penalty": 1.2},
                kind="review",
            )
            writer.end()
        except Exception as err:  # noqa: BLE001
            writer.end()
            print("review failed:", err)
            return
        self.notes.add("review", target.name, result["text"].strip(), tags="review")

    # -- /ab: same question with and without a reasoning pass ---------------- #
    def ab_thinking(self, question):
        question = (question or self.last_prompt).strip()
        if not question:
            print("nothing to compare; ask something first")
            return
        context = self.context_for(question)

        started = now_ms()
        plain = self.client.ask(self.messages_for(question, context), kind="ab-plain")
        plain_ms = now_ms() - started

        started = now_ms()
        reasoning = self.reason(question, context)
        deep = self.client.ask(
            self.messages_for(question, (context + "\n\nReasoning already done:\n" + reasoning[:1500]).strip()),
            kind="ab-think",
        )
        deep_ms = now_ms() - started

        left = plain["text"].strip()
        right = deep["text"].strip()
        similarity = SequenceMatcher(None, left.lower(), right.lower()).ratio()
        print("\n plain    %6.0f ms  score %.2f  %d chars" % (plain_ms, score_candidate(left, question), len(left)))
        print("   " + left[:360])
        print("\n thinking %6.0f ms  score %.2f  %d chars reasoning, %d chars answer"
              % (deep_ms, score_candidate(right, question), len(reasoning), len(right)))
        print("   " + right[:360])
        print(
            "\n similarity %.2f -> %s (%.0f ms and one reasoning call extra)"
            % (similarity, "thinking changed the answer" if similarity < 0.9 else "thinking changed little", deep_ms - plain_ms)
        )
        self.notes.add(
            "ab",
            question[:80],
            "plain %.2f / %.0f ms\nthinking %.2f / %.0f ms\nsimilarity %.2f"
            % (score_candidate(left, question), plain_ms, score_candidate(right, question), deep_ms, similarity),
            tags="ab",
        )

    # -- /followups: propose the next questions ----------------------------- #
    def brainstorm(self, count=4):
        base = (self.last_answer or "").strip()
        if not base:
            print("ask something first")
            return
        text = self.client.complete(
            [
                {
                    "role": "system",
                    "content": (
                        "Suggest %d short follow-up questions a curious reader would ask next. "
                        "One per line, no numbering, no preamble, no repeats." % count
                    ),
                },
                {"role": "user", "content": "Answer just given:\n" + base[:1200]},
            ],
            max_tokens=220,
            sampling={"temperature": 0.8},
            kind="followups",
        )
        lines = [line.strip(" -\u2022\t") for line in str(text).splitlines() if line.strip()]
        lines = dedupe_candidates([(0.0, line) for line in lines]) if lines else []
        questions = [line for _, line in lines][:count]
        for index, question in enumerate(questions, start=1):
            print("  %d. %s" % (index, question))
        if questions:
            self.notes.add("followups", "next questions", "\n".join(questions), tags="brainstorm")

    # -- images ------------------------------------------------------------ #
    def _split_path(self, argument):
        argument = str(argument).strip()
        if not argument:
            return "", ""
        if argument[0] in "\"'":
            end = argument.find(argument[0], 1)
            if end > 0:
                return argument[1:end], argument[end + 1:].strip()
        parts = argument.split(None, 1)
        return parts[0], (parts[1] if len(parts) > 1 else "")

    def _vision_call(self, question, images, max_tokens=MAX_TOKENS, kind="vision", stream=True, model=None):
        messages = [{"role": "system", "content": VISION_SYSTEM}]
        message = {"role": "user", "content": question}
        if images:
            message["images"] = images
        messages.append(message)
        window = setting("context_window", 4096, int)
        # Leave room for what the server adds on top of our own count: the picture
        # budget alone is not the whole request.
        target = int(window * setting("vision_context_ratio", 0.85, float))
        overhead = sum(token_count(item.get("content", "")) for item in messages)
        budget = max(200, target - overhead)
        attempt = 0
        while True:
            images = fit_images(images, max(200, int(budget * (0.6**attempt))), int(max_tokens))
            message["images"] = images
            try:
                if stream:
                    writer = Writer()
                    writer.start("AI: ")
                    try:
                        result = self.client.ask(
                            messages,
                            model=model or MODEL,
                            on_token=lambda piece, _r: writer.write(piece),
                            guard=LoopGuard(),
                            max_tokens=max_tokens,
                            kind=kind,
                        )
                    finally:
                        writer.end()
                    return result["text"].strip()
                return str(
                    self.client.complete(
                        messages,
                        model=model or MODEL,
                        max_tokens=max_tokens,
                        sampling={"temperature": 0.75, "repeat_penalty": 1.1},
                        kind=kind,
                    )
                ).strip()
            except Exception as err:  # noqa: BLE001
                # The server counts more than our estimate does; shrink and retry
                # instead of surfacing a bare 400 for an image the model can take.
                if "context" not in str(err).lower() or not images or attempt >= 3:
                    raise
                attempt += 1
                print("[request still too large - images downscaled again (%d)]" % attempt)

    def _viewpoint(self, question, text):
        if not self.viewpoint:
            return
        try:
            view = str(
                self.client.complete(
                    [
                        {
                            "role": "system",
                            "content": (
                                "You are the assistant. State your own reading in at most two sentences: "
                                "what you believe, and what you are least sure about."
                            ),
                        },
                        {"role": "user", "content": question + "\n\nYour earlier answer:\n" + text[:900]},
                    ],
                    max_tokens=180,
                    sampling={"temperature": 0.6},
                    kind="viewpoint",
                )
            ).strip()
        except Exception as err:  # noqa: BLE001
            print("[viewpoint failed: %s]" % err)
            return
        if view:
            print("--- viewpoint (the model's own read) ---")
            print(view)

    def image(self, argument):
        path_text, question = self._split_path(argument)
        target = resolve_path(path_text) if path_text else None
        if not target or not target.exists():
            print("usage: /image <path> [question]")
            return ""
        question = question or "Describe what is in this image and what it is for."
        facts = pixel_facts(target)
        payload, note = image_payload(target)
        print(describe_pixels(facts), "|", note)
        # same pixels + same question = same answer: skip the call entirely
        digest = hashlib.sha1(("%s|%s" % (payload, question)).encode("utf-8")).hexdigest()
        cached = self.vision_cache.get(digest)
        from_cache = bool(cached)
        if cached:
            print("AI (cached): %s" % cached)
            text = cached
        else:
            text = self._vision_call(question, [payload], kind="vision")
            if text:
                self.vision_cache[digest] = text
                if len(self.vision_cache) > 50:
                    self.vision_cache.pop(next(iter(self.vision_cache)))
                self._save_vision_cache()
        if not text:
            return ""
        if self.vision_samples > 1 and not from_cache:
            reads = [text] + [
                self._vision_call(question, [payload], kind="vision-alt", stream=False)
                for _ in range(self.vision_samples - 1)
            ]
            reads = [read for read in reads if read]
            scores = [
                agreement(reads[i], reads[j])
                for i in range(len(reads))
                for j in range(i + 1, len(reads))
            ]
            if scores:
                low = min(scores)
                print(
                    "[consistency %.0f%% across %d reads (content overlap)%s]"
                    % (low * 100, len(reads), "" if low >= 0.4 else " - reads disagree, treat with care")
                )
        check = pixel_agreement(text, facts)
        if check:
            if check["agree"] is True:
                print("[pixel check: model said %s, pixels measure %s - agrees]" % (check["said"][0], check["measured"]))
            elif check["agree"] is False:
                print("[pixel check: model said %s, pixels measure %s - DISAGREES]" % (", ".join(check["said"]), check["measured"]))
            else:
                print("[pixel check: pixels measure %s, model named no colour]" % check["measured"])
        self._viewpoint(question, text)
        self.last_image = str(target)
        self.notes.add("image", target.name, text, tags="image")
        self.memory.add("/image %s - %s" % (target.name, question), text)
        self.last_prompt, self.last_answer = question, text
        return text

    def frames(self, argument):
        tokens = split_args(argument)
        paths = [resolve_path(token) for token in tokens if resolve_path(token).exists()]
        question = " ".join(token for token in tokens if not resolve_path(token).exists())
        if len(paths) < 2:
            print("usage: /frames <before.png> <after.png> [question]")
            return
        # signature only: no full decode, no re-encode, nothing sent to the model yet
        before, after = signature_of(paths[0]), signature_of(paths[1])
        print(describe_pixels(before))
        print(describe_pixels(after))
        change = frame_change(before, after)
        if (before.get("width"), before.get("height")) != (after.get("width"), after.get("height")):
            print(
                "[sizes differ (%sx%s vs %sx%s): comparing normalised 32x18 luminance grids]"
                % (
                    before.get("width"),
                    before.get("height"),
                    after.get("width"),
                    after.get("height"),
                )
            )
        detail = ""
        if change:
            detail = "%.1f%% of the image changed" % (change["fraction"] * 100)
            if change["regions"]:
                detail += ", mostly " + ", ".join(change["regions"][:4])
            print("[frame diff: %s]" % detail)
        # two frames share a 4096-token context, so cap them tighter than one image
        pair_side = setting("frames_max_side", 640, int)
        payloads = [image_payload(path, pair_side)[0] for path in paths[:2]]
        prompt = (question or "What changed between these two frames?") + ("\n\nMeasured: %s." % detail if detail else "")
        text = self._vision_call(prompt, payloads, kind="frames")
        if text:
            self.notes.add("frames", "%s -> %s" % (Path(paths[0]).name, Path(paths[1]).name), text, tags="image")
            self.memory.add("/frames %s %s" % (Path(paths[0]).name, Path(paths[1]).name), text)
            self.last_prompt, self.last_answer = prompt, text

    def images(self, argument):
        tokens = split_args(argument)
        paths = [resolve_path(token) for token in tokens if resolve_path(token).exists()]
        question = " ".join(token for token in tokens if not resolve_path(token).exists()) or "What is in this image?"
        if not paths:
            print("usage: /images [question] <a.png> <b.png> ...")
            return
        def read(path):
            facts = pixel_facts(path)
            payload, _ = image_payload(path)
            answer = self._vision_call(
                question + " Answer in one sentence.", [payload], max_tokens=110, kind="image-batch", stream=False
            )
            return path, facts, answer

        selected = paths[:6]
        workers = min(4, len(selected)) if self.parallel else 1
        if self.ext is not None:
            try:
                # the extension decides from the measured crossover for this
                # reply length (110 tokens here), not from a fixed guess
                workers = self.ext.parallel_workers(len(selected), 110, requested=self.parallel)
            except Exception as err:  # noqa: BLE001
                print("[ext parallel hook failed: %s]" % err)
        if workers > 1 and len(selected) > 1:
            started = now_ms()
            with ThreadPoolExecutor(max_workers=workers) as pool:
                results = list(pool.map(read, selected))
            print("[%d images read with %d worker(s): %.0f ms wall]" % (len(results), workers, now_ms() - started))
        else:
            results = [read(path) for path in selected]
        findings = []
        for path, facts, answer in results:
            print("\n[%d] %s %s" % (len(findings) + 1, Path(path).name, describe_pixels(facts)))
            print("    " + (answer or "(no answer)"))
            findings.append("%s: %s | pixels: %s" % (Path(path).name, answer or "(none)", facts.get("dominant_colour", "undecoded")))
        combined = str(
            self.client.complete(
                [
                    {
                        "role": "system",
                        "content": (
                            "Order these images by how well they answer the question, flag any whose "
                            "answer contradicts its measured pixels, and give one combined reply. "
                            "At most five sentences."
                        ),
                    },
                    {"role": "user", "content": "Question: %s\n\n%s" % (question, "\n".join(findings))},
                ],
                max_tokens=400,
                sampling={"temperature": 0.3},
                kind="image-synthesis",
            )
        ).strip()
        print("\n--- combined ---")
        print(combined or "(no synthesis)")
        if combined:
            self.notes.add("images", question[:80], combined, tags="image")
            self.memory.add("/images " + question, combined)
            self.last_prompt, self.last_answer = question, combined
            self.stash(combined, "/images %s" % question[:50])

    def paint(self, argument):
        path_text, rest = self._split_path(argument)
        rounds = int(rest) if rest.isdigit() else setting("paint_rounds", 3, int)
        rounds = max(1, min(8, rounds))
        target = resolve_path(path_text) if path_text else None
        if not target or not target.exists():
            print("usage: /paint <image> [rounds]")
            return
        facts = pixel_facts(target)
        payload, note = image_payload(target)
        print(describe_pixels(facts), "|", note)
        draft = self._vision_call(
            "Describe this image in detail: objects, layout, text, colours, anything unusual.",
            [payload],
            kind="paint-1",
        )
        if not draft:
            return
        print("[round 1/%d]" % rounds)
        print(draft)
        for round_number in range(2, rounds + 1):
            more = self._vision_call(
                "Here is the description so far:\n%s\n\nLook at the image again. Add only details it "
                "missed or got wrong: layout, text, small objects, colours. No repetition." % draft[:1500],
                [payload],
                kind="paint",
                stream=False,
                max_tokens=250,
            )
            if not more:
                print("[round %d: nothing new]" % round_number)
                break
            fresh = novelty(more, sentences_of(draft))
            print("[round %d: %.0f%% new]" % (round_number, fresh * 100))
            print(more)
            if fresh < 0.3:
                print("[round %d: no new detail, stopped]" % round_number)
                break
            draft = draft + "\n" + more
        final = str(
            self.client.complete(
                [
                    {
                        "role": "system",
                        "content": (
                            "Merge these rounds into one clear description: what it is, then layout, then "
                            "details. Drop repetition, keep every real detail, at most 200 words."
                        ),
                    },
                    {"role": "user", "content": draft[:3000]},
                ],
                max_tokens=400,
                kind="paint-final",
            )
        ).strip() or draft
        print("\n--- painted picture ---")
        print(final)
        self.notes.add("paint", target.name, final, tags="image")
        self.memory.add("/paint %s" % target.name, final)
        self.stash(final, "paint %s" % target.name)
        self.last_prompt, self.last_answer = "describe %s" % target.name, final

    # -- /live and /watch: the screen itself ------------------------------- #
    def live(self, argument):
        question = str(argument).strip() or (
            "Describe this screen: which application is open, what it is showing, and any readable text."
        )
        try:
            path = capture_frame("live")
        except Exception as err:  # noqa: BLE001
            print("capture failed:", err)
            return
        print("[captured %s]" % path.name)
        return self.image('"%s" %s' % (path, question))

    def watch(self, argument):
        tokens = split_args(argument)
        delay = 1.5
        if tokens:
            try:
                delay = max(0.2, min(10.0, float(tokens[0])))
                tokens = tokens[1:]
            except ValueError:
                pass
        question = " ".join(tokens) or "What changed on screen between these two frames?"
        # Fast path: compare the two captures in memory. No PNG is written, no
        # image is decoded, and the model is only asked once something changed.
        try:
            width_a, height_a, rows_a = capture_screen()
            time.sleep(delay)
            width_b, height_b, rows_b = capture_screen()
        except Exception as err:  # noqa: BLE001
            print("capture failed:", err)
            return
        before = dict(
            _stats_from_rows(width_a, height_a, 3, 2, b"", rows_a), path="frame-a", format="screen", bytes=0, decoded=True
        )
        after = dict(
            _stats_from_rows(width_b, height_b, 3, 2, b"", rows_b), path="frame-b", format="screen", bytes=0, decoded=True
        )
        print(describe_pixels(before))
        print(describe_pixels(after))
        change = frame_change(before, after) or {"fraction": 0.0, "regions": []}
        print(
            "[frame diff: %.1f%% of the image changed%s]"
            % (
                change["fraction"] * 100,
                (", mostly " + ", ".join(change["regions"][:4])) if change["regions"] else "",
            )
        )
        minimum = setting("watch_min_change", 0.005, float)
        if change["fraction"] < minimum:
            print("[no change above %.1f%% - not encoding or calling the model]" % (minimum * 100))
            return
        pair_side = setting("frames_max_side", 640, int)
        payloads = []
        for width, height, rows in ((width_a, height_a, rows_a), (width_b, height_b, rows_b)):
            if max(width, height) > pair_side:
                rows = shrink_rows(width, height, 3, 2, b"", rows, pair_side)
                width, height = len(rows[0]) // 3, len(rows)
            payloads.append(base64.b64encode(write_png(width, height, rows)).decode())
        prompt = question + "\n\nMeasured: %.1f%% of the image changed." % (change["fraction"] * 100)
        text = self._vision_call(prompt, payloads, kind="frames")
        if text:
            self.notes.add("frames", "live watch", text, tags="image")
            self.memory.add("/watch %s" % question, text)
            self.last_prompt, self.last_answer = prompt, text

    # -- /ocr: text out of an image, with the OCR model -------------------- #
    def ocr(self, argument):
        path_text, _ = self._split_path(argument)
        target = resolve_path(path_text) if path_text else None
        if not target or not target.exists():
            print("usage: /ocr <image>")
            return
        payload, _ = image_payload(target)
        text = self._vision_call(
            "Transcribe every word of text in this image, line by line. No commentary.",
            [payload],
            max_tokens=400,
            kind="ocr",
            stream=False,
            model=OCR_MODEL,
        )
        if not text:
            print("[%s returned nothing - it reads text, not scenes]" % OCR_MODEL)
            return
        print(text)
        self.notes.add("ocr", target.name, text, tags="ocr")
        self.memory.add("/ocr %s" % target.name, text)

    # -- indexed document store ------------------------------------------- #
    def index_path(self, argument):
        raw = str(argument).strip().strip('"')
        target = resolve_path(raw) if raw else None
        if not target or not target.exists():
            print("usage: /index <file-or-folder>")
            return
        files = [target] if target.is_file() else [
            item for item in target.rglob("*") if item.is_file() and item.suffix.lower() in (
                ".txt", ".md", ".py", ".js", ".json", ".csv", ".html", ".css", ".yml", ".yaml", ".log", ".ts"
            )
        ]
        rows = []
        skipped = 0
        for path in files[:400]:
            try:
                if path.stat().st_size > 2_000_000:
                    skipped += 1
                    continue
                body = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                skipped += 1
                continue
            for chunk in chunk_by_tokens(body, 120):
                rows.append((str(path), chunk))
        if not rows:
            print("nothing indexable in", target)
            return
        self.store.add_many(rows)
        print(
            "indexed %d chunk(s) from %d file(s)%s | store now holds %d"
            % (len(rows), len(files[:400]) - skipped, " (%d skipped)" % skipped if skipped else "", self.store.count())
        )

    def recall(self, argument):
        query = str(argument).strip()
        if not query:
            print("usage: /recall <words>")
            return
        keyword = self.store.search(query, limit=6)
        vector = []
        if self.ext is not None:
            try:
                vector = self.ext.semantic_recall(self, query, limit=6) or []
            except Exception as err:  # noqa: BLE001
                print("[ext semantic recall failed: %s]" % err)
                vector = []
        # fusion, not fallback: a chunk both searches like should win
        hits = rrf_merge(keyword, vector)[:8]
        if not hits:
            print("no keyword or vector match (/index <folder> first; unrelated words score zero)")
            return
        for index, hit in enumerate(hits, start=1):
            print("\n[%d] %s" % (index, hit["path"]))
            print("    " + hit["body"][:260].replace("\n", " "))
            self.notes.add("recall", hit["path"], hit["body"], tags="recall")
        print("\n(%d hit(s) also added to notes, so questions can cite them)" % len(hits))

    # -- dimensions: different pixel sizes, and what that costs --------------#
    def dims(self, argument):
        tokens = split_args(argument)
        if not tokens:
            print("usage: /dims <image> [image...]")
            return
        decoded = 0
        total = 0
        for token in tokens:
            target = resolve_path(token)
            if not target.exists():
                print("  missing: %s" % token)
                continue
            data = target.read_bytes()
            width = height = 0
            if data[:8] == b"\x89PNG\r\n\x1a\n":
                try:
                    width, height = png_size(data)
                except Exception:  # noqa: BLE001
                    pass
            elif data[:2] == b"\xff\xd8":
                size = jpeg_size(data)
                if size:
                    width, height = size
            facts = pixel_facts(target)
            total += 1
            if facts.get("decoded"):
                decoded += 1
            print(
                "  %-26s %4dx%-4d %-9s aspect %.2f  %5.1f KB  %s"
                % (
                    target.name,
                    width,
                    height,
                    orientation_of(width, height),
                    (width / float(height)) if height else 0.0,
                    len(data) / 1024.0,
                    "pixels read" if facts.get("decoded") else "header only (no decoder)",
                )
            )
        if total > 1:
            print(
                "  %d of %d readable: frame comparison uses one normalised 32x18 grid, "
                "so mixed sizes are comparable" % (decoded, total)
            )
            if decoded != total and decoded:
                print("  (a JPEG in the set has dimensions only, so /frames would skip it)")

    def store_stats(self):
        count = self.store.count()
        print("indexed chunks: %d | database: %s" % (count, self.store.path))
        try:
            size = self.store.path.stat().st_size
        except OSError:
            size = 0
        if count and size:
            per_chunk = size / float(count)
            print(
                "%.1f MB on disk, %.0f bytes per chunk | 10x corpus %.0f MB, 100x %.1f GB, 1000x %.0f GB"
                % (size / 1e6, per_chunk, size * 10 / 1e6, size * 100 / 1e9, size * 1000 / 1e9)
            )

    # -- long notes: durable facts kept from an answer, no extra turn needed -- #
    def auto_note(self, prompt, answer, quiet=False):
        minimum = setting("autonote_min_chars", 300, int)
        if len(str(answer)) < minimum:
            return
        try:
            text = self.client.complete(
                [
                    {
                        "role": "system",
                        "content": (
                            "Extract at most three durable facts from this exchange that would still be "
                            "worth knowing in a later conversation. One per line, no numbering, no "
                            "preamble. Reply exactly NONE if there is nothing durable."
                        ),
                    },
                    {"role": "user", "content": "Question: %s\n\nAnswer: %s" % (str(prompt)[:400], str(answer)[:1200])},
                ],
                max_tokens=200,
                sampling={"temperature": 0.2},
                kind="autonote",
                priority="background",
            )
        except Exception:  # noqa: BLE001
            return
        lines = [line.strip(" -\u2022\t") for line in str(text).splitlines() if len(line.strip()) > 20]
        if not lines or lines[0].upper().startswith("NONE"):
            return
        existing = [str(item.get("text", "")).lower() for item in self.notes.items[-80:]]
        added = 0
        for line in lines[:3]:
            if any(SequenceMatcher(None, line.lower(), old).ratio() > 0.8 for old in existing):
                continue
            self.notes.add("fact", str(prompt)[:60], line, tags="auto")
            existing.append(line.lower())
            added += 1
        if added and not quiet:
            print("[%d note(s) kept for later - /notes to read them]" % added)

    # -- /expand: keep writing past the first answer, without repeating it -- #
    def expand_answer(self, argument):
        base = (self.last_answer or "").strip()
        if not base:
            print("ask something first")
            return
        raw = str(argument).strip()
        target = int(raw) if raw.isdigit() else setting("expand_target_words", 400, int)
        rounds = max(1, setting("expand_rounds", 3, int))
        seen = sentences_of(base)
        self.long_mode = True
        for round_number in range(1, rounds + 1):
            words = len(base.split())
            if words >= target:
                print("[%d words, target %d reached]" % (words, target))
                break
            messages = [
                {
                    "role": "system",
                    "content": LONG_SYSTEM + (
                        " Continue the answer with new material only: facts, examples, numbers or the "
                        "next step. At least eighty words. Never repeat a sentence already written."
                    ),
                },
                {"role": "user", "content": (self.last_prompt or "Continue the answer.")[:600]},
                {"role": "assistant", "content": base[-2000:]},
                {"role": "user", "content": "Continue."},
            ]
            try:
                more = str(
                    self.client.complete(
                        messages,
                        max_tokens=setting("long_max_tokens", 1200, int) // 2,
                        sampling={"temperature": 0.5, "repeat_penalty": 1.2},
                        kind="expand",
                    )
                ).strip()
            except Exception as err:  # noqa: BLE001
                print("[round %d failed: %s]" % (round_number, err))
                break
            if not more:
                print("[round %d: empty, stopped]" % round_number)
                break
            fresh = novelty(more, seen)
            if fresh < 0.25:
                print("[round %d: %.0f%% new, nothing to add - stopped]" % (round_number, fresh * 100))
                break
            print(more)
            base = base.rstrip() + "\n\n" + more
            seen.extend(sentences_of(more))
            print("[round %d: %.0f%% new, %d words now]" % (round_number, fresh * 100, len(base.split())))
        self.last_answer = base
        if self.memory.turns:
            self.memory.turns[-1]["answer"] = base
            self.memory.rebuild()
            self.memory.save()
        self.stash(base, "expand %s" % (self.last_prompt or "answer")[:50])

    # -- /evolve: n rounds, keep the best, remember what worked ------------ #
    def evolve(self, argument):
        tokens = split_args(argument)
        rounds = 3
        if tokens and tokens[-1].isdigit():
            rounds = max(2, min(6, int(tokens.pop())))
        question = " ".join(tokens).strip()
        if not question:
            print("usage: /evolve <question> [rounds]")
            return
        context = self.context_for(question)
        best_text, best_score, best_temperature = "", -99.0, 0.0
        for round_number in range(1, rounds + 1):
            temperature = round(0.3 + 0.16 * (round_number - 1), 2)
            try:
                text = str(
                    self.client.complete(
                        self.messages_for(question, context),
                        max_tokens=MAX_TOKENS,
                        sampling={"temperature": temperature, "repeat_penalty": 1.15},
                        kind="evolve",
                    )
                ).strip()
            except Exception as err:  # noqa: BLE001
                print("[round %d failed: %s]" % (round_number, err))
                continue
            score = score_candidate(text, question)
            print("[round %d: score %.2f at temperature %.2f, %d chars]" % (round_number, score, temperature, len(text)))
            if score > best_score:
                best_text, best_score, best_temperature = text, score, temperature
        if not best_text:
            return
        print("\n--- best of %d (score %.2f) ---" % (rounds, best_score))
        print(best_text)
        self.notes.add("evolve", question[:80], best_text, tags="evolve")
        self.memory.add(question, best_text)
        self.memory.log("evolve", question=question[:120], score=best_score, temperature=best_temperature)
        print("[habit: temperature %.2f scored best here, logged for next time]" % best_temperature)
        self.last_prompt, self.last_answer = question, best_text

    # -- /pipeline: exhaust -> fan -> render, with stage timings ----------- #
    def pipeline(self, argument):
        question = str(argument).strip() or self.last_prompt
        if not question:
            print("usage: /pipeline <question>")
            return
        started = now_ms()
        context = self.context_for(question)
        exhaust_ms = now_ms() - started
        print("[exhaust  %6.1f ms] %d chars of memory, intent %s" % (exhaust_ms, len(context), self.last_intent or "new"))

        started = now_ms()
        variants = []
        for temperature in (0.3, 0.65):
            try:
                variants.append(
                    str(
                        self.client.complete(
                            self.messages_for(question, context),
                            max_tokens=MAX_TOKENS,
                            sampling={"temperature": temperature, "repeat_penalty": 1.15},
                            kind="fan",
                        )
                    ).strip()
                )
            except Exception as err:  # noqa: BLE001
                print("[fan: one variant failed: %s]" % err)
        fan_ms = now_ms() - started
        variants = [variant for variant in variants if variant]
        held = agreement(variants[0], variants[1]) if len(variants) > 1 else 0.0
        print("[fan      %6.1f ms] %d variant(s), they agree %.0f%%" % (fan_ms, len(variants), held * 100))
        if not variants:
            return

        started = now_ms()
        final = str(
            self.client.complete(
                [
                    {
                        "role": "system",
                        "content": (
                            "Merge the drafts into one answer: keep what they agree on, keep a claim only "
                            "if it is stated confidently and is not contradicted, drop repetition. "
                            "At most four sentences, no preamble."
                        ),
                    },
                    {"role": "user", "content": "Question: %s\n\n%s" % (
                        question, "\n\n".join("Draft %d:\n%s" % (i + 1, v[:1200]) for i, v in enumerate(variants))
                    )},
                ],
                max_tokens=MAX_TOKENS,
                sampling={"temperature": 0.25},
                kind="render",
            )
        ).strip() or variants[0]
        render_ms = now_ms() - started
        print("[render   %6.1f ms] %d chars, total %.0f ms" % (render_ms, len(final), exhaust_ms + fan_ms + render_ms))
        print("\n" + final)
        self.notes.add("pipeline", question[:80], final, tags="pipeline")
        self.memory.add(question, final)
        self.last_prompt, self.last_answer = question, final

    # -- /check: a stronger text model audits the answer ------------------- #
    def check_answer(self, argument):
        question = str(argument).strip() or self.last_prompt
        answer = (self.last_answer or "").strip()
        if not answer:
            print("ask something first")
            return
        try:
            verdict = str(
                self.client.complete(
                    [
                        {
                            "role": "system",
                            "content": (
                                "You are a strict fact checker. List only errors in the answer, one per line, "
                                "worst first. If it is correct, reply exactly OK."
                            ),
                        },
                        {"role": "user", "content": "Question: %s\n\nAnswer: %s" % (question[:400], answer[:1500])},
                    ],
                    model=CHECK_MODEL,
                    max_tokens=260,
                    sampling={"temperature": 0.1},
                    kind="check",
                )
            ).strip()
        except Exception as err:  # noqa: BLE001
            print("[check with %s failed: %s]" % (CHECK_MODEL, err))
            return
        if not verdict:
            print("[%s returned nothing]" % CHECK_MODEL)
            return
        if verdict.upper().startswith("OK"):
            print("[check by %s: no errors found]" % CHECK_MODEL)
        else:
            print("--- check by %s ---" % CHECK_MODEL)
            print(verdict)
        self.notes.add("check", question[:60], verdict, tags="check")

    # -- /write: long output to disk as a reference point ------------------ #
    def write_answer(self, argument):
        raw = str(argument).strip().strip('"')
        if not raw:
            print("usage: /write <path>")
            return
        target = Path(raw)
        if not target.is_absolute():
            target = Path(state_dir()) / target
        body = (self.last_answer or "").strip()
        if not body:
            print("no answer to write yet")
            return
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body, encoding="utf-8")
        except OSError as err:
            print("write failed:", err)
            return
        print("wrote %d chars to %s" % (len(body), target))

    # -- long material set aside, not thrown away -------------------------- #
    def stash(self, text, title):
        if len(text) <= PREPLY_THRESHOLD:
            return text
        head, tail = text[:PREPLY_THRESHOLD], text[PREPLY_THRESHOLD:]
        number = self.preplies.add(title, tail)
        print(
            "[%d chars set aside as preply #%d - /preply %d appends it, /preply drop %d discards it]"
            % (len(tail), number, number, number)
        )
        return head

    def show_preplies(self):
        if not self.preplies.items:
            print("nothing set aside")
            return
        for item in self.preplies.items[-12:]:
            print(
                "  #%d %s: %d chars - %s"
                % (item["id"], item["title"], len(item["text"]), item["text"][:70].replace("\n", " "))
            )

    def use_preply(self, argument):
        argument = str(argument).strip()
        tokens = argument.split()
        if tokens and tokens[0].lower() == "drop":
            number = int(tokens[-1]) if tokens[-1].isdigit() else 0
            print("dropped preply #%d" % number if self.preplies.drop(number) else "no preply %d" % number)
            return
        number = int(argument) if argument.isdigit() else 0
        item = self.preplies.get(number)
        if not item:
            print("usage: /preply <id> | /preply drop <id> | /preplies")
            return
        print(item["text"])
        if self.last_answer:
            self.last_answer = self.last_answer.rstrip() + "\n\n" + item["text"]
            self.memory.add(self.last_prompt or "preply", item["text"])

    # -- [Q5] documents ---------------------------------------------------- #
    def ingest(self, path_text):
        path = Path(path_text.strip().strip('"'))
        if not path.exists():
            print("no such file:", path)
            return
        try:
            body = path.read_text(encoding="utf-8", errors="replace")
        except OSError as err:
            print("cannot read %s: %s" % (path, err))
            return
        chunks = chunk_text(body)
        for index, chunk in enumerate(chunks, start=1):
            self.notes.add("doc", "%s #%d" % (path.name, index), chunk, tags=str(path))
        print("ingested %s: %d chunk(s), %d chars" % (path.name, len(chunks), len(body)))

    # -- memory ------------------------------------------------------------ #
    def remember(self, prompt, answer):
        self.memory.add(prompt, answer)
        self.history.append({"role": "user", "content": prompt})
        # A long answer is kept in notes and the cache; history holds a stub so the
        # turn window is not eaten by one paragraph and earlier turns stay usable.
        kept = answer if len(answer) <= 600 else answer[:600] + " …"
        self.history.append({"role": "assistant", "content": kept})

        self.last_prompt = prompt
        self.last_answer = answer
        self.save_state()

    def maybe_summarize(self):
        if len(self.history) < 10 or len(self.history) % 5:
            return
        transcript = "\n".join("%s: %s" % (m["role"], m["content"][:400]) for m in self.history[:-4])
        try:
            summary = self.client.complete(
                [
                    {"role": "system", "content": "Compress this conversation into at most 90 words. Keep names, numbers, decisions and open questions."},
                    {"role": "user", "content": transcript},
                ],
                max_tokens=200,
                sampling={"temperature": 0.1},
                kind="memory",
                priority="background",
            )
        except Exception:
            return
        if summary:
            self.summary = summary.strip()
            self.save_state()


# --------------------------------------------------------------------------- #
# demo / bench / repl
# --------------------------------------------------------------------------- #
def counted_turn(chat, prompt):
    """One turn, with the model calls it actually made printed underneath."""
    chat.flush_background()
    began = chat.client.calls
    print("\nYou:", prompt)
    chat.ask(prompt)
    print("[model calls this turn: %d]" % (chat.client.calls - began))


def plan_cost_demo(telemetry):
    """The same multi-part ask under the old plan defaults and the new ones.

    Two arms on separate state folders and caches, so the only difference is the
    plan settings. Prints the call count of the turn and how many of those calls
    the plan pass made: that is what the checklist costs before and after.
    """
    global STATE
    prompt = (
        "explain how a heat pump moves heat instead of making it and why that is "
        "efficient in winter"
    )
    arms = (("before", 2, True, 0.0), ("after", 0, False, PLAN_BUDGET))
    print("\n=== plan pass: one 17-word ask, old defaults vs new ===")
    print("You:", prompt)
    saved = STATE
    try:
        for name, appends, review, budget in arms:
            folder = Path(saved) / ("plan-" + name)
            folder.mkdir(parents=True, exist_ok=True)
            STATE = str(folder)
            client = Client(telemetry=Telemetry(folder / "telemetry.jsonl"), demo=True)
            arm = Chat(
                client,
                AnswerCache(folder / "cache.json"),
                Notes(folder / "notes.json"),
                Telemetry(folder / "telemetry.jsonl"),
                use_draft=False,
            )
            arm.autonote = False
            arm.plan_appends = appends
            arm.plan_review = review
            arm.plan_budget = budget
            arm.ask(prompt)
            plan = arm.last_plan or {}
            print(
                "[%s: plan_appends=%d plan_review=%s plan_budget=%s -> %d model call(s), "
                "%d in the plan pass | %d/%d steps covered%s]"
                % (
                    name,
                    appends,
                    "on" if review else "off",
                    ("%.0fs" % budget) if budget else "none",
                    client.calls,
                    int(plan.get("calls") or 0),
                    plan.get("done", 0),
                    plan.get("total", 0),
                    " | budget reached" if plan.get("stopped") == "budget" else "",
                )
            )
    finally:
        STATE = saved


def run_demo(chat, telemetry):
    print("=== offline demo (no network) ===")
    # Background notes are extra calls nobody waits for; the demo counts the
    # foreground calls of each turn.
    chat.autonote = False
    for prompt in ("what is a ruby", "what is a ruby", "give an example"):
        counted_turn(chat, prompt)
    print("\nYou: /research what is a diamond")
    chat.research("what is a diamond")
    doc = Path(STATE) / "demo-doc.txt"
    doc.write_text(
        "Diamonds are carbon. Rubies are aluminium oxide with chromium. "
        "Both are used as gemstones and both are measured on the Mohs scale.",
        encoding="utf-8",
    )
    print("\nYou: /doc %s" % doc)
    chat.ingest(str(doc))
    counted_turn(chat, "what does the document say about rubies")
    plan_cost_demo(telemetry)
    print_stats(telemetry.path)


def run_bench(client, count):
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": "In one sentence, what makes a desktop automation agent slow?"},
    ]
    rows = []
    for index in range(count):
        result = client.stream(messages)
        rows.append(result)
        rate = ("%5.1f" % result["tps"]) if result["tps"] else "  n/a"
        print(
            "run %2d  ttft %7.1f ms  total %8.1f ms  tok/s %s  chars %4d"
            % (index + 1, result["ttft_ms"], result["total_ms"], rate, len(result["text"]))
        )
    ttft = [r["ttft_ms"] for r in rows]
    total = [r["total_ms"] for r in rows]
    print("\np50 ttft %.1f ms | p95 ttft %.1f ms | p50 total %.1f ms"
          % (percentile(ttft, 50), percentile(ttft, 95), percentile(total, 50)))


HELP = """commands
  /stats              call timings, cache hits, burst-vs-streaming diagnosis
  /notes [query]      list stored notes, or search them
  /note <text>        store a note for later answers
  /doc <path>         ingest a text file so questions can cite its chunks
  /documents          list ingested documents
  /research <q>       plan -> gather -> synthesize, saves notes and next steps
  /vary <q>           same question, new seed and higher temperature
  /variation [n] <q>  ask n times (default 7) and report how different the answers are
  /constraints        standing requirements, re-sent every turn; one-off wording lasts one turn
  /constraints bench 30 turns x 3 placements of the checklist, then compare
  /batch a || b       measure two calls at once against one combined call
  /test-loop          force a repetition and show the guard + replacement
  /review <path>      review a source file, worst problems first
  /ab <q>             same question with and without a reasoning pass
  /followups          propose the next questions from the last answer
  /live [q]           capture the screen now, then read it like an image
  /watch [s] [q]      two captures s apart, then what changed
  /ocr <image>        transcribe text with the OCR model
  /index <path>       index a file or folder into the searchable store
  /recall <words>     search the store, hits go into notes
  /save [name]        save the conversation as a named session
  /load <name>        restore a saved session
  /sessions           list saved sessions
  /dims <images>      sizes, orientation, aspect and what is decodable
  /store              how many chunks are indexed
  /evolve <q> [n]     n rounds, keep the best, log what worked
  /pipeline <q>       exhaust -> fan -> render, with stage timings
  /check [q]          a stronger model audits the last answer
  /write <path>       save the last answer to a file
  /parallel on|off    read several images at once (helps only short replies)
  /image <path> [q]   read an image, then check the model against its pixels
  /frames <a> <b>     pixel diff between two frames, then what changed
  /images [q] <a> <b> ... several images, scored then combined
  /paint <img> [n]    n rounds of looking, then one painted description
  /viewpoint on|off   also show the model's own read of the answer
  /samples <n>        independent vision reads behind the consistency figure
  /preplies           long material set aside; /preply <id> appends it
  /ext                the extension file's settings, features and hooks
  /export [path]      write the conversation as fine-tuning JSONL
  /autonote on|off    keep durable facts from each answer as notes
  /long on|off        answer without the three-sentence cap
  /expand [words]     keep writing past the last answer, no repetition
  /memory             turns, chunks, goal, intent, layers, fast mode
  /layers <n>         critique and rewrite each answer n-1 more times
  /turns <n>          recent turns sent verbatim (default 4)
  /fast on|off        one plain call, no memory assembly (for speed)
  /goal [text|clear]  show, set or clear the standing goal
  /peer [q|keep|merge] independent second answer, then adopt or combine
  /hard               strict review of the last answer, then rewrite
  /mem-bench [q]      measure one plain call against the memory-fed call
  /keep               save the last variation as the answer
  /fix                rewrite the last answer without repetition
  /think on|off       add a separate reasoning pass before each answer
  /temp <0-2>         set sampling temperature
  /context <q>        show what context would be sent for that question
  /code [clear]       show (or forget) the last code block it wrote
  /good | /bad        reward or penalise the last answer (feeds the cache)
  /rewards            recent answer rewards, best and worst first
  /improve            re-check the last script: run it, repair or rewrite it
  /multi a.png b.png  send several images in one request and compare them
  /units 5 km to m    convert units and show the factor used
  /continue           append the rest of the last script and verify it
  /append [file]      append the last script to a file (default script.py)
  /redo               re-analyze the last answer (script, image, or documents)
  /clear              forget conversation history (notes are kept)
  quit
"""


def run_repl(chat, telemetry):
    print("Chat ready. /help for commands, quit to exit.")
    chat.background(chat.warm_up)
    while True:
        try:
            line = input("\nYou: ").strip()
        except (KeyboardInterrupt, EOFError):
            chat.flush_background()
            print("\nGoodbye!")
            return
        if not line:
            continue
        low = line.lower()
        try:
            if low in ("quit", "exit", "/quit", "/exit"):
                chat.flush_background()
                print("Goodbye!")
                return
            if low in ("/help", "?"):
                print(HELP)
            elif low == "/stats":
                print_stats(telemetry.path)
            elif low == "/notes":
                for item in chat.notes.items[-12:]:
                    print("  [%s] %s: %s" % (item["kind"], item["title"], item["text"][:100]))
            elif low.startswith("/notes "):
                for item in chat.notes.search(line[7:], limit=6):
                    print("  [%s] %s: %s" % (item["kind"], item["title"], item["text"][:140]))
            elif low.startswith("/note "):
                chat.notes.add("note", line[6:46], line[6:])
                print("noted")
            elif low.startswith("/doc "):
                chat.ingest(line[5:])
            elif low == "/documents":
                docs = chat.notes.documents()
                print("%d chunk(s) from %d document(s)" % (len(docs), len({d["title"].split(" #")[0] for d in docs})))
                for item in docs[:12]:
                    print("  ", item["title"])
            elif low.startswith("/research "):
                chat.research(line[10:])
            elif low.startswith("/vary"):
                chat.vary(line[5:].strip())
            elif low.startswith("/variation"):
                chat.measure_variation(line[len("/variation"):].strip())
            elif low.startswith("/constraints"):
                chat.constraints_command(line[len("/constraints"):].strip())
            elif low in ("/good", "/bad"):
                chat.rate_answer(1.0 if low == "/good" else -1.0)
            elif low == "/code":
                chat.show_code("")
            elif low.startswith("/code "):
                chat.show_code(line[6:])
            elif low == "/rewards":
                chat.show_rewards()
            elif low == "/improve" or low.startswith("/improve "):
                chat.improve_script(line[8:].strip())
            elif low == "/multi" or low.startswith("/multi "):
                chat.multi_image(line[7:].strip())
            elif low == "/units" or low.startswith("/units "):
                chat.units(line[6:].strip())
            elif low == "/continue":
                chat.continue_last()
            elif low == "/append" or low.startswith("/append "):
                chat.append_last(line[7:].strip())
            elif low.startswith("/redo"):
                chat.redo(line[5:].strip())
            elif low.startswith("/batch"):
                chat.compare_concurrency(line[6:].strip())
            elif low.startswith("/test-loop") or low.startswith("/testloop"):
                chat.test_loop_fixup()
            elif low.startswith("/review"):
                chat.review(line[7:].strip())
            elif low.startswith("/ab"):
                chat.ab_thinking(line[3:].strip())
            elif low.startswith("/followups"):
                chat.brainstorm()
            elif low.startswith("/live"):
                chat.live(line[len("/live"):].strip())
            elif low.startswith("/watch"):
                chat.watch(line[len("/watch"):].strip())
            elif low.startswith("/ocr"):
                chat.ocr(line[len("/ocr"):].strip())
            elif low.startswith("/index"):
                chat.index_path(line[len("/index"):].strip())
            elif low.startswith("/recall"):
                chat.recall(line[len("/recall"):].strip())
            elif low == "/store":
                chat.store_stats()
            elif low.startswith("/evolve"):
                chat.evolve(line[len("/evolve"):].strip())
            elif low.startswith("/pipeline"):
                chat.pipeline(line[len("/pipeline"):].strip())
            elif low.startswith("/check"):
                chat.check_answer(line[len("/check"):].strip())
            elif low.startswith("/write"):
                chat.write_answer(line[len("/write"):].strip())
            elif low.startswith("/dims"):
                chat.dims(line[len("/dims"):].strip())
            elif low.startswith("/save"):
                chat.save_session(line[len("/save"):].strip())
            elif low.startswith("/load"):
                chat.load_session(line[len("/load"):].strip())
            elif low == "/sessions":
                chat.list_sessions()
            elif low.startswith("/autonote"):
                parts = line.split()
                value = parts[1].lower() if len(parts) > 1 else "toggle"
                chat.autonote = (not chat.autonote) if value == "toggle" else value in ("on", "1", "true")
                print("auto notes:", "on" if chat.autonote else "off")
            elif low.startswith("/long"):
                parts = line.split()
                value = parts[1].lower() if len(parts) > 1 else "toggle"
                chat.long_mode = (not chat.long_mode) if value == "toggle" else value in ("on", "1", "true")
                print("long form:", "on (no sentence cap)" if chat.long_mode else "off")
            elif low.startswith("/expand"):
                chat.expand_answer(line[len("/expand"):].strip())
            elif low.startswith("/parallel"):
                parts = line.split()
                value = parts[1].lower() if len(parts) > 1 else "toggle"
                chat.parallel = (not chat.parallel) if value == "toggle" else value in ("on", "1", "true")
                print(
                    "parallel image reads:",
                    "on (measured: 1.5x on tiny replies, 1.05x at 110 tokens)" if chat.parallel else "off",
                )
            elif low.startswith("/images "):
                chat.images(line[8:])
            elif low.startswith("/image "):
                chat.image(line[7:])
            elif low.startswith("/frames "):
                chat.frames(line[8:])
            elif low.startswith("/paint"):
                chat.paint(line[6:])
            elif low.startswith("/viewpoint"):
                parts = line.split()
                value = parts[1].lower() if len(parts) > 1 else "toggle"
                chat.viewpoint = (not chat.viewpoint) if value == "toggle" else value in ("on", "1", "true")
                print("viewpoint:", "on" if chat.viewpoint else "off")
            elif low.startswith("/samples"):
                try:
                    chat.vision_samples = max(1, min(4, int(line.split()[1])))
                    print("vision reads:", chat.vision_samples)
                except (IndexError, ValueError):
                    print("usage: /samples 2")
            elif low == "/preplies":
                chat.show_preplies()
            elif low.startswith("/preply"):
                chat.use_preply(line[7:])
            elif low == "/ext":
                if chat.ext is None:
                    print("fast_chat_ext.py not loaded (set ENABLED = True in it)")
                else:
                    chat.ext.report()
            elif low.startswith("/export"):
                if chat.ext is None:
                    print("fast_chat_ext.py not loaded (set ENABLED = True in it)")
                else:
                    chat.ext.export_training(chat, line[len("/export"):].strip())
            elif low == "/memory":
                chat.show_memory()
            elif low.startswith("/layers"):
                try:
                    chat.layers = max(1, min(6, int(line.split()[1])))
                    print("layers:", chat.layers, "(1 = first answer)")
                except (IndexError, ValueError):
                    print("usage: /layers 2")
            elif low.startswith("/turns"):
                try:
                    chat.turns_window = max(1, min(10, int(line.split()[1])))
                    print("verbatim turns:", chat.turns_window)
                except (IndexError, ValueError):
                    print("usage: /turns 4")
            elif low.startswith("/fast"):
                parts = line.split()
                value = parts[1].lower() if len(parts) > 1 else "toggle"
                chat.fast_mode = (not chat.fast_mode) if value == "toggle" else value in ("on", "1", "true")
                print("fast mode:", "on (one call, no memory)" if chat.fast_mode else "off (memory + layers)")
            elif low.startswith("/goal"):
                argument = line[5:].strip()
                if not argument:
                    print("goal:", chat.memory.goal or "(none)")
                    print("progress: %.0f%%" % (chat.memory.goal_progress() * 100))
                elif argument.lower() in ("clear", "none", "off"):
                    chat.memory.goal = ""
                    chat.memory.save()
                    chat.goal_reported = False
                    print("goal cleared")
                else:
                    chat.memory.goal = argument[:300]
                    chat.memory.save()
                    chat.goal_reported = False
                    print("goal:", chat.memory.goal)
            elif low.startswith("/peer"):
                chat.peer(line[5:].strip())
            elif low == "/hard":
                chat.hard_review()
            elif low.startswith("/mem-bench") or low.startswith("/membench"):
                chat.compare_memory(line.split(" ", 1)[1] if " " in line else "")
            elif low == "/keep":
                chat.keep()
            elif low == "/fix":
                if chat.last_answer:
                    fixed = chat.revise(chat.last_prompt, chat.last_answer, chat.context_for(chat.last_prompt))
                    if fixed:
                        chat.last_answer = fixed
                        Writer().answer(fixed)
                else:
                    print("no answer to fix yet")
            elif low.startswith("/think"):
                value = line.split()[-1].lower() if len(line.split()) > 1 else ""
                if value in ("on", "off", "auto"):
                    chat.think_mode = value
                print("thinking:", chat.think_mode, "(on = a reasoning call before every answer)")
            elif low.startswith("/temp "):
                try:
                    chat.client.sampling["temperature"] = max(0.0, min(2.0, float(line.split()[-1])))
                    print("temperature:", chat.client.sampling["temperature"])
                except ValueError:
                    print("usage: /temp 0.7")
            elif low.startswith("/context "):
                print(chat.context_for(line[9:]) or "(no notes match)")
            elif low == "/clear":
                chat.history.clear()
                chat.summary = ""
                chat.memory.clear()
                chat.save_state()
                print("conversation and memory cleared (notes and cache kept)")
            else:
                chat.ask(line)
        except KeyboardInterrupt:
            print("\n(interrupted - the conversation is still open)")
        except Exception as err:  # noqa: BLE001
            # One bad turn must never end the session: name the failure, keep the
            # state that already exists, and go straight back to the prompt.
            if os.environ.get("FASTCHAT_DEBUG"):
                traceback.print_exc()
            print("\nerror: %s: %s" % (type(err).__name__, err))
            print("[turn failed - the session is still open; ask again or try /memory]")
            try:
                chat.save_state()
            except Exception:  # noqa: BLE001 - saving must not break the loop either
                pass


def run_selftest():
    """Network-free checks of the pure parts. Exit code 1 on any failure."""
    results = []

    def check(name, actual, expected):
        ok = actual == expected
        results.append(ok)
        print("  %-38s %s" % (name, "ok" if ok else "FAIL got %r want %r" % (actual, expected)))

    guard = LoopGuard(n=4, repeats=2)
    check("loop guard fires on repeat", any(guard.feed(word + " ") for word in "a b c d a b c d".split()), True)
    check("loop guard quiet on fresh text", LoopGuard(n=4, repeats=2).feed("one two three four"), False)
    check("colour red", colour_name(200, 30, 30), "red")
    check("colour blue", colour_name(30, 60, 200), "blue")
    check("colour grey", colour_name(128, 128, 128), "grey")
    check("colour white", colour_name(250, 250, 250), "white")
    check("intent repeat", classify_intent("what is a ruby", "what is a ruby", "a gem"), "repeat")
    check("intent extend", classify_intent("more", "what is a ruby", "a gem"), "extend")
    check("intent new", classify_intent("what is a sapphire", "what is a ruby", "a red gem"), "new")
    check("intent contrast", classify_intent("compare ruby and sapphire", "what is a ruby", "a gem"), "contrast")
    check("novelty of a repeat", round(novelty("A ruby is red and hard.", ["a ruby is red and hard."]), 2), 0.0)
    check("novelty of new text", novelty("Quartz is silicon dioxide.", ["a ruby is red and hard."]), 1.0)
    check("short answer scores", score_candidate("Corundum is aluminium oxide with chromium.", "what is corundum") > -1.0, True)
    check("short fragment rejected", score_candidate("too short", "what"), -1.0)
    check("agreement of equals", round(agreement("ruby is red", "ruby is red"), 2), 1.0)
    chunks = chunk_by_tokens("One sentence here. " * 40, budget=40)
    check("chunks split", len(chunks) > 1, True)
    check("chunks end on sentences", all(chunk.strip().endswith(".") for chunk in chunks), True)
    blob = write_png(4, 2, [bytes([200, 30, 30] * 4), bytes([30, 30, 200] * 4)])
    width, height, _channels, _colour_type, _palette, rows = png_pixels(blob)
    check("png round trip size", (width, height), (4, 2))
    check("png round trip pixel", tuple(rows[0][:3]), (200, 30, 30))
    check("png header size", png_size(blob), (4, 2))
    check("pixel_rgb grey", pixel_rgb(bytes([7, 9, 11, 13]), 2, 1, 0, b""), (11, 11, 11))
    check("pixel_rgb palette", pixel_rgb(bytes([1]), 0, 1, 3, bytes([0, 0, 0, 10, 20, 30])), (10, 20, 30))
    check("pixel_rgb rgba", pixel_rgb(bytes([1, 2, 3, 4, 5, 6, 7, 8]), 1, 4, 6, b""), (5, 6, 7))
    wide_rows = [bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])] * 2
    shrunk = shrink_rows(4, 2, 3, 2, b"", wide_rows, 2)
    check("shrink_rows size", (len(shrunk[0]) // 3, len(shrunk)), (2, 1))
    check("shrink_rows keeps first pixel", tuple(shrunk[0][:3]), (1, 2, 3))
    check("shrink_rows keeps stride pixel", tuple(shrunk[0][3:6]), (7, 8, 9))
    screen_like = {
        "decoded": True,
        "width": 8,
        "height": 6,
        "mean_rgb": (1, 2, 3),
        "dominant_colour": "red",
        "contrast": 0.0,
        "colours": ["red"],
    }
    check("describe_pixels tolerates a screen frame", describe_pixels(screen_like).startswith("[pixels 8x6"), True)
    check("orientation landscape", orientation_of(1600, 900), "landscape")
    check("orientation portrait", orientation_of(900, 1600), "portrait")
    flat = {"decoded": True, "signature": [[10.0] * 32 for _ in range(18)], "width": 100, "height": 50}
    other = {"decoded": True, "signature": [[200.0] * 32 for _ in range(18)], "width": 400, "height": 200}
    check("frame diff identical", frame_change(flat, flat)["fraction"], 0.0)
    check("frame diff across sizes", round(frame_change(flat, other)["fraction"], 2), 1.0)
    check("frame diff needs pixels", frame_change({"decoded": False}, flat), None)
    check("rrf keeps both lists", len(rrf_merge([{"path": "a", "body": "A"}], [{"path": "b", "body": "B"}])), 2)
    check("rrf puts agreement first", rrf_merge([{"path": "a", "body": "A"}, {"body": "B"}], [{"path": "a", "body": "A"}])[0]["body"], "A")
    meta_text = (
        "As instructed, I need to check my constraints against this conversation: the requested "
        "response is to follow the formatting rules."
    )
    check(
        "meta answer scores lower",
        score_candidate(meta_text, "what is a ruby")
        < score_candidate(
            "Corundum is aluminium oxide, and chromium traces in its crystal lattice make the stone red.",
            "what is a ruby",
        ),
        True,
    )
    temp = Path(tempfile.mkdtemp(prefix="fastchat-selftest-"))
    try:
        store = Store(temp / "selftest.db")
        store.add_many(
            [
                ("a.txt", "chromium impurities give rubies their deep red colour"),
                ("b.txt", "sapphire is blue corundum with iron and titanium"),
                ("c.txt", "the weather today is mild and cloudy"),
            ]
        )
        log = temp / "rotate.jsonl"
        log.write_text("\n".join('{"n": %d}' % i for i in range(6)) + "\n", encoding="utf-8")
        rotate_jsonl(log, max_bytes=1, keep_lines=2)
        check("jsonl rotation keeps tail", len(log.read_text(encoding="utf-8").strip().splitlines()), 2)
        cat_list = (
            "A cat is a small carnivorous mammal. It hunts, then sleeps. Cats descend from wild "
            "felines: lions, tigers, leopards, jaguars, cheetahs, lynxes, cougars, caracals, "
            "servals, ocelots, eagles, ospreys, kites, hawks, falcons, vultures, owls, parrots, "
            "pigeons, starlings, robins, magpies, jays, woodpeckers, finches, warblers, thrushes, "
            "swallows, swifts, martens, weasels, badgers, foxes, wolves, coyotes, bobcats, "
            "rabbits, squirrels, beavers, otters, mice, voles, shrews, bats, frogs, snakes."
        )
        check("rambles catches a runaway list", bool(rambles(cat_list)), True)
        stripped = cat_list.replace(",", "")
        check("rambles catches a comma-free list", bool(rambles(stripped)), True)
        check(
            "rambles passes a normal answer",
            rambles("A cat is a small domesticated mammal. It hunts rodents and sleeps most of the day."),
            None,
        )
        expiry = AnswerCache(temp / "cache_test.json")
        expiry.put("what is a cat", "first answer", "test", turn=3)
        check("cache honours the cooldown", expiry.get("what is a cat", turn=5, min_gap=10), None)
        check(
            "cache serves after the cooldown",
            (expiry.get("what is a cat", turn=13, min_gap=10) or ("", 0.0))[0],
            "first answer",
        )
        check("cache recent ignores the cooldown", expiry.recent("what is a cat"), "first answer")
        check("wants_list spots a request for a list", wants_list("name as many animals as you can"), True)
        ok_net, _net = run_script("import socket\nsocket.create_connection(('example.com', 80), 1)")
        check("sandbox blocks network", ok_net, False)
        ok_out, _out = run_script("open('../escape.txt', 'w').write('x')")
        check("sandbox blocks writes outside its folder", ok_out, False)
        ok_in, _in = run_script("open('inside.txt', 'w').write('x')")
        check("sandbox allows writes inside its folder", ok_in, True)
        blocks = extract_code("Here:" + chr(10) + "```python" + chr(10) + "import tkinter as tk" + chr(10) + "```")
        check("extract_code finds a fenced block", len(blocks), 1)
        check("extract_code keeps the body", "tkinter" in (blocks[0] if blocks else ""), True)
        check("extract_code keeps a one-liner", extract_code("def add(a, b): return a + b"), ["def add(a, b): return a + b"])
        check("extract_code ignores prose", extract_code("A cat is a small mammal."), [])
        check("has_code_block spots a one-liner", has_code_block("def add(a, b): return a + b"), True)
        check("has_code_block rejects a prose list", has_code_block("lions, tigers, leopards, jaguars"), False)
        check("wants_code spots a script request", wants_code("give me a simple calc app script in python"), True)
        check("wants_code ignores a normal question", wants_code("what is a diamond"), False)
        check("wants_code treats code and script alike", wants_code("fix this code"), True)
        check("wants_code ignores a decorator question", wants_code("what is a python decorator"), False)
        check(
            "constraint: word cap spotted",
            [(item["kind"], item["value"]) for item in detect_constraints("keep it under 60 words")],
            [("max_words", 60)],
        )
        check(
            "constraint: a bare request is one-off",
            [item["scope"] for item in detect_constraints("keep it under 60 words")],
            ["once"],
        )
        check(
            "constraint: briefly is one-off",
            [(item["kind"], item["value"], item["scope"])
             for item in detect_constraints("briefly explain why rubies are red")],
            [("max_words", 60, "once")],
        )
        check(
            "constraint: from now on is standing",
            [(item["kind"], item["value"], item["scope"])
             for item in detect_constraints("from now on answer in 2 sentences")],
            [("max_sentences", 2, "standing")],
        )
        check(
            "constraint: every answer is standing",
            [item["scope"] for item in detect_constraints("keep every answer under 80 words")],
            ["standing"],
        )
        check(
            "constraint: a contrasting clause keeps its own scope",
            sorted((item["kind"], item["scope"]) for item in detect_constraints(
                "From now on be brief, but this time in 5 sentences.")),
            [("max_sentences", "once"), ("max_words", "standing")],
        )
        check(
            "constraint: add makes anything standing",
            [item["scope"] for item in detect_constraints("briefly", scope="standing")],
            ["standing"],
        )
        check(
            "constraint: a question states none",
            detect_constraints("what is a ruby and why is it red"),
            [],
        )
        check(
            "constraint: sentence cap spotted",
            [(item["kind"], item["value"]) for item in detect_constraints("answer in three sentences")],
            [("max_sentences", 3)],
        )
        check(
            "constraint: format, tone and library spotted",
            sorted(item["kind"] for item in detect_constraints(
                "use bullet points, no emoji, and use only the python standard library")),
            ["list", "no_emoji", "stdlib"],
        )
        check("constraint: a plain question states none", detect_constraints("what is a diamond"), [])
        check(
            "constraint: a long answer breaks a word cap",
            constraint_holds({"kind": "max_words", "value": 60}, "word " * 70),
            False,
        )
        check(
            "constraint: a short answer keeps it",
            constraint_holds({"kind": "max_words", "value": 60}, "Corundum is aluminium oxide."),
            True,
        )
        check("constraint: bullets are seen", constraint_holds({"kind": "list"}, "- red\n- hard\n"), True)
        check("constraint: prose is not a list", constraint_holds({"kind": "list"}, "A ruby is red."), False)
        check("constraint: a tone rule is not scored", constraint_holds({"kind": "note"}, "anything"), None)
        check(
            "plan: numbered steps are parsed",
            plan_steps("1. how heat moves\n2. why it is efficient"),
            ["how heat moves", "why it is efficient"],
        )
        check(
            "plan: marks are read, not kept in the step",
            plan_marks("1. how heat moves COVERED\n2. why it is efficient MISSING"),
            [("how heat moves", True), ("why it is efficient", False)],
        )
        check(
            "plan: an unmarked step is left for the local check",
            [ok for _step, ok in plan_marks("1. how heat moves")],
            [None],
        )
        check("plan: the words are camel-proof", plan_marks("1. how it is done")[0][1], None)
        check(
            "plan: a preamble line is not a step",
            plan_steps("Here are the steps:\n- how heat moves"),
            ["how heat moves"],
        )
        check("plan: steps dedupe", plan_steps("1. how heat moves\n2. How heat moves."), ["how heat moves"])
        check(
            "plan: steps are capped",
            len(plan_steps("\n".join("%d. step %d here" % (i, i) for i in range(1, 10)))),
            6,
        )
        check(
            "plan: a covered step is seen",
            step_covered("how heat moves", "A pump moves heat with a compressor."),
            True,
        )
        check(
            "plan: an absent step is seen",
            step_covered("why it is efficient", "A pump moves heat with a compressor."),
            False,
        )
        check("plan: a step with no content words counts as covered", step_covered("the how", "x"), True)
        check(
            "plan: the report counts what is done",
            plan_report(["how heat moves", "why it is efficient"], "It moves heat.")["done"],
            1,
        )
        register = Constraints(temp / "constraints.json")
        register.add({"kind": "max_words", "value": 60, "text": "At most 60 words"}, turn=1)
        register.add({"kind": "max_words", "value": 60, "text": "At most 60 words"}, turn=2)
        check("constraint: a restated rule is stored once", len(register.items), 1)
        register.add({"kind": "max_words", "value": 30, "text": "At most 30 words"}, turn=3)
        check("constraint: a new number replaces the old one", register.items[0]["value"], 30)
        check("constraint: the checklist is numbered", register.checklist().splitlines()[1], "1. At most 30 words.")
        check(
            "constraint: the checklist survives a reload",
            len(Constraints(temp / "constraints.json").items),
            1,
        )
        register.add({"kind": "no_emoji", "text": "No emoji"}, turn=4)
        register.add({"kind": "no_table", "text": "Do not use a table"}, turn=5)
        register.drop("1")
        check(
            "constraint: numbers close after a drop",
            register.checklist().splitlines()[1],
            "1. No emoji.",
        )
        check("constraint: the drop is persisted", len(Constraints(temp / "constraints.json").items), 2)
        check("wants_code ignores explain-a-script", wants_code("explain how this script works"), False)
        check("wants_code sees an edit request", wants_code("improve on the app"), True)
        check("wants_code sees a calc edit", wants_code("improve on the calc"), True)
        check("wants_code sees an update", wants_code("update the game"), True)
        check("sample input for a calc", sample_input("simple calc app"), "5\n+\n3\nquit\n")
        ok_run, _report = run_script("print(2 + 3)")
        check("run_script accepts a working script", ok_run, True)
        bad_run, bad_report = run_script("print(1 / 0)")
        check("run_script rejects a failing script", bad_run, False)
        check("run_script reports the failure", bool(bad_report), True)
        check(
            "split_intro keeps the sentence",
            split_intro("Here it is:" + chr(10) + "```python" + chr(10) + "print(1)" + chr(10) + "```")[0],
            "Here it is",
        )
        check(
            "code_quality prefers a fenced script",
            code_quality("```python" + chr(10) + "def add(a, b):" + chr(10) + "    return a + b" + chr(10) + "```")
            > code_quality("A calculator can be built using Python and math modules. This approach works well."),
            True,
        )
        check("has_code_block accepts one print line", has_code_block("print(add(1, 2))"), True)
        check("script_ok accepts a small function", script_ok("def add(a, b):\n    return a + b", python=True), True)
        check("script_ok rejects a dangling header", script_ok("def add(a, b):", python=True), False)
        check("script_ok rejects an unclosed call", script_ok("print(add(1, 2)", python=True), False)
        looped = chr(10).join(["def add(a: float | int) -> None:"] * 5)
        check("script_ok rejects a repeated line", script_ok(looped, python=True), False)
        check(
            "script_issues finds a nested main",
            bool(script_issues("def outer():" + chr(10) + "    def main():" + chr(10) + "        pass" + chr(10) + "    return 1")),
            True,
        )
        check("script_issues accepts clean code", script_issues("def add(a, b):" + chr(10) + "    return a + b"), [])
        class_main = "class Calc:" + chr(10) + "    def main(self):" + chr(10) + "        return 1"
        check("script_issues allows a class main method", script_issues(class_main), [])
        star = "from math import *" + chr(10) + "print(sqrt(9))"
        check("script_issues tolerates star imports", script_issues(star), [])
        called_nested = (
            "def outer():" + chr(10) + "    def main():" + chr(10) + "        return 1" + chr(10)
            + "    return main()"
        )
        check("script_issues allows a nested main it calls", script_issues(called_nested), [])
        check("units convert km to m", convert_units("5 km to m")[0].splitlines()[0], "5 km = 5000 m")
        check("units convert C to F", convert_units("100 c to f")[0].splitlines()[0], "100 c = 212 f")
        check("units show the factor used", "via:" in convert_units("5 km to m")[0], True)
        check("units reject a dimension mismatch", convert_units("5 km to kg")[1], False)
        check("units default to the base unit", convert_units("3 kwh")[0].splitlines()[0], "3 kwh = 10800000 j")
        check("wants_continuation sees a cut answer", wants_continuation("word " * 70), True)
        check("wants_continuation ignores a finished answer", wants_continuation(("word " * 70) + "."), False)
        check("wants_continuation ignores short text", wants_continuation("short and cut"), False)
        check("near_duplicate sees the same answer", near_duplicate("Cats are mammals.", "Cats are mammals."), True)
        check("near_duplicate allows a new answer", near_duplicate("Cats are mammals.", "Gold is a metal."), False)
        mem_store = Memory(temp / "memory_incremental.json", limit=0)
        for number in range(1, 6):
            mem_store.add("q%d pyrite" % number, ("a%d pyrite colour. " % number) * 4)
        before = len(mem_store.chunks)
        mem_store.add("q6 pyrite", "a6 pyrite colour. " * 4)
        check("memory indexes incrementally", len(mem_store.chunks) > before, True)
        check("memory tracks the indexed turn", mem_store.indexed, 6)
        mem_store.save(force=True)
        mem_reopened = Memory(temp / "memory_incremental.json", limit=0)
        check("memory reloads its chunks", len(mem_reopened.chunks), len(mem_store.chunks))
        check("older turn still retrievable", bool(mem_reopened.retrieve("pyrite colour a1")), True)
        long_memory = Memory(temp / "memory_window.json", limit=0)
        for number in range(1, 5):
            long_memory.add("question %d" % number, "word " * 400)
        windowed = long_memory.window(200)
        spent = sum(token_count(message["content"]) for message in windowed)
        check("verbatim window respects the token budget", spent <= 260, True)
        check("newest turn survives budget trimming", bool(windowed) and windowed[-1]["role"] == "assistant", True)
        short_memory = Memory(temp / "memory_window_short.json", limit=0)
        for number in range(1, 5):
            short_memory.add("question %d" % number, "short answer %d." % number)
        check("short turns all fit the budget", len(short_memory.window(200)), 8)
        check("tidy_answer bounds a rambling block", len(tidy_answer("word, " * 400)) <= 901, True)
        check("tidy_answer keeps a short answer whole", tidy_answer("Cats are mammals."), "Cats are mammals.")
        check("chunks carry their terms", bool(mem_store.chunks[0].get("words")), True)
        grow = Memory(temp / "memory_grow.json", limit=0)
        for number in range(1, 101):
            grow.add("q%d" % number, "answer %d about gold. " % number)
        check("chunks are kept, not dropped", len(grow.chunks), 200)
        check(
            "user turns are indexed",
            any(chunk.get("role") == "asked" for chunk in grow.chunks),
            True,
        )
        check("memory snapshots are throttled", grow.saves < 100, True)
        broken = "def calc():" + chr(10) + "print('hi')" + chr(10) + "            return 1"
        check("fix_indent repairs python blocks", script_ok(fix_indent(broken), python=True), True)
        poisoned = AnswerCache(temp / "poison_cache.json")
        poisoned.put("what is gold", "a confident but wrong answer", "test", turn=0, reward=0.9)
        check(
            "cache serves a high-reward answer",
            (poisoned.get("what is gold", turn=99, min_gap=0) or ("", 0.0))[0],
            "a confident but wrong answer",
        )
        check("poison finds the cached answer", poisoned.poison("what is gold"), True)
        check("poison stops the replay", poisoned.get("what is gold", turn=99, min_gap=0), None)
        check("code follow-up asks to edit", code_followup("improve on the app"), True)
        check("plain question is not a code follow-up", code_followup("what is a cat"), False)
        repeated = "Cats are mammals. Cats are mammals. Cats are mammals. Cats are mammals."
        fresh_answer = "Cats are small mammals that hunt rodents at night and sleep through the day."
        check(
            "rewards prefer fresh answers",
            score_answer(fresh_answer, "what is a cat")["total"]
            > score_answer(repeated, "what is a cat")["total"],
            True,
        )
        check(
            "rewards prefer grounded answers",
            score_answer("Pyrite is iron sulphide.", "what is pyrite", "pyrite is iron sulphide with a pale brass colour")["grounded"],
            1.0,
        )
        gate = AnswerCache(temp / "reward_cache.json")
        gate.put("what is gold", "a bad answer", "test", turn=0, reward=0.2)
        check("cache skips low-reward answers", gate.get("what is gold", turn=99, min_gap=0), None)
        check("wants_list leaves a question alone", wants_list("what is a cat"), False)
        check(
            "rambles catches a semicolon list",
            bool(rambles("A dog; a bird; " + "; ".join(["a fish"] * 20))),
            True,
        )
        bloated = (
            [{"role": "system", "content": "s" * 400}]
            + [{"role": "user", "content": "x" * 400}] * 20
            + [{"role": "user", "content": "question"}]
        )
        fitted = fit_messages(bloated, 600)
        check("fit_messages keeps the question", fitted[-1]["content"], "question")
        check("fit_messages drops old turns", len(fitted) < len(bloated), True)
        check(
            "fit_messages stays under budget",
            sum(message_tokens(m) for m in fitted) <= 600,
            True,
        )
        check("force_drop removes that many turns", len(fit_messages(bloated, 100000, force_drop=2)), len(bloated) - 2)
        flat = [bytes([5, 5, 5]) * 400] * 200
        picture = base64.b64encode(write_png(400, 200, flat)).decode()
        check("image_tokens reads the header", image_tokens(picture), 96)
        check("image_size reads the header", image_size(picture), (400, 200))
        smaller = shrink_payload(picture, 0.5)
        check("shrink_payload halves the image", image_size(smaller), (200, 100))
        check("shrink_payload lowers the estimate", image_tokens(smaller) < image_tokens(picture), True)

        original_thumb = gdiplus_thumbnail

        def fake_thumb(path, max_side=None):
            return 200, 100, [bytes([9, 9, 9]) * 200] * 100, (640, 400)

        # minimal JPEG header with an SOF0 frame: 640x400, three components
        fake_jpeg = base64.b64encode(
            b"\xff\xd8\xff\xc0\x00\x11\x08\x01\x90\x02\x80\x03" + b"\x00" * 32
        ).decode()
        check("a JPEG header is readable", image_size(fake_jpeg), (640, 400))
        globals()["gdiplus_thumbnail"] = fake_thumb
        try:
            shrunk_jpeg = shrink_payload(fake_jpeg, 0.5)
        finally:
            globals()["gdiplus_thumbnail"] = original_thumb
        check("shrink_payload handles JPEG", image_size(shrunk_jpeg), (200, 100))
        with_picture = [
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": "what is this", "images": [picture]},
        ]
        check("message_tokens counts images", message_tokens(with_picture[1]) > 90, True)

        import contextlib
        import io

        class StubClient:
            """No network: replays canned text and counts the calls it got."""

            def __init__(self, replies=None, fail_at=0):
                self.replies = list(replies or ["A cat is a small domesticated mammal."])
                self.fail_at = fail_at
                self.asks = 0
                self.completes = 0
                self.messages = []

            def ask(self, messages, on_token=None, on_thinking=None, guard=None, max_tokens=None, **kw):
                self.asks += 1
                self.messages = messages
                if self.asks == self.fail_at:
                    raise RuntimeError("request (5000 tokens) exceeds the available context size (4096 tokens)")
                text = self.replies[min(self.asks - 1, len(self.replies) - 1)]
                if on_token:
                    on_token(text, None)
                return {"text": text, "model": "stub", "total_ms": 1.0, "ttft_ms": 0.5, "tps": 5.0}

            def complete(self, messages, **kw):
                self.completes += 1
                return "Cats are small carnivorous mammals."

        def quiet(fn, *args, **kwargs):
            with contextlib.redirect_stdout(io.StringIO()):
                return fn(*args, **kwargs)

        saved_state = globals().get("STATE")
        try:
            def build(client, folder):
                path = temp / folder
                path.mkdir(exist_ok=True)
                globals()["STATE"] = str(path)
                made = Chat(
                    client,
                    AnswerCache(path / "cache.json"),
                    Notes(path / "notes.json"),
                    Telemetry(path / "tel.jsonl"),
                    use_draft=False,
                )
                made.fast_mode = True
                made.autonote = False
                made.think_mode = "off"
                return made

            cooldown = StubClient(
                replies=[
                    "A cat is a small domesticated mammal.",
                    "Cats are carnivorous mammals with retractable claws.",
                ]
            )
            chat_a = build(cooldown, "ask1")
            first = quiet(chat_a.ask, "what is a cat")
            second = quiet(chat_a.ask, "what is a cat")
            check("repeat asks the model again", cooldown.asks, 2)
            check("repeat gets a different answer", first != second, True)
            check(
                "repeat is handed the earlier answer",
                any("Earlier answer" in str(m.get("content", "")) for m in cooldown.messages),
                True,
            )

            rambling_text = (
                "A cat is a mammal, "
                + ", ".join(
                    [
                        "lions", "tigers", "leopards", "jaguars", "cheetahs", "lynxes", "cougars",
                        "caracals", "servals", "ocelots", "eagles", "ospreys", "kites", "hawks",
                        "falcons", "vultures", "owls", "parrots", "pigeons", "starlings", "robins",
                        "magpies", "jays", "woodpeckers", "finches", "warblers", "thrushes", "swifts",
                        "martens", "weasels", "badgers", "foxes", "wolves", "coyotes", "bobcats",
                        "rabbits", "squirrels", "beavers", "otters", "mice", "voles",
                    ]
                )
                + "."
            )
            messy = StubClient(replies=[rambling_text])
            chat_b = build(messy, "ask2")
            rewritten = quiet(chat_b.ask, "what is a cat")
            check("a rambling answer is trimmed", len(rewritten) <= 901, True)
            check("a rambling answer costs no second call", messy.completes, 0)

            asked_for_list = StubClient(replies=[rambling_text])
            chat_c = build(asked_for_list, "ask3")
            kept = quiet(chat_c.ask, "name as many animals as you can")
            check("a requested list is kept", kept, rambling_text)
            check("a requested list is not rewritten", asked_for_list.completes, 0)

            long_form = StubClient(replies=[rambling_text])
            chat_d = build(long_form, "ask4")
            chat_d.long_mode = True
            kept_long = quiet(chat_d.ask, "what is a cat")
            check("a long-form answer is kept", kept_long, rambling_text)
            check("long form is not rewritten", long_form.completes, 0)

            overflow = StubClient(replies=["Short answer."], fail_at=2)
            chat_e = build(overflow, "ask5")
            quiet(chat_e.ask, "what is a cat")
            recovered = quiet(chat_e.ask, "what is a cat")
            check("context overflow is retried", overflow.asks, 3)
            check("context overflow still answers", recovered, "Short answer.")
            briefed = build(StubClient(replies=["word " * 70]), "constraints")
            briefed.constraints.add({"kind": "max_words", "value": 60, "text": "At most 60 words"})
            sent = briefed.messages_for("what is a cat", "", window_tokens=0)
            check("checklist reaches the system prompt", "At most 60 words" in sent[0]["content"], True)
            briefed.constraint_inject = False
            without = briefed.messages_for("what is a cat", "", window_tokens=0)
            check("checklist can be switched off", "At most 60 words" in without[0]["content"], False)
            briefed.constraint_inject = True
            beside = briefed.messages_for("what is a cat", "", window_tokens=0)
            check(
                "the checklist is repeated beside the question",
                "At most 60 words" in beside[-1]["content"],
                True,
            )
            briefed.constraint_recency = False
            system_only = briefed.messages_for("what is a cat", "", window_tokens=0)
            check(
                "the repetition can be switched off",
                "At most 60 words" in system_only[-1]["content"],
                False,
            )
            briefed.constraint_recency = True
            check(
                "checklist flags a broken length",
                constraint_report(briefed.constraints.items, "word " * 70)["held"],
                0,
            )
            check(
                "checklist passes a short answer",
                constraint_report(briefed.constraints.items, "Corundum is aluminium oxide.")["held"],
                1,
            )
            heard = build(StubClient(replies=["ok"]), "constraints2")
            quiet(heard.capture_constraints, "from now on keep every answer under 40 words")
            check(
                "a standing requirement is stored",
                [(item["kind"], item["value"]) for item in heard.constraints.items],
                [("max_words", 40)],
            )
            quiet(heard.capture_constraints, "briefly: what is a ruby")
            check(
                "a one-off remark is not stored",
                (len(heard.constraints.items), [item["kind"] for item in heard.turn_constraints]),
                (1, ["max_words"]),
            )
            one_off_sent = heard.messages_for("what is a ruby", "", window_tokens=0)
            check(
                "the one-off rides with this question",
                "For this answer only" in one_off_sent[-1]["content"],
                True,
            )
            check(
                "the one-off stays out of the system prompt",
                "For this answer only" in one_off_sent[0]["content"],
                False,
            )
            check(
                "the standing rule is still in the system prompt",
                "At most 40 words" in one_off_sent[0]["content"],
                True,
            )
            quiet(heard.capture_constraints, "what is a diamond")
            next_turn = heard.messages_for("what is a diamond", "", window_tokens=0)
            check(
                "the one-off is gone on the next turn",
                "For this answer only" in next_turn[-1]["content"],
                False,
            )
            quiet(
                heard.capture_constraints,
                "From now on answer in 2 sentences, but this time in 300 words.",
            )
            check(
                "one message can hold both scopes",
                (
                    [(item["kind"], item["value"]) for item in heard.constraints.items],
                    [(item["kind"], item["value"]) for item in heard.turn_constraints],
                ),
                ([("max_words", 40), ("max_sentences", 2)], [("max_words", 300)]),
            )
            listing = io.StringIO()
            with contextlib.redirect_stdout(listing):
                heard.show_constraints()
            shown = listing.getvalue()
            check(
                "the listing shows the two scopes apart",
                ("standing requirement" in shown, "last turn only" in shown, "300" in shown),
                (True, True, True),
            )
            quiet(heard.constraints_command, "add briefly")
            check(
                "/constraints add stores a one-off for good",
                ([(item["kind"], item["value"]) for item in heard.constraints.items],
                 [item["kind"] for item in heard.turn_constraints]),
                ([("max_words", 60), ("max_sentences", 2)], ["max_words"]),
            )

            class PlanStub:
                """A checklist on demand, then one answer per call."""

                def __init__(self, checklist="", tails=()):
                    self.checklist = checklist
                    self.tails = list(tails)
                    self.asks = 0

                def complete(self, messages, **kw):
                    return self.checklist

                def ask(self, messages, on_token=None, on_thinking=None, **kw):
                    self.asks += 1
                    reply = self.tails.pop(0) if self.tails else "Done."
                    if on_token:
                        on_token(reply, None)
                    return {
                        "text": reply,
                        "model": "stub",
                        "total_ms": 1.0,
                        "ttft_ms": 1.0,
                        "tps": 1.0,
                    }

            gate = build(PlanStub(""), "plan0")
            gate.fast_mode = False
            check("plan: auto skips a one-line question", gate.wants_plan("what is a diamond"), False)
            check(
                "plan: auto plans a multi-part ask",
                gate.wants_plan("compare a heat pump and a furnace, and explain why each wins"),
                True,
            )
            gate.plan_mode = "off"
            check("plan: off never plans", gate.wants_plan("compare a and b, and explain why"), False)
            gate.plan_mode = "on"
            check("plan: on always plans", gate.wants_plan("what is a diamond"), True)

            plan_stub = PlanStub(
                "1. how heat moves COVERED\n2. why it is efficient MISSING",
                ["It is efficient because it moves heat instead of making it."],
            )
            planner = build(plan_stub, "plan1")
            planner.fast_mode = False
            planner.plan_appends = 2
            planner.plan_budget = 0.0
            short = "A heat pump moves heat with a compressor."
            joined = quiet(planner.plan_turn, "how does a heat pump work", short)
            check("plan: the missing step is appended", "efficient" in joined, True)
            check(
                "plan: the checklist is ticked off",
                (planner.last_plan["done"], planner.last_plan["total"]),
                (2, 2),
            )
            check("plan: it stops once every step is covered", plan_stub.asks, 1)

            quiet_stub = PlanStub("1. how heat moves COVERED\n2. why it is efficient COVERED")
            complete = build(quiet_stub, "plan2")
            complete.fast_mode = False
            done_text = "A heat pump moves heat. It is efficient because it moves heat, not makes it."
            kept = quiet(complete.plan_turn, "how does a heat pump work", done_text)
            check("plan: a complete answer is left alone", kept, done_text)
            check("plan: no call for a complete answer", quiet_stub.asks, 0)
            check("plan: nothing is stored across turns", complete.last_plan["total"], 2)

            runner_stub = PlanStub(
                "1. how heat moves COVERED\n2. why it is efficient MISSING",
                [
                    "A heat pump moves heat with a compressor.",
                    "It is efficient because it moves heat instead of making it.",
                ],
            )
            runner = build(runner_stub, "plan3")
            runner.fast_mode = False
            runner.plan_mode = "on"
            runner.plan_appends = 2
            runner.plan_review = True
            runner.plan_budget = 0.0
            runner.think_mode = "off"
            runner.autonote = False
            produced = quiet(runner.ask, "how does a heat pump work and why is it efficient")
            check("plan: the answer grows inside one ask", "efficient" in produced, True)
            check(
                "plan: the turn ticks its own checklist",
                (runner.last_plan["done"], runner.last_plan["total"]),
                (2, 2),
            )
            runner.plan_mode = "auto"
            quiet(runner.ask, "what is a diamond")
            check("plan: the next turn starts with no list", runner.last_plan, {})

            default_stub = PlanStub("1. how heat moves COVERED\n2. why it is efficient MISSING")
            cheap = build(default_stub, "plan4")
            cheap.fast_mode = False
            brief = "A heat pump moves heat with a compressor."
            unchanged = quiet(cheap.plan_turn, "how does a heat pump work", brief)
            check("plan: one assess call by default", cheap.last_plan.get("calls"), 1)
            check("plan: no append by default", cheap.last_plan.get("appends"), 0)
            check("plan: no review by default", cheap.last_plan.get("reviewed"), 0)
            check("plan: the answer is left alone by default", unchanged, brief)
            check("plan: the default settings are the cheap ones", (cheap.plan_appends, cheap.plan_review), (0, False))

            slow_stub = PlanStub(
                "1. how heat moves COVERED\n2. why it is efficient MISSING",
                ["It is efficient because it moves heat.", "It works in winter too."],
            )

            def slow_complete(messages, **kw):
                time.sleep(0.05)
                return slow_stub.checklist

            slow_stub.complete = slow_complete
            tight = build(slow_stub, "plan5")
            tight.fast_mode = False
            tight.plan_appends = 2
            tight.plan_review = True
            tight.plan_budget = 0.02
            quiet(tight.plan_turn, "how does a heat pump work", brief)
            check(
                "plan: the budget stops the extra passes",
                (
                    tight.last_plan.get("calls"),
                    tight.last_plan.get("appends"),
                    tight.last_plan.get("reviewed"),
                    tight.last_plan.get("stopped"),
                ),
                (1, 0, 0, "budget"),
            )

            slept = []

            def nap():
                time.sleep(0.25)
                slept.append(1)

            started = time.perf_counter()
            worker = chat_e.background(nap)
            elapsed = (time.perf_counter() - started) * 1000
            worker.join(3)
            check("background does not block", elapsed < 120, True)
            check("background actually ran", len(slept), 1)

            # an oversized JPEG pair must be smaller by the time the client sees it
            os.environ["CONTEXT_WINDOW"] = "500"
            globals()["gdiplus_thumbnail"] = fake_thumb
            try:
                vision = StubClient(replies=["ok"])
                chat_f = build(vision, "ask6")
                quiet(chat_f._vision_call, "what is this?", [fake_jpeg, fake_jpeg], max_tokens=50)
            finally:
                globals()["gdiplus_thumbnail"] = original_thumb
                os.environ.pop("CONTEXT_WINDOW", None)
            sent = vision.messages[-1].get("images") or []
            check(
                "oversized JPEG pair shrinks before sending",
                [image_size(payload) for payload in sent],
                [(200, 100), (200, 100)],
            )
        finally:
            globals()["STATE"] = saved_state
        check("store indexed", store.count(), 3)
        check("store keyword hit", len(store.search("chromium")), 1)
        check("store tolerates punctuation", isinstance(store.search("chromium?! (red)"), list), True)

        # -- lane drain: background work may not hold the next answer -------- #
        lanes = Lanes()
        holding = threading.Event()
        let_go = threading.Event()

        def hold_lane():
            lanes.acquire("background")
            holding.set()
            let_go.wait(5)
            lanes.release("background")

        holder = threading.Thread(target=hold_lane, daemon=True)
        holder.start()
        holding.wait(5)
        started = time.perf_counter()
        took_lane = lanes.acquire("interactive", drain=0.1, timeout=2)
        waited = time.perf_counter() - started
        check("drain takes the lane anyway", took_lane, True)
        check("drain bounds the wait", waited < 0.6, True)
        check("drain leaves background running", lanes.active_background, 1)
        lanes.release("interactive")
        let_go.set()
        holder.join(5)

        lanes = Lanes()
        holding = threading.Event()
        let_go = threading.Event()

        def hold_lane_again():
            lanes.acquire("background")
            holding.set()
            let_go.wait(5)
            lanes.release("background")

        holder = threading.Thread(target=hold_lane_again, daemon=True)
        holder.start()
        holding.wait(5)
        timer = threading.Timer(0.15, let_go.set)
        timer.start()
        started = time.perf_counter()
        took_lane = lanes.acquire("interactive", drain=None)
        waited = time.perf_counter() - started
        check("drain=None waits for background", (took_lane, lanes.active_background), (True, 0))
        check("drain=None waits out the call", waited > 0.1, True)
        lanes.release("interactive")
        timer.cancel()
        holder.join(5)

        lanes = Lanes()
        check("a negative drain does not spin", lanes.acquire("interactive", drain=-5), True)
        lanes.release("interactive")
        check("a junk drain falls back", lanes.acquire("interactive", drain="junk"), True)
        lanes.release("interactive")
        lanes.acquire("interactive")
        check("two interactive calls never overlap", lanes.acquire("interactive", timeout=0.05), False)
        lanes.release("interactive")

        # -- a reasoning pass must not pay for the answer it discards -------- #
        counts = {"content": 0}

        def thinking_then_answer(messages, model, max_tokens, sampling, think=None, read_timeout=None):
            for _ in range(3):
                yield ("thinking", "weighing ")
            for _ in range(20):
                counts["content"] += 1
                yield ("content", "answer ")

        wired = Client(telemetry=None)
        wired._http_chunks = thinking_then_answer
        asked = [{"role": "user", "content": "why is the sky blue"}]
        whole = wired.ask(asked, think=True)
        check("a reasoning call reads the whole answer", counts["content"], 20)
        counts["content"] = 0
        cut = wired.ask(asked, think=True, stop_when_answered=True)
        check("a reasoning call stops at the first answer token", counts["content"], 1)
        check("the thinking channel is still returned", cut["thinking_chars"], 27)
        check("the discarded answer is not collected", len(cut["text"]) < len(whole["text"]), True)

        plain_only = {"n": 0}

        def answer_only(messages, model, max_tokens, sampling, think=None, read_timeout=None):
            for _ in range(5):
                plain_only["n"] += 1
                yield ("content", "text ")

        unwired = Client(telemetry=None)
        unwired._http_chunks = answer_only
        kept = unwired.ask(asked, think=True, stop_when_answered=True)
        check("no thinking keeps the whole answer", (plain_only["n"], len(kept["text"])), (5, 25))

        # -- one repetition fixup per turn, not two --------------------------- #
        kinds = []
        repeated = StubClient(replies=["A cat is a small domesticated mammal."])
        inner_complete = repeated.complete

        def record_complete(messages, **kw):
            kinds.append(kw.get("kind"))
            return inner_complete(messages, **kw)

        repeated.complete = record_complete
        repeat_chat = build(repeated, "repeatfix")
        repeat_chat.fast_mode = False
        quiet(repeat_chat.ask, "what is a cat")
        kinds.clear()
        # A different question with the same answer: the model repeated itself,
        # so the repetition fixup runs (an exact repeat takes the "repeat" path,
        # where extend_if_repetitive deliberately does nothing).
        quiet(repeat_chat.ask, "tell me about cats")
        check("a repeated answer is extended", "extend" in kinds, True)
        check("the extension replaces the variant call", "variant" in kinds, False)

        # -- a cache hit does not assemble context ---------------------------- #
        cached = build(StubClient(replies=["A cat is a small domesticated mammal."]), "cachehit")
        assembled = []
        base_context_for = cached.context_for
        cached.context_for = lambda prompt: assembled.append(prompt) or base_context_for(prompt)
        # turn_number() reads the memory, not history: the cooldown is counted
        # in stored turns, so the cache entry has to be ten turns old.
        cached.memory.turns = [
            {"n": number, "user": "q%d" % number, "answer": "a%d" % number} for number in range(1, 11)
        ]
        cached.memory.indexed = 10
        cached.cache.put("what is a cat", "A cached answer about cats.", "stub", turn=0)
        hit = quiet(cached.ask, "what is a cat")
        check("a cache hit returns the stored answer", hit, "A cached answer about cats.")
        check("a cache hit skips context assembly", assembled, [])
        # -- one num_ctx for every call that fits ------------------------------ #
        # A changing num_ctx reloads the model on the server (8.9 s first token),
        # so a note and the answer after it must ask for the same size.
        small = ctx_for([{"role": "user", "content": "cat"}])
        medium = ctx_for([{"role": "user", "content": "cat " * 600}])
        check("a small call and a medium call share one num_ctx", (small, medium), (NUM_CTX, NUM_CTX))
        check("num_ctx still grows past the floor", ctx_for([{"role": "user", "content": "x" * 200000}]), 16384)
        # -- a stalled request is not re-sent ---------------------------------- #
        stalls = {"n": 0}

        class Stall:
            status_code = 200
            text = ""

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

            def raise_for_status(self):
                return None

            def iter_lines(self, decode_unicode=True):
                raise TimeoutError("read timed out")

        class StallSession:
            def post(self, *_a, **_kw):
                stalls["n"] += 1
                return Stall()

        stalled = Client(demo=False)
        stalled.session = StallSession()
        try:
            stalled.stream([{"role": "user", "content": "hi"}])
            failed = ""
        except RuntimeError as err:
            failed = str(err)
        check("a timed-out request fails instead of being re-sent", (stalls["n"], "timed out" in failed), (1, True))

        if EXT is not None:
            class Stub:
                pass

            stub = Stub()
            stub.store = store
            hits = EXT.semantic_recall(stub, "why are rubies red")
            check("vector recall finds chromium", bool(hits) and "chromium" in hits[0]["body"], True)
            check("parallel plan short", EXT.parallel_workers(3, 6), 3)
            check("parallel plan long", EXT.parallel_workers(3, 256), 1)
    finally:
        import shutil

        shutil.rmtree(temp, ignore_errors=True)
    same = variation_stats(["word " * 40, "word " * 40, "rubies are red because of chromium"])
    check("identical answers count once", same["distinct"], 2)
    check("identical answers are 100% alike", round(same["max"], 2), 1.0)
    check("one answer is one variation", variation_stats(["a short answer"])["distinct"], 1)

    passed = sum(1 for ok in results if ok)
    print("selftest: %d/%d passed" % (passed, len(results)))
    return 0 if passed == len(results) else 1


def main():
    global STATE
    console_setup()
    parser = argparse.ArgumentParser(description="Low-latency chat client")
    parser.add_argument("--demo", action="store_true", help="offline self-test, no network")
    parser.add_argument("--stats", action="store_true", help="print the telemetry dataset and exit")
    parser.add_argument("--bench", type=int, default=0, metavar="N", help="time N identical calls and exit")
    parser.add_argument("--draft", action="store_true", help="enable speculative drafts (costs a second call)")
    parser.add_argument("--no-draft", action="store_true", help="disable speculative drafts")
    parser.add_argument("--layers", type=int, default=0, metavar="N", help="critique/rewrite passes per answer")
    parser.add_argument("--fast", action="store_true", help="one plain call, no memory assembly")
    parser.add_argument("--parallel", action="store_true", help="read several images at once (slower on this endpoint)")
    parser.add_argument("--settings", action="store_true", help="print the resolved settings and exit")
    parser.add_argument("--selftest", action="store_true", help="run network-free checks and exit")
    parser.add_argument(
        "--constraint-bench", type=int, default=0, metavar="N",
        help="N turns x 3 checklist placements, then compare compliance",
    )
    args = parser.parse_args()

    if args.selftest:
        raise SystemExit(run_selftest())

    if args.settings:
        print("settings source: environment > fast_chat_ext.SETTINGS > built-in default")
        for name in (
            "url", "model", "fast_model", "max_tokens", "temperature", "repeat_penalty",
            "think", "layers", "memory_window", "memory_window_tokens", "memory_budget",
            "vision_samples",
            "parallel", "preply_threshold", "loop_n", "ocr_model", "check_model", "code_model",
            "run_scripts", "main_model", "memory_limit", "chunk_keep", "memory_save_interval",
            "append_rounds", "append_tokens", "append_budget", "long_limit", "tidy_chars",
            "autonote", "autonote_min_chars", "long_form", "long_max_tokens",
            "expand_rounds", "expand_target_words", "vision_max_side",
        ):
            print("  %-18s %s" % (name, setting(name, "(default)")))
        # The checklist pass: the old full pass (two appends + review) is one
        # setting away, and plan_budget 0 means no ceiling.
        for name, fallback in (
            ("plan_appends", 0),
            ("plan_review", False),
            ("plan_budget", PLAN_BUDGET),
        ):
            print("  %-18s %s" % (name, setting(name, fallback)))
        print("extension:", "loaded" if (EXT is not None and EXT.ENABLED) else "absent or disabled")
        return

    telemetry = Telemetry(Path(STATE) / "chat_telemetry.jsonl")
    if args.stats:
        print_stats(telemetry.path)
        return

    if args.demo:
        STATE = Path(tempfile.mkdtemp(prefix="fastchat-demo-"))
        telemetry = Telemetry(STATE / "chat_telemetry.jsonl")

    cache = AnswerCache(STATE / "chat_cache.json")
    notes = Notes(STATE / "chat_notes.json")
    client = Client(telemetry=telemetry, demo=args.demo)
    chat = Chat(client, cache, notes, telemetry, use_draft=args.draft or (DEFAULT_DRAFT and not args.no_draft))
    if args.layers:
        chat.layers = max(1, args.layers)
    chat.fast_mode = bool(args.fast)
    if args.parallel:
        chat.parallel = True

    print("endpoint:", URL)
    print("model:", MODEL, "| fast:", FAST_MODEL, "| max tokens:", MAX_TOKENS, "| thinking:", "on" if THINK else "off")
    print("state:", STATE)
    if not args.demo and requests is None:
        print("requests is not installed: pip install requests  (or use --demo)")

    if args.constraint_bench:
        chat.constraint_bench(args.constraint_bench)
    elif args.bench:
        run_bench(client, args.bench)
    elif args.demo:
        run_demo(chat, telemetry)
    else:
        run_repl(chat, telemetry)


if __name__ == "__main__":
    main()
