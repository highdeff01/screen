#!/usr/bin/env python3
"""fast_chat_lan.py - the LAN bridge for fast_chat: a constant, duplex link.

This is the transport that fast_chat_features.py called "scaffold: needs a
transport". Nothing in fast_chat.py changes; this module wraps it.

Two programs, one protocol (newline-delimited JSON over TCP, one socket, four
channels multiplexed by the "ch" field):

EVERYTHING IS ON BY DEFAULT. serve starts the full stack in one go - live
streaming, drafts, speculative pre-answers, reflection with retests, held
input follow-ups, notes, warm-keeper, health/monut, recorder, and a UDP audio
socket on port+1 - and each part activates when its moment comes. Flags only
turn things off. link is live by default: typing streams by character, the AI
answers about 0.2 s after you stop (lan_settle_ms), and the reply streams
back by character in sections.

  serve   - the AI's home. Loads the full fast_chat Chat engine (cache, memory,
            notes, store, lanes) and holds the socket open. It never closes:
            after every answer it goes straight back to listening.
  link    - the user side (phone companion or second PC). Sends what the user
            says, prints what the AI says as it arrives, shows who is typing,
            and shows the AI's side-channel (suggestions, status, peer review)
            separately.

Channels on one socket:
  ch="user"      user speech/text (phone app transcribes, sends text; interim
                 results are sent as partial=true so the AI can pre-react)
  ch="live"      live text, one chunk per character/word as it is typed or
                 decoded (default on link). The buffer drafts while it arrives
                 and AUTO-FINALIZES when the stream goes quiet
                 (lan_settle_ms, default 200 ms): the AI answers without
                 Enter ever being pressed
  ch="typing"    the typing indicator: everyone except the sender sees the
                 input forming, live
  ch="status"    response phases: responding (turn started) / done
  ch="ai-draft"  the fast first pass: try_draft on the partial input, superseded
                 by the final answer ("more shots" at a response). Also carries
                 speculative=true answers pre-drafted in idle time by the
                 always-on parallel pre-answerer (Speculative).
  ch="ai-live"   the final answer streamed by character (client requested
                 live=true in hello): the app relays/decodes while it arrives
  ch="ai-group"  the answer grouped into speakable chunks and scored by a
                 second model for topic sync and focus: speak=true means the
                 app may voice it now, speak=false means hold for more context
  ch="ai"        the final answer, from the full Chat.ask pipeline
  ch="ai-note"   the AI's own recorder: status, events, peer review results
  ch="event"     agent/automation messages; gated by importance, not every one
                 reaches the conversation
  ch="steer"     steering notes ("zcizo"): nudges the AI's context without
                 pretending to be the user
  ch="peer"      model-to-model: a second fast_chat node reviews answers
  ch="audio"     raw audio attachment (base64); stored, transcript used if sent
  ch="sys"       hello/heartbeat/state, plus live-settled when a live turn closes

Always-on housekeeping at the home (no user action needed):
  Recorder       every turn, draft, event and spin alert goes to
                 state/lan_session.jsonl - the call log a crash can be replayed from
  Health         instruments every model call: repetition spin-offs, reasoning
                 spin, mid-stream stalls, slow first tokens and call failures
                 are reported on the ai-note channel and saved as notes
  KeepWarm       in idle gaps a one-token ping keeps the model loaded at a
                 steady rate, so the next real answer starts on a warm context
                 and TTFT stays low; an uptime/health note is posted periodically
  MountKeeper    a spin-off is treated as physical: the model left its mount.
                 Recovery forces fresh mounts with retry pings on its own
                 thread and reports 're-mounted' or 'still off' exactly once
  Reflector      the phone-call layer: after every answer the model keeps
                 listening to itself - repeats the answer, fact-checks it
                 against notes and conversation history, weighs the speaker's
                 record and the session's condition - and if something is
                 wrong the corrected answer supersedes the first while the
                 user is still reading (lan_reflect_max caps fixes per answer)
  Prefetch       while you are still typing, context assembly for the partial
                 text already runs on the background lane, so the real turn
                 starts with the thinking already done
  FollowUps      input and events arriving mid-turn are caught, alerted and
                 prepared - a reply is drafted for later - then presented the
                 moment the model frees; urgent ones step into the
                 conversation with a continuation directive so the topic
                 keeps moving instead of restarting
  SelfAgent      the model's own overhead view, in its own prompt: after the
                 exchange settles it decides BY ITSELF what would best move
                 the conversation forward - say the next part (its own turn,
                 cause=self), work something out for later (prepared), or
                 nothing (silence respected). Rate-limited, never forced
  ContinueWrap   there is more than one kind of 'continue'. Before anything
                 continues by itself, registered checks reshape what that
                 means: new user input (fold it in first), remaining goals
                 (continue toward what is uncovered), prepared items
                 (present now?), and more can be added later - both firing
                 at once folds into one instruction
  Familiarity    notes captured the instant a turn ends (local, no model, no
                 delay - the backup trail), then scored locally for
                 familiarity against the trail, and the score fires the next
                 action by itself: fresh topic -> clean continuation,
                 related -> review then continue, well-trodden -> consolidate
                 (summary + conclusion + a test question). --fast keeps the
                 capture, skips only the model work

Notes keep flowing at the same time as everything else: auto_note extracts
facts from each answer on the background lane, and the user can add a note
mid-conversation with ':note text' (saved, no turn taken).

Background lane settings (in fast_chat_ext.SETTINGS, environment overrides):
  lan_background_live      false = guarded (background only in idle gaps, the
                           measured default); true = background runs while you
                           chat and think too - notes, reflection, prefetch,
                           speculative pre-answers all keep flowing mid-turn
  lan_background_slots     1 background call at a time while live (a second
                           call on one GPU only splits its tokens)
  lan_background_grace_ms  quiet time after an interactive call before the
                           background lane may grab the GPU again
  lan_rec_settle_ms        pause that ends a live utterance in rec mode (fast
                           feeds/video: short answers, no post-passes)
  lan_reflect_max          corrections per answer (0 disables the reflector)
Link commands: ':rec on|off' fast feed mode, ':bg on|off' live background lane.

Run (both machines need fast_chat.py, fast_chat_ext.py, fast_chat_features.py
and this file in the same folder):

  AI home:      python fast_chat_lan.py serve
                one command, everything on. Flags only turn things off:
                --no-peer-review, --audio-port 0 (UDP audio is on port+1 by
                default), --port 9514, --speak (say answers out loud)
  user side:    python fast_chat_lan.py link --host 192.168.1.50 [--speak]
                live by default: typing streams, auto-answer on a 0.2 s pause,
                replies stream back by character in sections.
                --no-live for plain line mode. --role peer for a second model

Stdlib only, like the rest of the project; requests is only needed by the
fast_chat core itself.
"""

import argparse
import base64
import http.client
import json
import re
import socket
import sys
import threading
import time
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import urlparse

try:
    import fast_chat as core
except Exception as err:  # noqa: BLE001
    print("fast_chat.py must be importable in the same folder: %s" % err)
    raise SystemExit(1)

try:
    import fast_chat_features as features
except Exception:  # noqa: BLE001
    features = None

DEFAULT_PORT = 9514
HELLO_TIMEOUT = 8.0
IDLE_SHUTDOWN = 0  # never; the constant link stays up


def now_ms():
    return int(time.time() * 1000)


VERSION = "2026-11-20.6"


def stamp():
    return time.strftime("%H:%M:%S")


# --------------------------------------------------------------------------- #
# framing: newline-delimited JSON, one socket, many channels
# --------------------------------------------------------------------------- #
class SocketLink:
    """Send/receive JSON lines on one socket. Thread-safe on send."""

    def __init__(self, sock):
        self.sock = sock
        self.file = sock.makefile("r", encoding="utf-8", newline="\n")
        self.lock = threading.Lock()
        self.alive = True

    def send(self, **fields):
        if not self.alive:
            return False
        fields.setdefault("ts", now_ms())
        try:
            with self.lock:
                self.sock.sendall((json.dumps(fields, default=str) + "\n").encode("utf-8"))
            return True
        except OSError:
            self.alive = False
            return False

    def recv(self):
        """Next message dict, or None when the peer is gone."""
        try:
            line = self.file.readline()
        except (OSError, ValueError):
            line = ""
        if not line:
            self.alive = False
            return None
        line = line.strip()
        if not line:
            return {}
        try:
            data = json.loads(line)
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}

    def close(self):
        self.alive = False
        try:
            self.sock.close()
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# importance gate: agents and events do not get to talk over the user
# --------------------------------------------------------------------------- #
class ImportanceGate:
    """Holds ch="event" traffic until it is worth interrupting.

    Rules, in order:
      - an event always goes to the user's app on the ai-note channel (the
        recorder feed shows everything, live)
      - it reaches the conversation only when it scores above the threshold
        (keyword hit or repeated) or when enough quiet events pile up that
        staying silent would lose information
    """

    KEYWORDS = ("error", "failed", "finished", "installed", "ready", "urgent",
                "alert", "denied", "blocked", "complete", "waiting for you")

    def __init__(self, threshold=2):
        self.threshold = threshold
        self.buffer = []          # held events, not yet injected
        self.lock = threading.Lock()

    def score(self, text):
        low = str(text).lower()
        hits = sum(1 for word in self.KEYWORDS if word in low)
        return hits

    def offer(self, event):
        """Returns the text to inject into the conversation now, or ''. """
        text = str(event.get("text", ""))
        with self.lock:
            self.buffer.append(event)
            if self.score(text) > 0 or len(self.buffer) >= 3:
                self.buffer.sort(key=lambda item: -self.score(str(item.get("text", ""))))
                parts = [str(item.get("text", "")) for item in self.buffer]
                self.buffer = []
                return "[events] " + " | ".join(parts)
        return ""

    def drain(self):
        with self.lock:
            parts = [str(item.get("text", "")) for item in self.buffer]
            self.buffer = []
        return "[events] " + " | ".join(parts) if parts else ""


_LOCAL_STOP = frozenset(
    "the a an and or of to in is are was were you i it that this for with on at "
    "as be been by from have has do does did not but if then so what when where "
    "who why how your my its their our them they we us can could will would".split()
)


# The standing style of every live turn: the continuation IS the answer.
HUB_FLOW = (
    "Follow the flow of the conversation: reply with only what continues it. "
    "Do not restate or recap the previous response - the user already has it. "
    "Include a previous point only if the new point truly needs it. You decide "
    "what to add and what to drop, without being forced: add detail where it "
    "earns its place, drop detail the flow does not need, and say it your own "
    "way - your own judgment, your own choice of angle and wording, not a "
    "summary of what came before."
)


def lan_commentary(text):
    """True when 'corrected' text is meta-commentary about the answer instead
    of the answer itself - the lagging-note failure, where the reflector
    critiqued a truncated copy and then broadcast its critique as the answer."""
    low = str(text).lower()
    # starts-with patterns are the reliable signal; loose substring markers
    # (e.g. the word 'asked') false-positived on real answers and each false
    # positive cost a full rewrite generation on the answer path
    if low.startswith(("the corrected", "it fails", "this answer", "the answer",
                       "the user asked", "the user is asking", "here they ask",
                       "likely seeking", "regarding your question")):
        return True
    return any(
        marker in low
        for marker in ("a better answer would", "fails to address", "cuts off mid-sentence",
                       "asked multiple times previously", "previously asked about"))


def topic_terms(text):
    """Content words of a text: the focus the second model checks groups against."""
    stop = getattr(features, "STOPWORDS", None) or _LOCAL_STOP
    return {word for word in re.findall(r"[a-z0-9']{3,}", str(text).lower()) if word not in stop}


# --------------------------------------------------------------------------- #
# live input: the buffer that answers when the stream goes quiet
# --------------------------------------------------------------------------- #
class LiveBuffer:
    """Rolling text arriving chunk by chunk from one live client.

    Three states, decided by time, not by Enter:
      quiet 400ms -> fire a draft (the pre-reaction on what exists so far)
      quiet settle_ms (default 900ms) -> finalize: a real turn starts, whether
      or not the sender ever presses Enter. That is the auto-forced answer.
    """

    def __init__(self, settle_ms=200, draft_ms=400, fragment_ms=800):
        self.settle_ms = max(0.0, settle_ms / 1000.0)   # 0 = 0s mode allowed
        self.fragment_ms = max(self.settle_ms, fragment_ms / 1000.0)
        self.draft_ms = draft_ms / 1000.0
        self.lock = threading.Lock()
        self.text = ""
        self.seq = 0
        self.last_arrival = 0.0
        self.draft_at = 0.0
        self.finalized = False

    def feed(self, chunk, seq=0):
        now = time.time()
        with self.lock:
            self.seq = max(self.seq, int(seq or self.seq))
            self.text += str(chunk or "")
            self.last_arrival = now
            self.draft_at = now + self.draft_ms
            self.finalized = False
            return self.text

    def set(self, text, seq=0):
        with self.lock:
            self.text = str(text or "")
            self.seq = max(self.seq, int(seq or self.seq))
            self.last_arrival = time.time()
            self.finalized = False
            return self.text

    @staticmethod
    def looks_complete(text):
        """Finished-thought heuristic: punctuated or substantial. Fragments
        ("wha", "what is a r") get a longer settle so mid-word pauses do not
        fire a full answer that the rest of the sentence then has to wait for."""
        if len(text) >= 40:
            return True
        return len(text) >= 8 and text[-1] in ".?!"

    def due(self, now=None):
        """(state, text): state is '' | 'draft' | 'final'. A fragment (not
        punctuated, not substantial) only fires as a final answer once it has
        at least 3 words - or after a much longer quiet window - so mid-word
        pauses ('wha', 'what is ma') never grab the model while the real
        question is still being typed."""
        now = now or time.time()
        with self.lock:
            text = self.text.strip()
            if not text or self.finalized:
                return "", ""
            idle = now - self.last_arrival
            if self.settle_ms <= 0.05:
                # 0s mode: everything answers on the next pump tick after the
                # last keystroke - mid-word pauses will fire turns, that is
                # the trade the user asked for
                needed = 0.05
            elif self.looks_complete(text):
                needed = self.settle_ms
            elif len(text.split()) >= 3 or len(text) >= 15:
                needed = self.fragment_ms
            else:
                needed = max(self.fragment_ms, 2.5)  # tiny fragment: think twice
            if idle >= needed:
                self.finalized = True
                return "final", text
            if now >= self.draft_at:
                self.draft_at = now + self.draft_ms
                return "draft", text
        return "", ""

    def consume(self, answered):
        """Remove the text a finished turn answered, keep anything typed since.
        Without this the buffer grows forever and every turn is asked the
        concatenation of everything ever typed - the 'old answers' bug."""
        with self.lock:
            answered = str(answered or "").strip()
            if answered:
                idx = self.text.find(answered)
                if idx >= 0:
                    self.text = self.text[:idx] + self.text[idx + len(answered):]
            self.finalized = False
            self.last_arrival = time.time()
            return self.text

    def requeue(self):
        """A turn was already running when this text settled: wait for a fresh
        quiet window instead of queueing the stale snapshot - by the time the
        window closes the text has usually grown into the real question, and
        ONE answer goes out instead of one per fragment."""
        with self.lock:
            self.finalized = False
            self.last_arrival = time.time()


# --------------------------------------------------------------------------- #
# live output: character relay and expectancy grouping
# --------------------------------------------------------------------------- #
class CharStreamer:
    """Batches streamed characters into ai-live messages: the client sees the
    answer by character (for its decoder/relay) while the socket is hit in
    small batches instead of one packet per token."""

    def __init__(self, hub, batch=8, interval=0.06):
        self.hub = hub
        self.batch = batch
        self.interval = interval
        self.lock = threading.Lock()
        self.buf = ""
        self.total = 0
        self.last = 0.0

    def push(self, piece):
        flush = False
        now = time.time()
        with self.lock:
            self.buf += str(piece or "")
            self.total += len(piece or "")
            if len(self.buf) >= self.batch or (now - self.last) >= self.interval:
                flush = True
        if flush:
            self.flush()

    def flush(self):
        with self.lock:
            buf, self.buf = self.buf, ""
            self.last = time.time()
        if buf:
            self.hub.broadcast(ch="ai-live", text=buf, total_chars=self.total)


class Expectancy:
    """Groups the streamed answer into speakable chunks and checks the group
    against the question's focus with a second model.

    Local rule: a group forms at a sentence boundary, a long comma clause, or
    240 chars, whichever comes first. Its expectancy score decides speak/hold.
    On the first group and every third after, one cheap background call asks
    the fast model whether the group makes sense aloud on this topic right now
    (SPEAK/WAIT); its verdict gates the following groups until the next check.
    When the model is silent or slow, the local score stands, so pacing never
    stalls.
    """

    def __init__(self, hub, question):
        self.hub = hub
        self.question = str(question)
        self.topic = topic_terms(self.question)
        self.pending = ""
        self.group_no = 0
        self.sync = True
        self.checks = 0

    def feed(self, piece):
        self.pending += str(piece or "")
        self.flush()

    def end(self):
        self.flush(final=True)

    def flush(self, final=False):
        while True:
            text = self.pending
            if not text:
                return
            boundary = None
            sentence = re.search(r"[.!?](\s+|$)", text)
            if sentence:
                boundary = sentence.end()
            elif "\n" in text:
                boundary = text.index("\n") + 1
            elif len(text) > 80:
                comma = text.rfind(", ", 40)
                if comma > 0:
                    boundary = comma + 1
            if boundary is None and (final or len(text) > 240):
                boundary = len(text)
            if boundary is None:
                return
            group = text[:boundary].strip()
            self.pending = text[boundary:]
            if group:
                self.group_no += 1
                self.evaluate(group)

    def evaluate(self, group):
        score = 0.9 if group[-1] in ".!?" else 0.55
        if topic_terms(group) & self.topic:
            score += 0.05
        speak = self.sync and score >= 0.55
        self.hub.broadcast(
            ch="ai-group", group_no=self.group_no, text=group,
            speak=bool(speak), score=round(min(1.0, score), 2),
        )
        self.checks += 1
        if self.checks % 3 == 1:
            self.check_sync(group)

    def check_sync(self, group):
        hub = self.hub
        if hub.chat.fast_mode or not hub.health.aux_allowed():
            return  # fast mode or slow endpoint: local pacing score stands
        focus = ", ".join(sorted(self.topic)[:8])
        text = group

        def work():
            try:
                verdict = hub.chat.client.complete(
                    [
                        {"role": "system", "content":
                         "You pace a spoken answer. Reply with one word: SPEAK if "
                         "the text makes sense aloud on this topic right now, WAIT "
                         "if it should be held until more context arrives."},
                        {"role": "user", "content":
                         "Question focus: %s\nText: %s" % (focus, text[:300])},
                    ],
                    max_tokens=8,
                    kind="expectancy",
                    priority="background",
                ).strip().upper()
                if verdict:
                    self.sync = verdict.startswith("SPEAK")
            except Exception:  # noqa: BLE001 - pacing must never stall the stream
                self.sync = True

        hub.chat.background(work)


# --------------------------------------------------------------------------- #
# the parallel pre-answerer: idle GPU time is never wasted
# --------------------------------------------------------------------------- #
class Speculative:
    """Always on, running in the gaps. After every answer the fast model
    predicts the single most likely next question and pre-drafts its answer on
    the background lane - which by the Lanes rule only runs when nothing
    interactive is waiting, so it is exactly the in-between time being caught.

    When the user then speaks, a fuzzy match against the predictions returns a
    ready answer in 0 ms: it goes out immediately as a speculative draft, and
    the real pipeline answer still follows and supersedes it.
    """

    def __init__(self, hub, size=4, match=0.72):
        self.hub = hub
        self.size = max(1, int(size))
        self.match = float(match)
        self.entries = []  # (predicted question, drafted answer), newest last
        self.lock = threading.Lock()

    def schedule(self):
        hub = self.hub
        if features is None or not hub.health.aux_allowed():
            return
        last_prompt = str(hub.chat.last_prompt or "")
        last_answer = str(hub.chat.last_answer or "")

        def work():
            try:
                prediction = features.try_draft(
                    hub.chat.client,
                    "Predict the one most likely next thing the user will ask. "
                    "Reply with only that question, no preamble.\n"
                    "User said: %s\nYou answered: %s"
                    % (last_prompt[:400], last_answer[:400]),
                    max_tokens=40,
                    temperature=0.35,
                ).strip().strip('"')
                if not prediction or len(prediction) < 8:
                    return
                with self.lock:
                    if any(
                        SequenceMatcher(None, prediction.lower(), existing.lower()).ratio() >= self.match
                        for existing, _ in self.entries
                    ):
                        return
                answer = features.try_draft(hub.chat.client, prediction, max_tokens=140)
                if not answer:
                    return
                with self.lock:
                    self.entries.append((prediction, answer))
                    self.entries = self.entries[-self.size:]
            except Exception:  # noqa: BLE001 - a missed prediction costs nothing
                pass

        hub.chat.background(work)

    def lookup(self, text):
        low = str(text or "").strip().lower()
        if not low:
            return None
        with self.lock:
            for question, answer in reversed(self.entries):
                if SequenceMatcher(None, low, question.lower()).ratio() >= self.match:
                    return answer
        return None


# --------------------------------------------------------------------------- #
# the session recorder: everything that happens lands in one call log
# --------------------------------------------------------------------------- #
class Recorder:
    """JSONL call log next to the engine state. Turn, draft, event, steering,
    spin alert - all of it, small and append-only, rotated like the engine's
    own telemetry. This is what makes the link replayable after a crash and
    keeps the notes whole even when a turn fails mid-stream."""

    def __init__(self, hub):
        self.hub = hub
        self.path = Path(core.STATE) / "lan_session.jsonl"
        self._pending = []           # buffered rows: typing must not pay disk
        self._plock = threading.Lock()
        self._stop = False
        threading.Thread(target=self._flush_loop, daemon=True).start()

    def _flush_loop(self):
        while not self._stop:
            time.sleep(2.0)
            self.flush()

    def flush(self):
        with self._plock:
            rows, self._pending = self._pending, []
        if not rows:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as handle:
                for row in rows:
                    handle.write(json.dumps(row, default=str)[:2000] + "\n")
            core.rotate_jsonl(self.path)
        except Exception:  # noqa: BLE001 - the log must never break the link
            pass

    def log(self, **fields):
        fields = {key: value for key, value in fields.items() if key != "b64"}
        fields["ts"] = stamp()
        # priority rows (turns, errors, loop traffic) hit disk now; the
        # per-keystroke live rows ride the 2 s buffer - zero I/O in the
        # typing path, forensics still complete
        if fields.get("kind") == "live":
            with self._plock:
                self._pending.append(fields)
            return
        self.flush()
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(fields, default=str)[:2000] + "\n")
            core.rotate_jsonl(self.path)
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------- #
# health: the model never spins off silently
# --------------------------------------------------------------------------- #
class Health:
    """Instruments every model call the hub makes, whichever path it takes.

    Caught and reported on the ai-note channel (and saved as a note):
      - repetition spin-offs (LoopGuard cut the stream)
      - reasoning spin (thinking chars dwarfing the answer)
      - mid-stream stalls (one gap longer than lan_gap_alert_ms)
      - slow first token (lan_ttft_alert_ms - usually a reload)
      - call failures
    Recovery is left to the engine's own machinery (loop fixup, retries); the
    monitor only makes sure you hear about it the moment it happens.
    """

    def __init__(self, hub):
        self.hub = hub
        self.lock = threading.Lock()
        self.started = time.time()
        self.turns = 0
        self.errors = 0
        self.spins = 0
        self.ttft_ms = None
        self.causes = {}
        # the adaptive aux breaker: aux layers pause when the endpoint is slow,
        # resume when it recovers - accuracy compounding only when it is free
        self.pause_ms = max(2000, int(core.setting("lan_aux_pause_ttft_ms", 8000, int)))
        self.aux_paused = False
        self.ttft_window = []
        self.dur_window = []

    def setup(self, client):
        original = client.ask
        health = self

        def ask(messages, **kwargs):
            try:
                result = original(messages, **kwargs)
            except core.DegenerateOutput as err:
                health.spinoff("repetition loop", str(err)[:140])
                raise
            except Exception as err:  # noqa: BLE001
                with health.lock:
                    health.errors += 1
                    cause = str(err)[:80]
                    health.causes[cause] = health.causes.get(cause, 0) + 1
                health.alert("model call failed: %s" % str(err)[:140])
                health.hub.keeper.recover_async("call failed")
                raise
            health.record(result, str(kwargs.get("kind", "")))
            return result

        client.ask = ask

    def record(self, result, kind=""):
        ttft = result.get("ttft_ms")
        total = result.get("total_ms")
        text_len = len(result.get("text") or "")
        thinking = result.get("thinking_chars") or 0
        gap = result.get("max_gap_ms") or 0.0
        # tiny aux calls (drafts, warm pings) must not flatter the health
        # report or disarm the breaker while real answers wait seconds
        live_kind = str(kind) not in ("draft", "warm")
        with self.lock:
            if live_kind:
                self.ttft_ms = ttft
            # BREAKER V2: aux features must never occupy the pipe for long.
            # A first-token check alone is blind to slow DECODE: a reflector
            # call generating 400 tokens keeps the serial endpoint busy for
            # tens of seconds with a perfectly healthy TTFT - and the user's
            # next answer queues behind it. Trip on call DURATION as well.
            slow = None
            if live_kind:
                duration = float(total) if total else (float(ttft) if ttft else 0.0)
                if duration:
                    self.dur_window.append(duration)
                    self.dur_window = self.dur_window[-5:]
                    dur_avg = sum(self.dur_window) / len(self.dur_window)
                    ttft_avg = (sum(self.ttft_window) / len(self.ttft_window)) if self.ttft_window else 0.0
                    pressure = max(dur_avg, ttft_avg)
                    if not self.aux_paused and pressure > self.pause_ms:
                        self.aux_paused = True
                        slow = pressure
                    elif self.aux_paused and pressure < self.pause_ms * 0.6:
                        self.aux_paused = False
                        slow = -pressure
            if ttft and ttft > self.hub.ttft_alert:
                self.alert("first token took %d ms (kind %s) - model may have reloaded" % (int(ttft), kind))
            boot_at = getattr(self.hub.warm, "boot_at", None)
            if ttft and ttft > 15000 and boot_at and (time.time() - boot_at) < 600:
                self.alert("first answer after boot still waited %d ms - the endpoint reloads "
                           "per-connection: the boot ping warms only its own connection, so "
                           "keeping it warm needs regular traffic (endpoint behavior, not the client)"
                           % int(ttft))
        if thinking > 1500 and thinking > 6 * max(1, text_len):
            self.alert("spinning in reasoning: %d thinking chars vs %d answer chars" % (thinking, text_len))
        if gap and gap > self.hub.gap_alert:
            self.alert("stream stalled %d ms mid-answer" % int(gap))
        if slow and slow > 0:
            self.announce("pipe busy (avg call %d ms) - aux layers paused, answers get the whole pipe" % int(slow))
        elif slow and slow < 0:
            self.announce("pipe recovered (avg call %d ms) - aux layers resumed" % int(-slow))

    def aux_allowed(self):
        """False while the endpoint is slow: prediction, self-review,
        reflection, drafts and note extraction all stand down so an answer
        never queues behind them. Recovery is detected from the warm pings."""
        with self.lock:
            return not self.aux_paused

    def announce(self, text):
        print("[%s] AUX: %s" % (stamp(), text))
        self.hub.broadcast(ch="ai-note", type="aux", text=text)

    def spinoff(self, kind, detail=""):
        with self.lock:
            self.spins += 1
        message = "model spun off (%s)%s - stream cut, engine recovery runs next" % (
            kind, (": " + detail) if detail else ""
        )
        self.alert(message)
        try:
            self.hub.chat.notes.add("spin", kind[:40], message)
        except Exception:  # noqa: BLE001
            pass
        # Physical response to a physical problem: force the model back on.
        self.hub.keeper.recover_async("spin-off")

    def alert(self, text):
        print("[%s] SPIN/HEALTH: %s" % (stamp(), text))
        self.hub.broadcast(ch="ai-note", type="spinoff", text=text)

    def top_causes(self, count=2):
        with self.lock:
            ranked = sorted(self.causes.items(), key=lambda pair: -pair[1])[:count]
        return "; ".join("%s x%d" % (cause, number) for cause, number in ranked) if ranked else "none"

    def status(self):
        with self.lock:
            return {
                "up_min": round((time.time() - self.started) / 60.0, 1),
                "turns": self.turns,
                "ttft_ms": self.ttft_ms,
                "errors": self.errors,
                "spins": self.spins,
            }


# --------------------------------------------------------------------------- #
# keep-warm: idle gaps keep the model loaded, so answers start fast
# --------------------------------------------------------------------------- #
class KeepWarm:
    """Two clocks, one thread:
      - after lan_warm_idle of no activity, a one-token ping runs on the
        background lane every lan_warm_every: the Lanes rule guarantees it only
        runs when nothing interactive is waiting, so staying warm is free
      - every lan_health_every an uptime note goes out unasked, so 'is it still
        up and how fast' is answered before you think to ask
    """

    def __init__(self, hub):
        self.hub = hub
        self.every = max(10.0, float(core.setting("lan_warm_every", 60, int)))
        self.idle = max(5.0, float(core.setting("lan_warm_idle", 20, int)))
        self.health_every = max(30.0, float(core.setting("lan_health_every", 300, int)))
        self.last_activity = time.time()
        self.last_health = time.time()
        self.in_flight = False

    def touch(self):
        self.last_activity = time.time()

    def start(self):
        def loop():
            while True:
                time.sleep(5.0)
                now = time.time()
                self.hub.self_agent.maybe_schedule()
                # with a live user at the keyboard, the conversation itself
                # keeps the model warm - a ping here would only steal the
                # serial endpoint from the next answer
                if not self.hub.any_live() and now - self.last_activity >= self.idle and self.hub.turn_lock.acquire(False):
                    self.hub.turn_lock.release()
                    self.ping()
                if now - self.last_health >= self.health_every:
                    self.last_health = now
                    self.report()

        threading.Thread(target=loop, daemon=True).start()

    def load_once(self):
        """Boot warm: load the model BEFORE the first question so the first
        answer never pays the cold-load cost. Runs even under --fast (the
        model has to load for the first answer anyway). Every ping in the
        guard is answer-priority: it only fires when the pipe is free, and if
        a question lands while a ping is in flight, the collision is logged
        so 'the endpoint got slow' can never hide again."""
        if getattr(self, "_loaded", False):
            return
        self._loaded = True
        self.boot_at = time.time()
        # keep-warm guard: for the first minutes after boot, hold the model in
        # memory with short pings even under --fast - a proxy that unloads
        # aggressively loses it between boot and the first question otherwise
        def guard():
            end = time.time() + 300
            while time.time() < end:
                time.sleep(45)
                self._ping_once(quiet=True)

        threading.Thread(target=guard, daemon=True).start()
        self._ping_once()

    def _ping_once(self, quiet=False):
        """One warm ping, but ONLY when the pipe is genuinely free: never while
        a turn runs, never right after user activity. A ping in flight when a
        question arrives is the exact way a healthy endpoint 'becomes slow'."""
        hub = self.hub
        if hub.turn_lock.locked():
            return  # an answer owns the pipe
        if time.time() - self.last_activity < 15:
            return  # the user is active; their traffic keeps it warm anyway
        self.in_flight = True
        try:
            started = time.time()
            hub.chat.client.complete(
                [{"role": "user", "content": "ready"}],
                max_tokens=1, kind="warm", priority="background",
            )
            ms = int((time.time() - started) * 1000)
            if not quiet:
                print("[%s] model loaded and kept alive (%d ms) - first answer will not wait for the load"
                      % (stamp(), ms))
        except Exception as err:  # noqa: BLE001
            if not quiet:
                print("[%s] boot load ping failed (%s) - the first answer will load the model"
                      % (stamp(), str(err)[:100]))
        finally:
            self.in_flight = False

    def ping(self):
        if self.hub.chat.fast_mode:
            return  # --fast: the GPU does nothing but answer
        started = time.time()
        try:
            text = self.hub.chat.client.complete(
                [{"role": "user", "content": "Reply with one word: ready"}],
                max_tokens=3,
                kind="warm",
                priority="background",
            )
        except Exception as err:  # noqa: BLE001
            self.hub.health.alert("warm ping failed: %s" % str(err)[:120])
            return
        ms = int((time.time() - started) * 1000)
        if text:
            self.hub.broadcast(ch="ai-note", type="warm", text="model warm (ping %d ms)" % ms)

    def report(self):
        state = self.hub.health.status()
        self.hub.broadcast(
            ch="ai-note", type="health",
            text="up %.0f min | %d turns | ttft %s ms | errors %d (%s) | spins %d"
                 % (state["up_min"], state["turns"], state["ttft_ms"], state["errors"],
                    self.hub.health.top_causes(), state["spins"]),
        )


# --------------------------------------------------------------------------- #
# follow-ups: nothing that arrives mid-operation is dropped or blocking
# --------------------------------------------------------------------------- #
class FollowUps:
    """Stay alert during operations.

    While the model is answering, remounting or reflecting, user input and
    agent events still arrive. They are caught (never dropped, never blocking
    a read loop), alerted on the recorder, and prepared: a draft reply is
    built in the background so there is something to say later. When the turn
    frees, the queue is presented - and anything the importance gate calls
    urgent steps into the conversation itself, carrying a continuation
    directive so the model goes to the next relevant part of the topic rather
    than restarting it."""

    def __init__(self, hub):
        self.hub = hub
        self.lock = threading.Lock()
        self.items = []

    def catch(self, kind, text, source=""):
        with self.lock:
            self.items.append({"kind": kind, "text": str(text), "source": source, "ts": stamp()})
        self.hub.broadcast(
            ch="ai-note", type="followup",
            text="caught for later (%s%s): %s" % (kind, (" from " + source) if source else "", str(text)[:100]),
        )
        try:
            self.hub.chat.notes.add("held", "%s from %s" % (kind, source or "link")[:40], str(text)[:300])
        except Exception:  # noqa: BLE001
            pass
        if self.hub.gate.score(text) > 0:
            self.hub.set_continuation(
                "Urgent input arrived mid-operation and was held. After the current part, "
                "address it, then continue the topic where it left off."
            )

    def take_all(self):
        with self.lock:
            items, self.items = self.items, []
        return items

    def prepare_and_present(self, cause="the answer"):
        """Called when a turn frees: prepare replies, present the queue, and
        return text that must step into the conversation now."""
        hub = self.hub
        items = self.take_all()
        if not items:
            return ""
        urgent = None
        for item in items:
            if urgent is None and hub.gate.score(item["text"]) > 0:
                urgent = item
        combined = " | ".join("[%s] %s" % (item["kind"], item["text"]) for item in items)

        def work():
            if features is None:
                return
            try:
                reply = features.try_draft(
                    hub.chat.client,
                    "Prepare a brief reply to acknowledge and address this held input, to say later: %s"
                    % combined[:600],
                    max_tokens=120,
                )
            except Exception:  # noqa: BLE001
                reply = ""
            if reply:
                hub.broadcast(ch="ai-note", type="prepared",
                              text="prepared reply for held input: %s" % reply[:200])

        hub.chat.background(work)
        hub.broadcast(ch="ai-note", type="followup",
                      text="presented after %s: %s" % (cause, combined[:200]))
        if urgent is not None:
            return "[held input] %s" % urgent["text"]
        return ""


# --------------------------------------------------------------------------- #
# the reflector: the model listens to itself after it has already answered
# --------------------------------------------------------------------------- #
class Reflector:
    """A phone call to the mind: answering is not the end of the turn.

    While the user reads (and even while the answer is still being spoken in
    groups), the model does what a person does on a call - repeats what it
    just said to itself, checks it against the notes and the conversation
    history, weighs the speaker's record so far and the session's condition
    (errors, spins). If something is wrong, the corrected answer goes out and
    supersedes the first on the user's app - a correction mid-sentence, not a
    silence. Capped by lan_reflect_max so it cannot spiral."""

    def __init__(self, hub):
        self.hub = hub
        self.max_fixes = max(0, int(core.setting("lan_reflect_max", 1, int)))

    def schedule(self, question, answer):
        hub = self.hub
        if features is None or self.max_fixes <= 0 or not answer or not hub.health.aux_allowed():
            return
        history = []
        try:
            history = hub.chat.memory.retrieve(question, k=3) or []
        except Exception:  # noqa: BLE001
            history = []
        history_text = "\n".join(
            str(chunk.get("text", ""))[:200] for chunk in history if isinstance(chunk, dict)
        ) or "(no history)"
        try:
            hits = hub.chat.notes.search(question, limit=2)
        except Exception:  # noqa: BLE001
            hits = []
        notes_text = "\n".join("%s: %s" % (h.get("kind"), h.get("text")) for h in hits) or "(no notes)"
        state = hub.health.status()
        question_text = str(question)
        answer_text = str(answer)
        # the reflector sees the FULL answer, trimmed at a sentence boundary -
        # a hard [:1500] cut made it critique a phantom mid-sentence defect
        answer_seen = core.trim_to_tokens(answer_text, 1000)

        def work():
            try:
                verdict = hub.chat.client.complete(
                    [
                        {"role": "system", "content": (
                            "Repeat the answer to yourself and check it before the user acts on it. "
                            "Consider: internal errors or repetition; contradictions with the history "
                            "and notes below; the speaker's record so far."
                            + (" %s" % hub.interject.get("reflection")
                               if hub.interject.get("reflection") and hub.interject.get("reflection_on") else "")
                            + " Reply exactly 'OK' when the answer stands. Otherwise reply 'CORRECTION:' "
                            "followed by the corrected answer, nothing else."
                        )},
                        {"role": "user", "content": (
                            "Question: %s\nAnswer: %s\n\nHistory:\n%s\n\nNotes:\n%s\n\n"
                            "Session: %d turns, %d errors, %d spins"
                            % (question_text[:400], answer_seen, history_text[:900],
                               notes_text[:600], state["turns"], state["errors"], state["spins"])
                        )},
                    ],
                    max_tokens=400,
                    sampling={"temperature": 0.2},
                    kind="reflect",
                    priority="background",
                ).strip()
            except Exception:  # noqa: BLE001 - a failed reflection changes nothing
                return
            if not verdict or verdict.upper().startswith("OK"):
                return
            corrected = verdict.split(":", 1)[1].strip() if ":" in verdict[:12] else verdict.strip()
            if not corrected or core.near_duplicate(corrected, answer_text, 0.9):
                return
            # Test and rethink: the correction must survive its own retest.
            # If the retest offers something better, that alternative method
            # wins; if the retest fails to run, the correction still stands.
            for attempt in (1, 2):
                try:
                    check = hub.chat.client.complete(
                        [
                            {"role": "system", "content": (
                                "Retest this corrected answer against the question and the history. "
                                "Reply exactly 'OK' if it stands. Otherwise reply 'CORRECTION:' "
                                "followed by a better answer."
                            )},
                            {"role": "user", "content": "Question: %s\nCorrected answer: %s"
                             % (question_text[:400], core.trim_to_tokens(corrected, 1000))},
                        ],
                        max_tokens=400,
                        sampling={"temperature": 0.2},
                        kind="reflect-test",
                        priority="background",
                    ).strip()
                except Exception as err:  # noqa: BLE001
                    hub.broadcast(ch="ai-note", type="reflection",
                                  text="retest could not run (%s); keeping the correction" % str(err)[:80])
                    break
                if not check or check.upper().startswith("OK"):
                    hub.broadcast(ch="ai-note", type="reflection",
                                  text="correction retested ok (attempt %d)" % attempt)
                    break
                alternative = check.split(":", 1)[1].strip() if ":" in check[:12] else check.strip()
                if not alternative or core.near_duplicate(alternative, corrected, 0.9):
                    hub.broadcast(ch="ai-note", type="reflection", text="retest inconclusive; keeping the correction")
                    break
                if lan_commentary(alternative):
                    break  # commentary is not an answer; keep the last real one
                corrected = alternative  # the alternative method won
            # Guard against the lagging-note failure: if the 'correction' is
            # meta-commentary about the answer (often born from critiquing a
            # truncated copy), one rewrite pass turns it into a real answer
            # over the full original instead of broadcasting the commentary.
            if lan_commentary(corrected):
                try:
                    rewritten = hub.chat.client.complete(
                        [
                            {"role": "system", "content": (
                                "Rewrite the answer applying the critique. Reply with only the "
                                "final answer itself - no commentary, no mention of the critique."
                            )},
                            {"role": "user", "content": "Question: %s\nFull original answer: %s\nCritique: %s"
                             % (question_text[:400], answer_seen, core.trim_to_tokens(corrected, 300))},
                        ],
                        max_tokens=core.MAX_TOKENS,
                        kind="reflect-fix",
                        priority="background",
                    ).strip()
                except Exception:  # noqa: BLE001 - a failed rewrite changes nothing
                    return
                if not rewritten or core.near_duplicate(rewritten, answer_text, 0.9):
                    return
                corrected = rewritten
            hub.chat.last_answer = corrected
            hub.chat.notes.add("reflection", question_text[:40], "corrected: %s" % corrected[:300])
            hub.broadcast(ch="ai", text=corrected, final=True, revised=True, cause="reflection")
            hub.broadcast(ch="ai-note", type="reflection", text="answer corrected in flight: %s" % corrected[:120])
            hub.set_continuation(
                "A correction replaced part of the previous answer and it stands. Continue the "
                "topic from the next relevant part; do not restart or re-answer what is already right."
            )

        hub.chat.background(work)


# --------------------------------------------------------------------------- #
# the self agent: its own overhead view, its own options, its own decisions
# --------------------------------------------------------------------------- #
class SelfAgent:
    """Nobody tells it what to say next.

    After the exchange settles, one separate prompt asks the model to look at
    the whole conversation from above - the last exchange, leftovers, held
    input, open threads, the session's condition - and choose for itself:

      SPEAK: <the next part, in its own words, only the continuation>
      PREPARE: <what it will work out for later>
      OK

    It can create its own option inside those shapes; the prompt asks for
    judgment, not behavior. SPEAK becomes its own turn (cause=self), PREPARE
    is stored and surfaced on the recorder for later, and OK is silence,
    respected. Rate-limited by lan_self_every so it can never chatter or loop
    on itself."""

    def __init__(self, hub):
        self.hub = hub
        self.every = max(10.0, float(core.setting("lan_self_every", 45, int)))
        self.last = 0.0

    def maybe_schedule(self, force=False):
        hub = self.hub
        if not core.as_bool("lan_self_review", True) or hub.chat.fast_mode:
            return
        if not hub.health.aux_allowed():
            return
        now = time.time()
        if not force and (now - self.last) < self.every:
            return
        self.last = now
        hub.chat.background(self.review)

    def review(self):
        hub = self.hub
        chat = hub.chat
        last_user = str(chat.last_prompt or "")[:400]
        last_answer = str(chat.last_answer or "")[:800]
        with hub.followups.lock:
            held = [item["text"] for item in hub.followups.items][:3]
        held_text = " | ".join(held) if held else "(none)"
        try:
            threads = [
                str(item["text"])[:150] for item in chat.notes.items
                if item.get("kind") in ("continuation", "self", "spin")
            ][-4:]
        except Exception:  # noqa: BLE001
            threads = []
        threads_text = "\n".join(threads) or "(none)"
        state = hub.health.status()
        try:
            verdict = chat.client.complete(
                [
                    {"role": "system", "content": (
                        "You are reviewing your own side of a live conversation from above. "
                        "Decide by yourself what would best move it forward - you may create "
                        "your own option. Reply with exactly one line: "
                        "'SPEAK: <the next part, in your own words, only the continuation, "
                        "no restating>' or 'PREPARE: <what you will work out for later>' or 'OK'."
                    )},
                    {"role": "user", "content": (
                        "Last exchange - user: %s | you: %s\nHeld input: %s\nOpen threads:\n%s\n"
                        "Session: %d turns, %d errors, %d spins\nContinuation checks: %s"
                        % (last_user, last_answer, held_text, threads_text,
                           state["turns"], state["errors"], state["spins"],
                           hub.continue_wrap.directive() or "(nothing pending)")
                    )},
                ],
                max_tokens=300,
                sampling={"temperature": 0.5},
                kind="self-review",
                priority="background",
            ).strip()
        except Exception:  # noqa: BLE001 - a failed review costs nothing
            return
        if not verdict:
            return
        upper = verdict.upper()
        if upper.startswith("SPEAK:"):
            text = verdict.split(":", 1)[1].strip()
            if text:
                hub.broadcast(ch="ai-note", type="self",
                              text="own decision: continuing by myself - %s" % text[:120])
                hub.serve_deferred("[self] %s" % text, cause="self")
        elif upper.startswith("PREPARE:"):
            text = verdict.split(":", 1)[1].strip()
            if text:
                chat.notes.add("self", "prepared next step", text[:400])
                hub.broadcast(ch="ai-note", type="self",
                              text="working out for later: %s" % text[:160])
        # 'OK' - or anything unparseable - is silence, and silence is respected


# --------------------------------------------------------------------------- #
# the continue wrap: 'continue' means different things, checked before it runs
# --------------------------------------------------------------------------- #
class ContinueWrap:
    """There is more than one kind of 'continue'.

    Before anything continues by itself - the self agent's turn, a deferred
    follow-up - the continuation is wrapped: each registered check looks at
    one part of the state and may reshape what continuing means. Built in:

      new_user_input  held input, a live buffer being typed right now:
                      fold the user in first, then continue the thread
      remaining_goals the open goal's real coverage from the engine
                      (memory.goal_progress): continue toward what is
                      still uncovered
      prepared_items  what the model itself worked out for earlier:
                      decide whether now is the moment to present it

    A check returns a directive or ''. Everything that fires folds into one
    instruction, so 'both' is a first-class case, not a conflict. The checks
    list is the extension point: more kinds of continue register here without
    touching the flow."""

    def __init__(self, hub):
        self.hub = hub
        self.checks = [self.new_user_input, self.remaining_goals, self.prepared_items]

    def run(self):
        directives = []
        for check in self.checks:
            try:
                text = str(check() or "").strip()
            except Exception:  # noqa: BLE001 - a failed check never blocks
                text = ""
            if text:
                directives.append(text)
        return directives

    def directive(self):
        parts = self.run()
        return "Before continuing: " + " ".join(parts) if parts else ""

    def new_user_input(self):
        hub = self.hub
        with hub.followups.lock:
            held = [item["text"] for item in hub.followups.items][:3]
        typing = ""
        with hub.lock:
            for info in hub.clients.values():
                buffer = info.get("buffer")
                if buffer is not None:
                    with buffer.lock:
                        if buffer.text.strip():
                            typing = buffer.text.strip()[-120:]
        parts = []
        if held:
            parts.append("held input is waiting: %s" % " | ".join(held))
        if typing:
            parts.append("the user is typing right now: %s - leave room, answer briefly, or wait" % typing)
        if not parts:
            return ""
        return "New user input: %s. Fold it in first, then continue the open thread." % "; ".join(parts)

    def remaining_goals(self):
        memory = self.hub.chat.memory
        goal = str(getattr(memory, "goal", "") or "").strip()
        if not goal:
            return ""
        try:
            progress = float(memory.goal_progress() or 0.0)
        except Exception:  # noqa: BLE001
            progress = 0.0
        if progress >= 0.85:
            return ""
        return "The open goal is only %.0f%% covered: %s. Continue toward what it still needs." % (
            progress * 100, goal[:200],
        )

    def prepared_items(self):
        prepared = [
            str(item["text"])[:200] for item in self.hub.chat.notes.items if item.get("kind") == "self"
        ][-2:]
        if not prepared:
            return ""
        return "You prepared earlier: %s. Decide whether now is the moment to present it." % " | ".join(prepared)


# --------------------------------------------------------------------------- #
# self-redirect: the model's own second prompt after a turn falls short
# --------------------------------------------------------------------------- #
class SelfRedirect:
    """When a turn leaves something behind - an empty answer, a rambled wall,
    meta-commentary instead of a reply - the model gets its own prompt: the
    overhead view (question, what it replied, why the reply fell short) and
    it DECIDES BY ITSELF what to do to succeed for the same feature:
      REDIRECT: a better answer, from its own chosen angle - it may add on or
                drop details as its perspective says, not as code forces
      ASK:      the one thing it needs from the user to succeed
      DROP:     it judged the thread better left, and says why briefly
    No code picks for it; the decision arrives as its own and is shown as
    one. Runs on the quiet-gap lane, cancelled by new input, breaker-aware."""

    def __init__(self, hub):
        self.hub = hub

    def offer(self, prompt, answer, problem):
        hub = self.hub
        if hub.chat.fast_mode or not hub.health.aux_allowed():
            return

        def work():
            try:
                verdict = hub.chat.client.complete(
                    [
                        {"role": "system", "content": (
                            "You just answered a question and the reply fell short. Decide "
                            "for yourself what to do to succeed. Reply exactly one of:\n"
                            "REDIRECT: your better answer - your own angle, adding or dropping "
                            "detail as your perspective says, no restating of the failed reply\n"
                            "ASK: the one thing you need from the user to answer properly\n"
                            "DROP: if continuing adds nothing - one short sentence why"
                        )},
                        {"role": "user", "content": (
                            "Question: %s\n\nMy reply (fell short: %s):\n%s\n\n"
                            "Overhead view: decide by yourself what makes this succeed."
                            % (str(prompt)[:400], problem, str(answer)[:600])
                        )},
                    ],
                    max_tokens=300,
                    sampling={"temperature": 0.5},
                    kind="redirect",
                    priority="background",
                ).strip()
            except Exception:  # noqa: BLE001
                return
            if not verdict:
                return
            if verdict.upper().startswith("REDIRECT:"):
                better = verdict.split(":", 1)[1].strip()
                if better and not core.rambles(better) and not lan_commentary(better) \
                        and not core.near_duplicate(better, answer, 0.9):
                    print("[%s] self-redirect: the model chose its own better answer" % stamp())
                    hub.broadcast(ch="ai", text=better, final=True, revised=True, redirected=True)
                    hub.chat.notes.add("redirect", str(prompt)[:40], better[:600])
            elif verdict.upper().startswith("ASK:"):
                need = verdict.split(":", 1)[1].strip()
                if need:
                    print("[%s] self-redirect: the model asks for what it needs" % stamp())
                    hub.broadcast(ch="ai-note", type="redirect", text="needs from you: %s" % need[:160])
            elif verdict.upper().startswith("DROP:"):
                why = verdict.split(":", 1)[1].strip()
                if why:
                    hub.broadcast(ch="ai-note", type="redirect", text="left as is: %s" % why[:160])

        hub.schedule_quiet("redirect", work)


# --------------------------------------------------------------------------- #
# ai loop: the live racetrack between two AI instances
# --------------------------------------------------------------------------- #
class AiLoop:
    """Two AI instances linked as a live loop - the racetrack.

    Both sides form their own connection to each other (a peer link is the
    route) and then run in parallel:
      handshake   the AIs compose their own handshake (notes size, review
                  passes, ping route) and the other decodes and answers it
      ping race   one-timestamp pings measure the route RTT continuously -
                  the racetrack speed is a number, not a feeling
      mark+grab   one AI MARKS data as a term-vector signal (embedding-lite,
                  cheap to send); the other GRABS: matches the vector against
                  its own notes and delivers the batch back - cross-reference
                  while the first keeps working
      trap        every incoming signal is logged to the session recorder
                  before anything touches the conversation
      finalize    one model pass merges the answer the user already has with
                  whatever the loop brought back - the final, reviewed form
    Backward compatible: signal types ride the existing peer channel, so an
    original-version peer simply ignores what it cannot decode while its
    review-result channel keeps working."""

    PING_EVERY = 5.0
    BATCH = 4

    def __init__(self, hub):
        self.hub = hub
        self.link = None
        self.peer_version = "?"
        self.best_rtt = None
        self.udp_addr = None
        self.avg_rtt = None
        self.rtts = []
        self.queue = []
        self.qlock = threading.Lock()
        self.running = False
        self.pull_seq = 0
        self.pulls = {}
        # data travel: what went where, over what, and what came back
        self.travel = {"sent": 0, "received": 0, "receipts": 0, "bytes_out": 0, "bytes_in": 0}
        self.peer_store = None

    # -- connection ---------------------------------------------------------- #
    def connect(self, host, port):
        hub = self.hub
        if self.running:
            return
        port = int(port)  # --loop hands us "host:port" split, so port arrives as str
        try:
            sock = socket.create_connection((host, int(port)), timeout=10)
            sock.settimeout(None)
            self.link = SocketLink(sock)
            self.link.send(ch="sys", type="hello", role="peer",
                           name=socket.gethostname() + "-loop", live=False,
                           version=VERSION)
            reply = self.link.recv()
            self.peer_version = str((reply or {}).get("version", "?"))
            # the instant link: the peer's UDP sound port, for datagram pings
            self.udp_addr = (host, int(port) + 1)
            self.running = True
            print("[%s] AI loop open to %s:%d (peer build %s)" % (stamp(), host, port, self.peer_version))
            threading.Thread(target=self._read, daemon=True).start()
            threading.Thread(target=self._ping_race, daemon=True).start()
            threading.Thread(target=self.ai_handshake, daemon=True).start()
            threading.Thread(target=self._flush_loop, daemon=True).start()
        except Exception as err:  # noqa: BLE001
            print("[%s] AI loop: the other side refused (%s) - no matter: "
                  "this side answers solo. The loop only adds a second "
                  "opinion, never a dependency." % (stamp(), str(err)[:90]))

    def _read(self):
        while self.running:
            try:
                message = self.link.recv()
            except Exception:  # noqa: BLE001
                message = None
            if message is None:
                print("[%s] AI loop: peer route closed" % stamp())
                self.running = False
                return
            self.on_signal(message)

    # -- the AI handshake ----------------------------------------------------- #
    def ai_handshake(self):
        """The AIs compose their own handshake: capabilities, store size, and
        the open routes - the other side decodes it and answers in kind."""
        hub = self.hub
        n_notes = len(getattr(hub.chat.notes, "items", []))
        try:
            text = hub.chat.client.complete(
                [
                    {"role": "system", "content": (
                        "Compose a one-sentence handshake to another AI instance you are now "
                        "linked with. State what you hold (number of notes), that your ping "
                        "route is open, and that you can mark data for it to grab and analyze. "
                        "Plain text, one sentence, no preamble.")},
                    {"role": "user", "content": "Notes held: %d. Route: LAN TCP, ping every %ds."
                     % (n_notes, int(self.PING_EVERY))},
                ],
                max_tokens=80,
                sampling={"temperature": 0.5},
                kind="loop-handshake",
                priority="background",
            ).strip()
        except Exception:  # noqa: BLE001
            text = "Loop handshake ready: %d notes held, ping route open." % n_notes
        if text:
            self.send("ai-handshake", text=text[:300], notes=n_notes, version=VERSION)
            hub.broadcast(ch="ai-note", type="loop", text="handshake sent: %s" % text[:120])

    # -- the ping race -------------------------------------------------------- #
    def _ping_race(self):
        while self.running:
            self.ping()
            time.sleep(self.PING_EVERY)

    def ping(self):
        """The race ping. Instant link first: a UDP datagram on the sound
        port needs no handshake and no session - sub-millisecond RTTs. TCP
        is the fallback (and the only lane an older peer knows)."""
        send_sock = getattr(self.hub, "udp_send_sock", None)
        if send_sock is not None and self.udp_addr:
            try:
                datagram = json.dumps({"udp": "loop", "type": "ping", "t0": now_ms(),
                                       "name": socket.gethostname()}).encode("utf-8")
                send_sock.sendto(datagram, self.udp_addr)
                return
            except OSError:
                pass
        self.send("ping", t0=now_ms())

    # -- mark and grab --------------------------------------------------------- #
    def mark(self, text, summary=""):
        """Mark data: a term-vector signal (embedding-lite) + short summary.
        The peer grabs it, matches against its own store, delivers the batch."""
        counts = None
        if features is not None and hasattr(features, "vectorize"):
            try:
                counts = features.vectorize(text)
            except Exception:  # noqa: BLE001
                counts = None
        vector = dict(sorted((counts or {}).items(), key=lambda kv: -kv[1])[:40])
        self.queue.append({"type": "mark", "vector": vector,
                           "summary": str(summary or text)[:200]})

    def grab(self, vector):
        """Incoming mark: interpret the vector against our own store, batch
        the matches, and deliver them back across the loop."""
        hub = self.hub
        try:
            if features is not None and hasattr(features, "build_vectors"):
                hits = features.search_vectors(features.build_vectors(hub.chat.notes.items),
                                               " ".join(vector.keys()), limit=6)
                # search_vectors returns (score, entry) pairs carrying only
                # id/title/vector - rejoin the full note text by id
                by_id = {item.get("id"): item for item in getattr(hub.chat.notes, "items", [])}
                full = []
                for hit in hits:
                    entry = hit[1] if isinstance(hit, tuple) else hit
                    item = by_id.get(entry.get("id"), entry)
                    full.append(item)
                hits = full
            else:
                hits = hub.chat.notes.search(" ".join(vector.keys()), limit=6)
        except Exception:  # noqa: BLE001
            hits = []
        batch = [{"kind": h.get("kind", "note"), "title": h.get("title", "")[:80],
                  "text": h.get("text", "")[:240]} for h in hits]
        self.queue.append({"type": "deliver", "items": batch,
                           "matched": len(batch)})
        hub.broadcast(ch="ai-note", type="loop",
                      text="grabbed a mark (%d terms) - %d of our notes match, delivering"
                           % (len(vector), len(batch)))

    # -- signals --------------------------------------------------------------- #
    def send(self, signal_type, **fields):
        if not self.link:
            return
        fields["type"] = signal_type
        payload = json.dumps(dict(fields, ch="peer"), default=str)
        self.travel["sent"] += 1
        self.travel["bytes_out"] += len(payload)
        self.link.send(ch="peer", **fields)

    def _travel(self, direction, medium, kind, nbytes, routed, extra=""):
        """The data-travel display: what went where, over what medium, and
        whether it reached the AI directly or through the network."""
        label = {"out": "sent", "in": "received", "back": "RECEIVED by peer"}[direction]
        line = "[travel] %s %s over %s - %d bytes - route: %s%s" % (
            label, kind, medium, nbytes, routed, (" - " + extra) if extra else "")
        print("[%s] %s" % (stamp(), line))
        self.hub.broadcast(ch="ai-note", type="travel", text=line)
        self.hub.recorder.log(kind="travel", direction=direction, medium=medium,
                              signal=kind, bytes=nbytes, route=routed)

    def on_signal(self, message, addr=None):
        hub = self.hub
        kind = str(message.get("type", ""))
        nbytes = len(json.dumps(message, default=str))
        medium = "udp-instant" if addr is not None else "lan-tcp"
        self.travel["received"] += 1
        self.travel["bytes_in"] += nbytes
        routed = "ai-direct (handled by the loop itself)" if kind in (
            "ping", "pong") else "through the network - stored and batched"
        self._travel("in", medium, kind, nbytes, routed,
                     extra="from %s" % str(message.get("name", "peer"))[:24])
        # trap: every signal lands in the session recorder before anything else
        hub.recorder.log(kind="loop-signal", signal=kind, udp=bool(addr),
                         from_peer=str(message.get("name", "peer"))[:40])
        if kind == "ping":
            if addr is not None:
                # it came as a datagram: the pong goes back the same instant
                # lane, carrying the store count (what data is available)
                send_sock = getattr(hub, "udp_send_sock", None)
                if send_sock is not None:
                    try:
                        send_sock.sendto(json.dumps({"udp": "loop", "type": "pong",
                                                     "t0": message.get("t0"), "t1": now_ms(),
                                                     "name": socket.gethostname(),
                                                     "store": len(getattr(hub.chat.notes, "items", []))}).encode("utf-8"), addr)
                        return
                    except OSError:
                        pass
            self.send("pong", t0=message.get("t0"), t1=now_ms(),
                      store=len(getattr(hub.chat.notes, "items", [])))
        elif kind == "pong":
            t0, t1 = message.get("t0"), message.get("t1")
            if t0 and t1:
                rtt = int(int(t1) - int(t0))
                self.rtts = (self.rtts + [rtt])[-10:]
                self.best_rtt = rtt if self.best_rtt is None else min(self.best_rtt, rtt)
                self.avg_rtt = int(sum(self.rtts) / len(self.rtts))
            if message.get("store") is not None:
                self.peer_store = message.get("store")
        elif kind == "receipt":
            # the other side confirmed arrival: show what it received and
            # where the data went (AI direct or through its network stack)
            self.travel["receipts"] += 1
            self._travel("back", "lan-tcp", message.get("for", "?"),
                         int(message.get("bytes", 0) or 0),
                         str(message.get("routed", "?")),
                         extra="peer store: %s notes" % message.get("store", "?"))
        elif kind == "ai-handshake":
            self.peer_version = str(message.get("version", "?"))
            try:
                reply = hub.chat.client.complete(
                    [
                        {"role": "system", "content": (
                            "Another AI instance just introduced itself over a live loop. "
                            "Reply with one sentence accepting the link and naming what you "
                            "can do in return (hold notes, mark data for it to grab, finalize "
                            "merged answers). Plain text, no preamble.")},
                        {"role": "user", "content": str(message.get("text", ""))[:300]},
                    ],
                    max_tokens=80,
                    sampling={"temperature": 0.5},
                    kind="loop-handshake",
                    priority="background",
                ).strip()
            except Exception:  # noqa: BLE001
                reply = "Link accepted: notes held, marking available, finalize ready."
            if reply:
                self.send("ai-handshake-reply", text=reply[:300])
                hub.broadcast(ch="ai-note", type="loop",
                              text="peer says: %s" % str(message.get("text", ""))[:120])
        elif kind == "ai-handshake-reply":
            hub.broadcast(ch="ai-note", type="loop",
                          text="peer accepted: %s" % str(message.get("text", ""))[:120])
        elif kind == "mark":
            self.grab(message.get("vector", {}))
        elif kind == "request":
            threading.Thread(target=self._answer_request,
                             args=(message.get("req_id", ""), message.get("question", "")),
                             daemon=True).start()
        elif kind == "deliver-answer":
            self._on_deliver_answer(message.get("req_id", ""), message.get("answer", ""))
        elif kind == "deliver":
            items = message.get("items", []) or []
            for item in items:
                try:
                    hub.chat.notes.add("peer", str(item.get("title", ""))[:60],
                                       str(item.get("text", ""))[:400])
                except Exception:  # noqa: BLE001
                    pass
            if items:
                hub.broadcast(ch="ai-note", type="loop",
                              text="peer delivered %d notes - stored as peer notes" % len(items))
        # the receipt echo: the sender's console must see what arrived on this
        # side, over which medium, and whether the data reached the AI directly
        if kind in ("mark", "deliver", "ai-handshake", "request"):
            self.send("receipt", **{"for": kind}, bytes=nbytes, routed=routed,
                      store=len(getattr(hub.chat.notes, "items", [])),
                      queue=len(self.queue))

    def finalize(self, question):
        """One model pass merging the answer the user has with whatever the
        loop brought back from the peer - cross-referenced and finalized."""
        hub = self.hub
        peer_notes = [i for i in getattr(hub.chat.notes, "items", []) if i.get("kind") == "peer"][-6:]
        peer_text = "\n".join("- %s" % i.get("text", "")[:200] for i in peer_notes) or "(nothing from the peer)"
        own = str(hub.chat.last_answer or "")
        try:
            final = hub.chat.client.complete(
                [
                    {"role": "system", "content": (
                        "Merge two sources into one final answer: your own reply and what a "
                        "linked AI instance delivered. Keep what is confirmed by either, drop "
                        "what they contradict without support, and prefer the cleaner phrasing. "
                        "Reply with the final answer only, no commentary.")},
                    {"role": "user", "content": (
                        "Question: %s\n\nYour answer:\n%s\n\nFrom the linked AI:\n%s"
                        % (str(question)[:300], own[:800], peer_text[:900]))},
                ],
                max_tokens=core.MAX_TOKENS,
                sampling={"temperature": 0.3},
                kind="loop-finalize",
                priority="interactive",
            ).strip()
        except Exception as err:  # noqa: BLE001
            print("[%s] finalize failed: %s" % (stamp(), str(err)[:100]))
            return
        if final and not core.rambles(final) and not lan_commentary(final):
            hub.broadcast(ch="ai", text=final, final=True, revised=True, finalized=True)
            hub.chat.notes.add("reviewed", str(question)[:40], final[:600])
            print("[%s] finalized with the loop: %s" % (stamp(), final[:100]))

    # -- batched outbound ------------------------------------------------------ #
    def _flush_loop(self):
        """Batch processing: queued signals leave in groups on one timer -
        fewer, steadier messages over the route."""
        while self.running:
            time.sleep(1.0)
            batch = []
            with self.qlock:
                while self.queue and len(batch) < self.BATCH:
                    batch.append(self.queue.pop(0))
            for item in batch:
                self.send(item["type"], **{k: v for k, v in item.items() if k != "type"})
            if batch:
                self.hub.recorder.log(kind="loop-batch", sent=len(batch))

    # -- the parallel pull: two AIs answer at once ----------------------------- #
    def pull_answer(self, question, own_answer):
        """While our answer streams, the peer AI answers the SAME question on
        ITS engine - free on our pipe, so it runs even in --fast. The merge
        then reconciles both into one better final."""
        if not self.running:
            return
        self.pull_seq += 1
        req_id = "%d" % self.pull_seq
        self.pulls[req_id] = {"question": str(question), "own": str(own_answer),
                              "peer": None, "at": time.time()}
        self.send("request", req_id=req_id, question=str(question)[:400])
        self.hub.broadcast(ch="ai-note", type="loop",
                           text="parallel pull: the peer AI is answering alongside")

    def _answer_request(self, req_id, question):
        """The peer asked US: answer on our engine, quietly, and deliver back.
        Role law: our USER's turn always outranks the peer's question - no
        request is answered while a turn runs, in --fast, or while the aux
        breaker says the pipe is pressured. The peer retries or goes without."""
        hub = self.hub
        if hub.chat.fast_mode or hub.turn_lock.locked() or not hub.health.aux_allowed():
            self.send("deliver-answer", req_id=req_id, answer="")  # polite decline
            return
        try:
            answer = hub.chat.client.complete(
                [
                    {"role": "system", "content": (
                        "Answer directly and concisely. Plain text, no preamble, no "
                        "commentary about the question.")},
                    {"role": "user", "content": str(question)[:600]},
                ],
                max_tokens=300,
                sampling={"temperature": 0.4},
                kind="loop-request",
                priority="background",
            ).strip()
        except Exception:  # noqa: BLE001
            return
        if answer:
            self.send("deliver-answer", req_id=req_id, answer=answer[:1200])

    def _on_deliver_answer(self, req_id, answer):
        hub = self.hub
        pull = self.pulls.get(str(req_id))
        if not pull or not answer:
            return
        pull["peer"] = str(answer)
        own = pull.get("own") or ""
        if not own or own.startswith("("):
            # our side had nothing: the peer's answer IS the answer
            hub.broadcast(ch="ai", text=pull["peer"], final=True, peer_answer=True)
            return
        if core.near_duplicate(pull["peer"], own, 0.92):
            hub.broadcast(ch="ai-note", type="loop",
                          text="peer agrees with our answer (parallel pull confirmed it)")
            return

        def merge():
            try:
                merged = hub.chat.client.complete(
                    [
                        {"role": "system", "content": (
                            "Two AI instances answered the same question in parallel. Merge them "
                            "into one final answer: keep what both agree on, add what only one "
                            "has if it is plausible, drop contradictions without support. Reply "
                            "with the final answer only.")},
                        {"role": "user", "content": (
                            "Question: %s\n\nAnswer A (ours):\n%s\n\nAnswer B (peer):\n%s"
                            % (pull["question"][:300], own[:700], pull["peer"][:700]))},
                    ],
                    max_tokens=core.MAX_TOKENS,
                    sampling={"temperature": 0.3},
                    kind="loop-merge",
                    priority="interactive",
                ).strip()
            except Exception:  # noqa: BLE001
                return
            if merged and not core.rambles(merged) and not lan_commentary(merged) \
                    and not core.near_duplicate(merged, own, 0.95):
                hub.broadcast(ch="ai", text=merged, final=True, revised=True,
                              pull_merged=True)
                hub.chat.notes.add("reviewed", pull["question"][:40], merged[:600])
                print("[%s] parallel pull merged: two-AI answer finalized" % stamp())

        hub.schedule_quiet("pull-merge", merge)

    def status(self):
        if not self.running:
            return "loop closed"
        t = self.travel
        return ("peer %s | best %s ms | avg %s ms | queued %d | "
                "travel: sent %d (%d B) - received %d (%d B) - receipts %d - peer store %s").replace("\n", "") % (
            self.peer_version, self.best_rtt, self.avg_rtt, len(self.queue),
            t["sent"], t["bytes_out"], t["received"], t["bytes_in"], t["receipts"],
            self.peer_store)


# --------------------------------------------------------------------------- #
# parallel review: instant answer as the pull, then 3-4 improving passes
# --------------------------------------------------------------------------- #
class ParallelReview:
    """The first answer goes out instantly - that is the pull, nothing waits
    for it. Then, in the quiet gaps, a bounded chain of up to lan_review_tries
    review passes runs, each able to broadcast an improved revision live:
      pass 1  fact check, CITED against the main notes and recent history
      pass 2  the model's own better-angle check (its own choice to improve)
      pass 3+ final conclusion - consolidates what survived, stores it in the
              notes as the reviewed record, and says so
    Priority law applies throughout: every pass yields to new input, stands
    down when the pipe is busy, and the chain simply ends there - the answer
    the user already has is never made worse by a review that cannot run."""

    def __init__(self, hub, tries=3):
        self.hub = hub
        self.tries = max(1, int(core.setting("lan_review_tries", tries, int)))

    def schedule(self, prompt, answer):
        hub = self.hub
        if hub.chat.fast_mode or not hub.health.aux_allowed():
            return
        state = {"round": 0, "best": str(answer), "prompt": str(prompt)}

        def run_round():
            if state["round"] >= self.tries:
                return
            r = state["round"] + 1
            state["round"] = r
            last = state["best"]
            if r == 1:
                # cited fact check: the main notes ride into the prompt
                try:
                    hits = hub.chat.notes.search(state["prompt"], limit=3)
                except Exception:  # noqa: BLE001
                    hits = []
                cited = "\n".join("[%s] %s" % (h.get("kind"), h.get("text", "")[:200])
                                  for h in hits) or "(no notes)"
                system = ("Fact-check this answer against the cited notes and your own "
                          "knowledge. Reply exactly 'OK' if it stands. Otherwise reply "
                          "'BETTER:' followed by the corrected answer, nothing else.")
                user = "Question: %s\nAnswer: %s\nCited notes:%s" % (
                    state["prompt"][:300], last[:600], cited[:900])
            elif r == 2:
                system = ("Could this answer be better from your own angle - clearer, more "
                          "useful, better ordered, anything missing? You decide. Reply "
                          "exactly 'OK' if it stands, or 'BETTER:' followed by your improved "
                          "answer. Do not restate the original - improve it.")
                user = "Question: %s\nAnswer: %s" % (state["prompt"][:300], last[:600])
            else:
                # final pass: conclusion, stored as the reviewed record
                conclusion = _conclude(hub, state["prompt"], last)
                if conclusion:
                    hub.chat.notes.add("reviewed", state["prompt"][:40], conclusion[:600])
                    hub.broadcast(ch="ai-note", type="review",
                                  text="review concluded (%d passes): %s" % (r, conclusion[:120]))
                    # the loop: mark it - the peer AI can grab and analyze
                    # in parallel while we keep answering
                    if getattr(hub.ai_loop, "running", False):
                        hub.ai_loop.mark(conclusion, state["prompt"])
                return
            try:
                verdict = hub.chat.client.complete(
                    [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    max_tokens=300,
                    sampling={"temperature": 0.3},
                    kind="review",
                    priority="background",
                ).strip()
            except Exception:  # noqa: BLE001
                return
            if verdict and verdict.upper().startswith("BETTER:"):
                better = verdict.split(":", 1)[1].strip()
                if (better and not core.rambles(better) and not lan_commentary(better)
                        and not core.near_duplicate(better, last, 0.9)):
                    state["best"] = better
                    hub.broadcast(ch="ai", text=better, final=True, revised=True, review=r)
                    print("[%s] review pass %d: improved answer went out" % (stamp(), r))
                if r < self.tries:
                    start_round()
                return
            # anything else - OK, yes, or a reply that is not an improvement -
            # means the answer stands: end the chain. Running passes 2 and 3 on
            # a standing answer was pure churn: up to two more full calls (and
            # possible revision broadcasts) for nothing, which read as
            # 'still taking long'.
            hub.broadcast(ch="ai-note", type="review",
                          text="review pass %d confirmed the answer stands" % r)
            print("[%s] review pass %d: answer stands - chain ended early" % (stamp(), r))

        def start_round():
            if hub.bg_live and hub.health.aux_allowed():
                # live lanes: the pass runs CONCURRENTLY with everything else
                # (the old 3-in-1 speed); the lane grace gives the answer a
                # head start and the breaker stands it down if the pipe is slow
                threading.Thread(target=run_round, daemon=True).start()
            else:
                hub.schedule_quiet("review", run_round, delay=2.0)

        start_round()


def _conclude(hub, prompt, answer):
    """Final review pass: a two-sentence conclusion of what survived review."""
    try:
        text = hub.chat.client.complete(
            [
                {"role": "system", "content": (
                    "Conclude this reviewed exchange in at most two sentences: the settled "
                    "answer, no preamble, no meta-commentary.")},
                {"role": "user", "content": "Question: %s\nReviewed answer: %s"
                 % (str(prompt)[:300], str(answer)[:600])},
            ],
            max_tokens=120,
            sampling={"temperature": 0.2},
            kind="review-conclude",
            priority="background",
        ).strip()
        return text if text and not lan_commentary(text) else ""
    except Exception:  # noqa: BLE001
        return ""


# --------------------------------------------------------------------------- #
# familiarity: instant notes, instant scoring, and the score fires the brain
# --------------------------------------------------------------------------- #
class Familiarity:
    """Notes are not a pause - they are the accelerator.

    capture(): the instant a turn ends, it lands in the notes store as a trail
    entry - a local append, no model call, nothing to lose, --fast included.

    fire(): then the trail is scored for familiarity (local term overlap
    against recent notes and turns, again no model call) and the score picks
    the next action by itself:
      low  -> fresh topic:  a clean self-continuation on new ground
      mid  -> related:      review the answer against the notes, then continue
      high -> well-trodden: consolidate - summary + conclusion + one test
                           question that checks the key fact
    The whole chain respects the aux breaker, so on a slow endpoint the
    capture still happens every turn and only the model work stands down."""

    LOW, HIGH = 0.12, 0.25

    def __init__(self, hub):
        self.hub = hub

    def score(self, text):
        hub = self.hub
        words = topic_terms(text)
        if not words:
            return 0.0
        items = [item for item in getattr(hub.chat.notes, "items", [])[-60:]]
        for turn in hub.chat.memory.turns[-3:]:
            items.append({"text": str(turn.get("answer", ""))})
        best = 0.0
        for item in items:
            body_words = topic_terms(str(item.get("text", "")))
            if body_words:
                overlap = len(words & body_words) / float(len(words))
                if overlap > best:
                    best = overlap
        return round(min(1.0, best), 2)

    def capture(self, prompt, answer):
        """The instant backup trail - written to the session recorder (append-
        only JSONL), NOT to the notes store. Raw Q&A dumps in the notes store
        get recalled into later turns' context, which grew the prefill every
        turn (the 'doubles for each line' slowness) and fed the model its own
        past answers. The recorder keeps the trail whole without polluting
        recall; only curated facts, events and conclusions get notes."""
        try:
            self.hub.recorder.log(kind="turn", prompt=str(prompt)[:300],
                                  answer=str(answer)[:600])
        except Exception:  # noqa: BLE001 - the trail must never break a turn
            pass

    def fire(self, prompt, answer):
        hub = self.hub
        self.capture(prompt, answer)
        if hub.chat.fast_mode or not hub.health.aux_allowed():
            return  # the trail is written; only the model work stands down
        score = self.score(str(prompt) + " " + str(answer)[:400])
        if score < self.LOW:
            action = "next topic"
        elif score < self.HIGH:
            action = "review"
        else:
            action = "consolidate"
        hub.broadcast(ch="ai-note", type="familiar",
                      text="familiarity %.2f -> %s" % (score, action))
        question = str(prompt)
        reply = str(answer)

        def work():
            try:
                if action == "review":
                    hub.reflector.schedule(question, reply)
                    hub.self_agent.maybe_schedule(force=True)
                    return
                if action == "next topic":
                    hub.self_agent.maybe_schedule(force=True)
                    return
                text = hub.chat.client.complete(
                    [
                        {"role": "system", "content": (
                            "This topic is familiar; consolidate it. Reply with plain "
                            "text and no preamble: a two-sentence summary, a one-sentence "
                            "conclusion, and one short test question that checks the key fact."
                        )},
                        {"role": "user", "content": "Thread so far:\n%s" % reply[:800]},
                    ],
                    max_tokens=300,
                    sampling={"temperature": 0.3},
                    kind="familiar",
                    priority="background",
                ).strip()
            except Exception:  # noqa: BLE001 - a failed fire costs nothing
                return
            if text:
                hub.chat.notes.add("conclusion", question[:40], text[:600])
                hub.broadcast(ch="ai-note", type="familiar",
                              text="consolidated (summary + conclusion + test): %s" % text[:160])

        # the model work waits for a quiet gap and is cancelled by new input:
        # the capture already happened instantly, so notes are never lost -
        # they just never delay the next answer
        hub.schedule_quiet("familiarity", work)


# --------------------------------------------------------------------------- #
# mount keeper: a spun-off model is a physical problem, so recovery is physical
# --------------------------------------------------------------------------- #
class MountKeeper:
    """The model left its mount. Recovery is not a log line: it is forcing a
    fresh mount - one tiny call after another on its own thread until the
    endpoint answers inside a sane TTFT - and then reporting exactly once:
    're-mounted and answering', or 'still off after N attempts' so a human
    knows to check the endpoint itself. One recovery runs at a time; while it
    runs, further failures only note, they never nest."""

    def __init__(self, hub, attempts=3):
        self.hub = hub
        self.attempts = max(1, int(attempts))
        self.lock = threading.Lock()
        self.running = False

    def recover_async(self, reason=""):
        with self.lock:
            if self.running:
                return  # the running recovery's report covers this cause
            self.running = True

        def work():
            try:
                self.recover(reason)
            finally:
                with self.lock:
                    self.running = False

        threading.Thread(target=work, daemon=True).start()

    def recover(self, reason=""):
        hub = self.hub
        client = hub.chat.client
        for attempt in range(1, self.attempts + 1):
            hub.broadcast(
                ch="ai-note", type="remount",
                text="remount attempt %d/%d (%s)" % (attempt, self.attempts, reason),
            )
            started = time.time()
            try:
                text = client.complete(
                    [{"role": "user", "content": "Reply with one word: ready"}],
                    max_tokens=3,
                    kind="remount",
                    priority="interactive",  # recovery preempts background work
                )
            except Exception as err:  # noqa: BLE001
                hub.health.alert("remount attempt %d failed: %s" % (attempt, str(err)[:120]))
                time.sleep(2.0)
                continue
            ms = int((time.time() - started) * 1000)
            if text and ms <= hub.ttft_alert:
                hub.broadcast(
                    ch="ai-note", type="remount",
                    text="model re-mounted and answering (attempt %d, %d ms)" % (attempt, ms),
                )
                hub.warm.touch()
                return
            hub.health.alert("remount answered but slow (%d ms); forcing another mount" % ms)
        hub.health.alert("model still off the mount after %d attempts - check the endpoint" % self.attempts)


# --------------------------------------------------------------------------- #
# the physical audio wire: plain UDP next to the TCP home
# --------------------------------------------------------------------------- #
class UdpAudio:
    """No handshake, no session, no app state: datagrams in, and the hub acts.

    A datagram is either a JSON object {b64, transcript, name} - handled
    exactly like ch="audio" on the TCP channel - or raw bytes, which are kept
    as call chunks under state/lan_audio/. Anything that decodes into a
    transcript goes straight into a turn, so the audio side can talk to the
    model with nothing but a UDP socket on the LAN."""

    def __init__(self, hub, port):
        self.hub = hub
        self.port = int(port)

    def start(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("0.0.0.0", self.port))
        # datagrams OUT too: the AI loop's race pings ride this socket -
        # no handshake, no session, no data travel: an instant link
        self.send_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.hub.udp_send_sock = self.send_sock
        print("[%s] UDP audio listening on port %d" % (stamp(), self.port))

        def loop():
            while True:
                try:
                    data, addr = sock.recvfrom(65536)
                except OSError:
                    return
                self.hub.warm.touch()
                payload = None
                try:
                    text = data.decode("utf-8")
                    if text.lstrip().startswith("{"):
                        loaded = json.loads(text)
                        if isinstance(loaded, dict):
                            payload = loaded
                except (UnicodeDecodeError, json.JSONDecodeError):
                    payload = None
                if payload is not None and payload.get("udp") == "loop":
                    # the instant link: loop signals as datagrams - ping/pong
                    # race timing without any TCP handshake
                    if getattr(self.hub, "ai_loop", None):
                        self.hub.ai_loop.on_signal(payload, addr=addr)
                    continue
                if payload is not None and (payload.get("b64") or payload.get("transcript")):
                    threading.Thread(target=self.hub.on_audio, args=(payload,), daemon=True).start()
                    continue
                folder = Path(core.STATE) / "lan_audio"
                folder.mkdir(parents=True, exist_ok=True)
                path = folder / ("raw_%d.bin" % now_ms())
                try:
                    path.write_bytes(data)
                except Exception as err:  # noqa: BLE001
                    self.hub.health.alert("raw audio not kept: %s" % err)
                    continue
                self.hub.broadcast(
                    ch="ai-note", type="audio",
                    text="raw audio %d bytes from %s kept (%s); send JSON {transcript:...} for a turn"
                         % (len(data), addr[0], path.name),
                )

        threading.Thread(target=loop, daemon=True).start()


# --------------------------------------------------------------------------- #
# the AI home
# --------------------------------------------------------------------------- #
def _enable_prompt_cache(client):
    """Ollama-side KV-cache reuse: 'cache_prompt': true lets the server reuse
    the prefill work of the shared conversation prefix instead of re-reading
    the whole context every turn. On a remote endpoint prefill IS the first
    token wait, so this is the biggest network-era speed lever available to
    the client. The engine file stays untouched - the body builder is wrapped.
    Settings switch: lan_cache_prompt (off for non-Ollama proxies)."""
    if not core.setting("lan_cache_prompt", True, bool):
        return
    original = getattr(client, "_body", None)
    if not callable(original):
        return

    def patched(messages, model, max_tokens, stream, sampling, think=None):
        body = original(messages, model, max_tokens, stream, sampling, think)
        body["cache_prompt"] = True
        return body

    client._body = patched


def salad(text):
    """The 2B word-salad wall, in both degeneration shapes:
      - a comma chain of single words ('running, jumping, flying, ...')
      - a space-run with no sentence structure ('stopping starting ending ...')
    Locally detected so the repetition extender never feeds it and the answer
    is trimmed instead."""
    tail = str(text)[-600:]
    segments = [part.strip() for part in tail.split(",")]
    single = sum(1 for part in segments if part and " " not in part and len(part) > 2)
    if len(segments) >= 18 and single >= max(14, int(len(segments) * 0.5)):
        return True
    words = tail.split()
    if len(words) >= 60 and len(re.findall(r"[.!?]", tail)) <= 1 and tail.count(",") <= 3:
        return True  # a wall of words that never forms a sentence
    return False


# --------------------------------------------------------------------------- #
# the reroute: one inherent socket to the model
# --------------------------------------------------------------------------- #
class DirectLine:
    """Not a proxy hop - a reroute. The engine's web session (requests +
    urllib3) wraps every call in a transport layer; DirectLine replaces it
    with raw HTTP/1.1 keep-alive over ONE socket per lane, opened at boot
    and kept hot forever because the warm pings ride the SAME connection
    (that is what kills the per-connection reload: the line never goes
    cold). NDJSON is read straight off the wire - no session bookkeeping,
    no buffered decoding, no per-call assembly. The engine's own lanes,
    guard and telemetry are untouched: only the transport under them swaps.
    Fallback is automatic: repeated failures restore the original web
    session and the answer never breaks."""

    def __init__(self, hub):
        self.hub = hub
        client = hub.chat.client
        self.url = str(client.url)
        parsed = urlparse(self.url)
        self.secure = parsed.scheme == "https"
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or (443 if self.secure else 80)
        self.path = parsed.path or "/"
        if parsed.query:
            self.path += "?" + parsed.query
        self.pool = []
        self.pool_lock = threading.Lock()
        self.fails = 0
        self.installed = False
        self.original_chunks = None

    def install(self):
        client = self.hub.chat.client
        if client.demo or not core.setting("lan_direct_line", True, bool):
            return False
        self.original_chunks = client._http_chunks
        client._http_chunks = self._chunks
        self.installed = True
        return True

    def label(self):
        return "direct line: %s://%s:%d%s - %d socket(s) kept hot, no web layer" % (
            "https" if self.secure else "http", self.host, self.port, self.path,
            len(self.pool) + 1)

    def _connect(self):
        if self.secure:
            conn = http.client.HTTPSConnection(self.host, self.port, timeout=core.TIMEOUT)
        else:
            conn = http.client.HTTPConnection(self.host, self.port, timeout=core.TIMEOUT)
        return conn

    def _acquire(self):
        with self.pool_lock:
            conn = self.pool.pop() if self.pool else None
        return conn or self._connect()

    def _release(self, conn):
        with self.pool_lock:
            if len(self.pool) < 4:
                self.pool.append(conn)
                return
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass

    def _drop(self, conn):
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass

    def _chunks(self, messages, model, max_tokens, sampling, think=None, read_timeout=None):
        """Same signature and yield contract as the engine's _http_chunks:
        ('content'|'thinking', piece) pairs, with the think-retry kept."""
        client = self.hub.chat.client
        body = client._body(messages, model, max_tokens, True, sampling, think)
        attempts = [body]
        if not think:
            # the engine's own retry: reasoning-only answers get one more
            # call with an explicit answer instruction
            retry = dict(body)
            retry["think"] = False
            retry["messages"] = list(messages) + [
                {"role": "system", "content": "Answer with only the final answer. No reasoning."}]
            attempts.append(retry)
        last_error = "request failed"
        for index, attempt in enumerate(attempts):
            answered = 0
            try:
                for channel, piece in self._stream_once(attempt, read_timeout):
                    if channel == "content":
                        answered += len(piece)
                    yield (channel, piece)
            except Exception as err:  # noqa: BLE001
                last_error = str(err)
                self.fails += 1
                if self.fails >= 4:
                    self.uninstall("direct line failed repeatedly - back to the pooled web session")
                if answered or index == len(attempts) - 1:
                    raise RuntimeError(last_error)
                continue
            self.fails = 0
            if answered:
                return
            last_error = "reasoning only; retrying with an explicit answer instruction"

    def _stream_once(self, body, read_timeout):
        conn = self._acquire()
        try:
            if read_timeout:
                conn.timeout = float(read_timeout)
            payload = json.dumps(body).encode("utf-8")
            conn.request("POST", self.path, body=payload,
                         headers={"Content-Type": "application/json",
                                  "Content-Length": str(len(payload))})
            resp = conn.getresponse()
            if resp.status >= 400:
                detail = resp.read()[:300].decode("utf-8", "replace").replace("\n", " ").strip()
                raise RuntimeError(detail or ("HTTP %d" % resp.status))
            for raw in iter(resp.readline, b""):
                line = raw.decode("utf-8", "replace").strip()
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
                    yield ("content", piece)
            # the body is fully read: this socket stays hot for the next call
            self._release(conn)
        except BaseException:
            # GeneratorExit counts: a mid-stream wall cut closes this
            # generator - drop the socket, never leak it
            self._drop(conn)
            raise

    def uninstall(self, why):
        if not self.installed:
            return
        self.installed = False
        client = self.hub.chat.client
        client._http_chunks = self.original_chunks
        self.hub.health.announce(why)


# --------------------------------------------------------------------------- #
# the hub
# --------------------------------------------------------------------------- #
class LaneGuard:
    """A lane gate that cannot park the answer forever.

    The engine's lanes make an interactive call wait while background calls
    hold their slots, and they wait with no deadline at all (fast_chat.py:697).
    One aux request stalled on the endpoint - the 240 s ceiling, an eviction
    spike - then parks every answer silently: turn_lock stays held, typed input
    is requeued, nothing is printed. The turn's own continuation pass runs at
    background priority, so it lands in the same wait.

    The whole fix is one bound on that wait. After lan_lane_patience_ms the
    caller proceeds counted even though the gate still reports busy: an extra
    request on the pipe costs a little latency, a frozen answer costs the
    conversation. Nothing is cancelled and no thread is added - the stalled
    request still finishes on its own, it just no longer holds anyone else.

    Counters stay balanced: proceeding increments the counter the gate would
    have incremented, and the engine's own release() decrements it in its
    finally block. fast_chat.py is not modified.
    """

    def __init__(self, hub):
        self.hub = hub
        self.patience = max(0.5, int(core.setting("lan_lane_patience_ms", 4000, int)) / 1000.0)
        self.last_report = 0.0  # one line per burst, not one per call

    def install(self):
        lanes = self.hub.chat.client.lanes
        original = lanes.acquire
        guard = self

        def acquire(priority="interactive", timeout=None):
            limit = guard.patience if timeout is None else min(float(timeout), guard.patience)
            if original(priority, timeout=limit):
                return True
            # the gate is jammed behind work that is not finishing: go anyway,
            # counted exactly as the gate would have counted us
            with lanes.cond:
                if priority == "interactive":
                    lanes.active_interactive += 1
                else:
                    lanes.active_background += 1
            now = time.time()
            if now - guard.last_report > 5.0:
                guard.last_report = now
                line = ("lane guard: a %s call waited %.1fs behind work that is not "
                        "finishing - proceeding instead of queueing behind it" % (priority, limit))
                print("[%s] %s" % (stamp(), line))
                guard.hub.broadcast(ch="ai-note", type="lane", text=line)
            return True

        lanes.acquire = acquire


class Hub:
    """One Chat engine, many links, never stops listening."""

    def __init__(self, speak=False, peer_review=False, port=DEFAULT_PORT, fast=None):
        self.speak = speak
        self.peer_review_enabled = peer_review
        self.port = port
        self.clients = {}          # SocketLink -> {"role": "user"|"peer", "name": str}
        self.lock = threading.Lock()
        self.gate = ImportanceGate()
        self.chat = self.build_chat()
        if fast is not None:
            # --fast / --no-fast: the flag from the console launcher, now on the
            # bridge too. The engine skips memory assembly, cache misses cost
            # nothing extra, and the streamed live path honors it as well.
            self.chat.fast_mode = bool(fast)
        self.pending_draft = None  # last draft sent, so the final can supersede it
        self.steer_note = ""
        # live layer
        self.live_settle = int(core.setting("lan_settle_ms", 200, int))  # 0 = 0s mode
        self.fragment_settle = max(self.live_settle, int(core.setting("lan_fragment_settle_ms", 800, int)))
        self.turn_lock = threading.Lock()  # one turn at a time, like the Lanes rule
        self.speculative = Speculative(self)
        self.watchdog_started = False
        self.drafting = False  # single flight: one draft call in flight, ever
        # staying-up layer
        self.ttft_alert = max(1000, int(core.setting("lan_ttft_alert_ms", 8000, int)))
        self.gap_alert = max(2000, int(core.setting("lan_gap_alert_ms", 15000, int)))
        self.health = Health(self)
        self.recorder = Recorder(self)
        self._cache_guard()
        self._context_diet()
        # the reroute: one inherent socket per lane replaces the pooled web
        # session under the engine's own lanes/guard/telemetry
        self.direct = DirectLine(self)
        if self.direct.install():
            print("[%s] reroute: %s" % (stamp(), self.direct.label()))
        self.warm = KeepWarm(self)
        self.keeper = MountKeeper(self)
        self.health.setup(self.chat.client)
        self.lane_guard = LaneGuard(self)
        self.lane_guard.install()
        # live-thinking layer
        self.prefetch = {}
        self.rec_settle = max(80, int(core.setting("lan_rec_settle_ms", 120, int)))
        self.reflector = Reflector(self)
        self.bg_live = core.as_bool("lan_background_live", False)
        self.apply_lanes()
        # held input and continuation state
        self.followups = FollowUps(self)
        self.continuation = ""
        # self-direction layer
        self.self_agent = SelfAgent(self)
        self.continue_wrap = ContinueWrap(self)
        self.familiarity = Familiarity(self)
        self.self_redirect = SelfRedirect(self)
        self.parallel_review = ParallelReview(self)
        self.ai_loop = AiLoop(self)
        # prompt interjections: text the user inserts at pipeline points, to
        # test whether the model actually incorporates it while thinking and
        # processing updated responses - not just an on/off switch
        self.interject = {}
        # one-time cleanup: trail notes written by earlier builds pollute
        # every turn's recalled context - they are ARCHIVED, never deleted:
        # every removed item lands in chat_trail_archive.json, so the data
        # stays restorable forever (user directive: nothing is deleted)
        try:
            stale = [item for item in getattr(chat.notes, "items", [])
                     if item.get("kind") in ("trail",)]
            if stale:
                archive_path = Path(core.STATE) / "chat_trail_archive.json"
                existing = []
                if archive_path.exists():
                    try:
                        existing = json.loads(archive_path.read_text(encoding="utf-8"))
                    except Exception:  # noqa: BLE001
                        existing = []
                merged = {item.get("id"): item for item in existing}
                for item in stale:
                    merged[item.get("id")] = item
                archive_path.write_text(json.dumps(list(merged.values()), indent=1),
                                        encoding="utf-8")
                chat.notes.items = [item for item in chat.notes.items
                                    if item.get("kind") != "trail"]
                chat.notes.save()
                print("[%s] archived %d raw trail notes (chat_trail_archive.json) - "
                      "out of the recall store, nothing deleted"
                      % (stamp(), len(stale)))
        except Exception:  # noqa: BLE001
            pass
        self._flow_note_added = False
        self._add_flow_note()

    # -- engine ------------------------------------------------------------- #
    @staticmethod
    def build_chat():
        if hasattr(core, "console_setup"):
            core.console_setup()
        telemetry = core.Telemetry(Path(core.STATE) / "chat_telemetry.jsonl")
        cache = core.AnswerCache(Path(core.STATE) / "chat_cache.json")
        notes = core.Notes(Path(core.STATE) / "chat_notes.json")
        client = core.Client(telemetry=telemetry)
        _enable_prompt_cache(client)
        chat = core.Chat(client, cache, notes, telemetry)
        chat.background(chat.warm_up)
        return chat

    # -- sockets ------------------------------------------------------------ #
    def serve_forever(self, audio_port=0):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("0.0.0.0", self.port))
        server.listen(8)
        print("[%s] LAN home listening on port %d (chat engine ready)" % (stamp(), self.port))
        print("  model: %s | fast: %s | state: %s" % (core.MODEL, core.FAST_MODEL, core.STATE))
        print("  call log: %s" % self.recorder.path)
        threading.Thread(target=self.warm.load_once, daemon=True).start()
        self.warm.start()
        # loop console: ':loop host port' opens the AI loop, ':loop status'
        # shows the race, ':finalize question' merges the loop's findings
        def console():
            while True:
                try:
                    line = input().strip()
                except Exception:  # noqa: BLE001
                    return
                if not line:
                    continue
                if line.startswith(":loop "):
                    parts = line.split()
                    if len(parts) >= 3:
                        self.ai_loop.connect(parts[1], parts[2])
                    elif parts[1] == "status":
                        print("[%s] loop: %s" % (stamp(), self.ai_loop.status()))
                elif line.startswith(":finalize "):
                    threading.Thread(target=self.ai_loop.finalize,
                                     args=(line[10:].strip(),), daemon=True).start()
                elif not line.startswith(":"):
                    # the home console chats too: plain text is a turn for the
                    # engine on this machine - no link needed to test an answer
                    print("[%s] turn: %s" % (stamp(), line[:60]))

                    def local_turn():
                        try:
                            self.on_user({"text": line}, link=None)
                            answer = str(getattr(self.chat, "last_answer", ""))
                            print("AI: %s" % (answer[:400] if answer else "(nothing came back)"))
                        except Exception as err:  # noqa: BLE001
                            print("[%s] turn failed: %s" % (stamp(), str(err)[:150]))

                    threading.Thread(target=local_turn, daemon=True).start()

        threading.Thread(target=console, daemon=True).start()

        def boot_selftest():
            """One silent model question at boot: names the broken leg
            immediately instead of 'no answer' with no clue where it died."""
            try:
                t0 = time.time()
                text = self.chat.client.complete(
                    [{"role": "user", "content": "Reply with the single word: ok"}],
                    max_tokens=8, kind="boot-selftest", priority="background")
                ms = int((time.time() - t0) * 1000)
                if text and "ok" in str(text).lower():
                    print("[%s] boot self-test: model answered in %d ms - "
                          "the engine leg works; any silence past this is "
                          "client-side" % (stamp(), ms))
                else:
                    print("[%s] boot self-test: model replied %r in %d ms "
                          "(alive, but odd - watch the first real turn)"
                          % (stamp(), str(text)[:40], ms))
            except Exception as err:  # noqa: BLE001
                print("[%s] boot self-test FAILED: %s - the model leg is the "
                      "problem, not the LAN, not the typing path"
                      % (stamp(), str(err)[:160]))

        threading.Thread(target=boot_selftest, daemon=True).start()
        if audio_port:
            UdpAudio(self, audio_port).start()
        self._server = server
        while True:
            try:
                sock, addr = server.accept()
            except OSError:
                print("[%s] home stopped" % stamp())
                return
            sock.settimeout(HELLO_TIMEOUT)
            link = SocketLink(sock)
            hello = link.recv()
            role = str(hello.get("role", "user")) if hello else "user"
            sock.settimeout(None)
            if not hello:
                print("[%s] %s connected but sent nothing; dropped" % (stamp(), addr[0]))
                link.close()
                continue
            name = str(hello.get("name") or addr[0])
            live = bool(hello.get("live"))
            link_version = str(hello.get("version", "?"))
            with self.lock:
                self.clients[link] = {"role": role, "name": name, "live": live, "buffer": None,
                                      "version": link_version}
            link.send(ch="sys", type="welcome", text="link up", engine=str(core.MODEL), live=live,
                      version=VERSION)
            print("[%s] %s linked as %s (%s)%s" % (stamp(), name, role, addr[0], " live" if live else ""))
            if link_version != VERSION:
                print("[%s] *** VERSION MISMATCH: link %s but home %s - the link machine is "
                      "running a stale copy; copy the current fast_chat_lan.py over it ***"
                      % (stamp(), link_version, VERSION))
            if live:
                self.start_watchdog()
            threading.Thread(target=self.read_loop, args=(link,), daemon=True).start()

    def broadcast(self, exclude=None, **fields):
        """exclude= is a SocketLink that should NOT see this message (the
        sender of a typing echo, for example)."""
        self.recorder.log(**fields)
        with self.lock:
            links = list(self.clients.items())
        for link, info in links:
            if info["role"] == "peer" or (exclude is not None and link is exclude):
                continue  # peers get peer traffic, not the user feed
            link.send(**fields)

    def first_user(self):
        with self.lock:
            for link, info in self.clients.items():
                if info["role"] == "user":
                    return link
        return None

    def first_peer(self):
        with self.lock:
            for link, info in self.clients.items():
                if info["role"] == "peer":
                    return link
        return None

    # -- inbound ------------------------------------------------------------ #
    def read_loop(self, link):
        while link.alive:
            message = link.recv()
            if message is None:
                self.drop(link)
                return
            if not message:
                continue
            channel = str(message.get("ch", "user"))
            info = self.clients.get(link, {})
            if channel in ("user", "event", "steer") or (channel == "live" and message.get("reset")):
                self.recorder.log(**message)
            try:
                if channel == "user":
                    self.on_user(message, link)
                elif channel == "live":
                    self.on_live(link, message)
                elif channel == "event":
                    self.on_event(message)
                elif channel == "steer":
                    self.on_steer(message)
                elif channel == "peer":
                    self.on_peer(link, message)
                elif channel == "audio":
                    self.on_audio(message)
                elif channel == "sys":
                    self.on_sys(link, message)
                else:
                    link.send(ch="sys", type="error", text="unknown channel: %s" % channel)
            except Exception as err:  # noqa: BLE001 - the link must survive any turn
                print("[%s] turn error (%s): %s" % (stamp(), channel, err))
                link.send(ch="ai-note", type="error", text="turn failed: %s" % err)

    def drop(self, link):
        info = self.clients.pop(link, {})
        print("[%s] %s unlinked" % (stamp(), info.get("name", "peer")))
        link.close()

    # -- channels ----------------------------------------------------------- #
    def on_user(self, message, link=None):
        text = str(message.get("text", "")).strip()
        partial = bool(message.get("partial"))
        if not text:
            return
        if partial:
            # The pre-reaction: one cheap draft on what has arrived so far, on
            # the background lane so it never delays the real answer. The user's
            # app shows it as "draft" and replaces it with the final.
            self.background_draft(text)
            return
        # Final utterance: a speculative answer may already exist from idle time.
        spec = self.speculative.lookup(text)
        if spec:
            self.broadcast(ch="ai-draft", text=spec, speculative=True)
        # Stay alert during operations: if a turn is already running, this
        # input is caught, alerted, and prepared - never dropped, never
        # blocking the sender.
        if not self.turn_lock.acquire(False):
            self.followups.catch("user", text, source="user input")
            return
        try:
            answer = self.serve_turn(text, rec=bool(self.clients.get(link, {}).get("rec")))
        finally:
            self.turn_lock.release()
        if self.speak and not self.any_live():
            self.speak_text(answer)
        if self.peer_review_enabled:
            threading.Thread(target=self.peer_review, args=(text, self.chat.last_answer), daemon=True).start()
        # Constant link: aux work waits for a quiet gap (cancelled by new
        # input), and nothing joins background threads on the read loop.
        self.schedule_aux()
        self.reset_live_buffers()
        self.present_followups()

    # -- live input and the streaming turn ----------------------------------- #
    def any_live(self):
        with self.lock:
            return any(bool(info.get("live")) for info in self.clients.values())

    def reset_live_buffers(self):
        with self.lock:
            buffers = [info["buffer"] for info in self.clients.values() if info.get("buffer")]
        for buffer in buffers:
            buffer.set("")

    def on_live(self, link, message):
        info = self.clients.get(link)
        if not info:
            return
        buffer = info.get("buffer")
        if buffer is None:
            buffer = LiveBuffer(settle_ms=self.live_settle, fragment_ms=self.fragment_settle)
            info["buffer"] = buffer
        if message.get("reset"):
            buffer.set("")
            return
        chunk = str(message.get("text", ""))
        if chunk:
            snapshot = buffer.feed(chunk, message.get("seq", 0))
            self.warm.touch()
            # input forensics: every keystroke chunk is logged with its sequence
            # number, so a corrupted prompt can be traced to the exact hop that
            # injected it (keyboard, link, or network)
            self.recorder.log(kind="live", seq=message.get("seq", 0), name=info.get("name", "user"),
                              chunk=chunk, buffer=snapshot[-80:])
            # typing indicator: everyone except the sender sees the input
            # forming, live
            self.broadcast(exclude=link, ch="typing", user=info.get("name", "user"), text=snapshot[-80:])
            print("\r[typing %s] %s   " % (info.get("name", ""), snapshot[-60:]), end="", flush=True)

    def start_watchdog(self):
        with self.lock:
            if self.watchdog_started:
                return
            self.watchdog_started = True

        def loop():
            while True:
                time.sleep(0.05)
                try:
                    self.pump_live()
                except Exception as err:  # noqa: BLE001
                    print("[%s] live pump error: %s" % (stamp(), err))

        threading.Thread(target=loop, daemon=True).start()

    def pump_live(self):
        """One pass over live buffers: drafts while typing, answers on quiet."""
        with self.lock:
            links = [(link, info) for link, info in self.clients.items() if info.get("buffer")]
        for link, info in links:
            state, text = info["buffer"].due()
            if state == "draft":
                self.background_draft(text)
            elif state == "final":
                if self.turn_lock.acquire(False):
                    self.recorder.log(kind="turn-settle", prompt=text[:120],
                                      buffer=info["buffer"].text[:120])
                    try:
                        self.serve_turn(text, rec=bool(info.get("rec")))
                        self.schedule_aux()
                    finally:
                        self.turn_lock.release()
                    # the answered text leaves the buffer; anything typed while
                    # the answer streamed stays and settles on its own
                    info["buffer"].consume(text)
                    link.send(ch="sys", type="live-settled")
                    self.present_followups()
                else:
                    # A turn is already running; this snapshot is superseded -
                    # the quiet window restarts, so the LATEST text answers
                    # once, instead of every fragment answering in turn.
                    info["buffer"].requeue()

    def stop(self):
        """Desktop panel: closing the listen socket ends the accept loop."""
        server = getattr(self, "_server", None)
        if server is not None:
            try:
                server.close()
            except Exception:  # noqa: BLE001
                pass

    def serve_turn(self, raw, rec=False, cause=""):
        """One conversational turn. Live clients get the answer streamed by
        character; everyone else gets the classic Chat.ask pipeline. Either way
        the turn is single-flight: the caller holds turn_lock. rec=True (fast
        feed/video mode) skips the reflection and heavy post-passes. cause
        marks event and follow-up turns so the user's app can show why."""
        chat = self.chat
        raw = str(raw).strip()
        if not raw:
            return ""
        self.warm.touch()
        self.cancel_aux()  # new input outranks everything the AI planned
        # collision visibility: if the question landed while a warm/boot ping
        # was in flight, SAY so - this is how a healthy endpoint 'becomes slow'
        if getattr(self.warm, "in_flight", False):
            print("[%s] question arrived while a warm ping was in flight - "
                  "the answer waits for it to finish (ping priority, not answer priority, "
                  "is fixed; this line means an older build is still running)" % stamp())
        started = time.time()
        self.broadcast(ch="status", phase="start", text=raw[:80])
        chat.last_intent = core.classify_intent(raw, chat.last_prompt, chat.last_answer)
        try:
            # live answers skip follow-up expansion: the flow note already
            # makes the model continue instead of restate, and the saved call
            # is what keeps the streamed answer as fast as the console's
            prompt = raw if (chat.last_intent == "new" or self.any_live()) else chat.expand(raw)
        except Exception:  # noqa: BLE001
            prompt = raw
        directive = self.take_continuation()
        if self.any_live():
            answer = self.streamed_turn(prompt, rec=rec, cause=cause, directive=directive, started=started)
        else:
            answer = chat.ask(prompt)
            # the classic path owns its own final broadcast, with timing:
            # ms_first is the last TTFT the health monitor saw, ms_total is
            # input-received to answer-sent
            self.broadcast(
                ch="ai", text=answer or "(nothing came back - check the engine log)", final=True,
                cause=cause, ms_total=int((time.time() - started) * 1000),
                ms_first=self.health.ttft_ms, chars=len(answer or ""),
            )
        if not answer:
            answer = "(nothing came back - check the engine log)"
        with self.health.lock:
            self.health.turns += 1
        if (not rec and answer and not answer.startswith("(") and not chat.fast_mode
                and lan_commentary(answer)):
            # meta-commentary as the answer (the 2B talking ABOUT the question
            # instead of answering): one direct rewrite pass replaces it
            try:
                fixed = chat.client.complete(
                    [
                        {"role": "system", "content": (
                            "Answer the question directly in plain text. No commentary "
                            "about the question, the user, or previous questions - just the answer."
                        )},
                        {"role": "user", "content": str(raw)[:600]},
                    ],
                    max_tokens=core.MAX_TOKENS,
                    sampling={"temperature": 0.4},
                    kind="rewrite",
                    priority="interactive",
                ).strip()
            except Exception:  # noqa: BLE001
                fixed = ""
            if fixed and not core.rambles(fixed) and not lan_commentary(fixed):
                print("[answer was meta-commentary - rewritten as a direct answer]")
                answer = fixed
        if not rec and not chat.fast_mode and (
                not answer or answer.startswith("(")
                or core.rambles(answer) or lan_commentary(answer)):
            # the model's own second prompt: overhead view, its own decision
            self.self_redirect.offer(
                raw, answer or "(empty)",
                "empty" if not answer else
                ("meta-commentary" if lan_commentary(answer) else "rambled"))
        if not rec and answer and not answer.startswith("("):
            # post-answer lanes must NEVER be able to take down a turn: the
            # user already has the answer - a bug here may only cost the
            # improvement, not the reply (a stale partial build once crashed
            # exactly here and looked like "no answer")
            try:
                # notes first (instant, local, every turn - even --fast), then
                # the familiarity score fires the next action by itself
                self.familiarity.fire(raw, answer)
                # the pull already went out; the bounded review chain improves
                # it in the gaps and concludes into the notes
                self.parallel_review.schedule(raw, answer)
                # the parallel pull: the peer AI answers the same question on
                # its own engine while ours streams - the merge reconciles both
                self.ai_loop.pull_answer(raw, answer)
            except Exception as err:  # noqa: BLE001
                print("[%s] post-answer lane skipped (answer was already "
                      "delivered): %s" % (stamp(), str(err)[:120]))
        self.broadcast(ch="status", phase="done", text=answer[:80])
        self.pending_draft = None
        return answer

    def _cache_guard(self):
        """Session evidence: one garbage answer ('A diamond is an opaque
        mineral... cats jumping over bridges') got fuzzily replayed for
        'what is danger', 'what is a gem', even 'hi' - the engine's fuzzy
        cache (score >= 0.86) is too generous with rambly prompts and long
        answers. The bridge keeps EXACT question matches only; fuzzy replay
        is opt-in. The model now answers every differently-worded question
        at ~0.4-1 s anyway, so the cache's job is just exact repeats."""
        if core.setting("lan_fuzzy_cache", False, bool):
            return
        try:
            self.chat.cache.fuzzy = 1.01  # never satisfied: exact hits only
            print("[%s] cache: exact-question hits only (fuzzy replay off - "
                  "see LOG_2, the diamond-cache incident)" % stamp())
        except Exception:  # noqa: BLE001
            pass

    def _context_diet(self):
        """Role separation for the model's memory: the loop's record lanes
        (reviewed / peer / redirect) must NOT feed back into the answering
        context - that made every prefill grow per turn (the original
        slowness, back through a new door) and made the model read its own
        conclusions and the PEER's answers as if they were context it
        should speak from (the 'which script is answering' mix-up). The
        notes stay whole for recall, finalize and the loop - only the
        answering prompt is dieted."""
        chat = self.chat
        if getattr(chat, "_diet_installed", False):
            return
        chat._diet_installed = True
        kinds_off = {"reviewed", "peer", "redirect", "flow"}
        original = chat.context_for

        def dieted(prompt):
            saved = chat.notes.items
            try:
                items = [i for i in saved if i.get("kind") not in kinds_off]
                # live-turn recall diet: 3 hits x 400 chars keeps the tail
                # small, so the endpoint's cache prefix survives and the
                # fitter never has to truncate the instructions
                chat.notes.items = [
                    {**i, "text": str(i.get("text", ""))[:400]} for i in items]
                ctx = original(prompt)
                return ctx[:2400]
            finally:
                chat.notes.items = saved

        chat.context_for = dieted

    def streamed_turn(self, prompt, rec=False, cause="", directive="", started=None):
        """The live path: the same primitives Chat.ask uses (context assembly,
        cache, loop guard, repetition extension, memory), but tokens go over
        the LAN by character and through the expectancy grouper instead of to
        the console. Falls back to Chat.ask on any transport error."""
        chat = self.chat
        try:
            hit = chat.cache.get(prompt, turn=chat.turn_number(), min_gap=core.setting("cache_min_turns", 10, int))
            if hit and not core.rambles(hit[0]):
                self.broadcast(ch="ai", text=hit[0], final=True, cached=True)
                chat.remember(prompt, hit[0])
                return hit[0]
        except Exception:  # noqa: BLE001
            pass
        intent = chat.last_intent
        if chat.fast_mode:
            # one plain call: no memory assembly, no prefetch, no context build
            memory_note, context = "", ""
        else:
            memory_note = chat.memory_instruction(intent, prompt)
            if directive:
                memory_note = (memory_note + "\n\n" + directive).strip()
            memory_note = (memory_note + "\n\n" + HUB_FLOW).strip()
            inject = self.interject.get("preamble")
            if inject and self.interject.get("preamble_on"):
                memory_note = (memory_note + "\n\n" + inject).strip()
            cached = self.prefetch.pop(prompt.strip().lower()[:120], None)
            context = cached if cached is not None else chat.context_for(prompt)
        # live turns prefill faster with a tighter context: on a remote
        # endpoint the server re-reads whatever we send before the first token
        budget = core.setting("lan_live_ctx_budget", 1600, int)
        if budget <= 0:
            budget = core.setting("context_budget", 3000, int)
        # cache-friendly order (the 0.8-2 s prefill fix): the system prompt is
        # STABLE and goes first, so the endpoint's KV cache (cache_prompt)
        # keeps it between turns; the variable parts - instructions and the
        # recall context - ride AFTER the conversation window, right before
        # the user message, so only the small tail re-prefills each turn.
        # Stuffing per-turn recall inside the system message (the old order)
        # invalidated the cache prefix every turn and re-prefilled everything.
        system_content = ((core.LONG_SYSTEM if chat.long_mode else core.SYSTEM)
                          + "\n\n" + HUB_FLOW)
        messages = [{"role": "system", "content": system_content}]
        messages.extend(chat.memory.window(
            0 if intent == "new" else chat.window_tokens,
            drop_last="Earlier answer:" in prompt,
            max_turns=chat.turns_window,
        ))
        tail = memory_note
        if context:
            tail = (tail + "\n\nRelevant notes (use when relevant; ignore otherwise):\n"
                    + context).strip()
        if tail:
            messages.append({"role": "system", "content": tail})
        messages.append({"role": "user", "content": prompt})
        messages = self._fit_live(messages, budget)
        streamer = CharStreamer(self)
        expectancy = Expectancy(self, prompt)
        pieces = []
        marks = {"first": None}
        trimmed = [False]
        ctx_chars = sum(len(str(message.get("content", ""))) for message in messages)
        bounded = not (chat.long_mode or core.wants_list(prompt))
        wall_checked = [0]  # chars already checked for the wall

        def on_token(piece, _result):
            pieces.append(piece)
            if marks["first"] is None:
                marks["first"] = time.time()
                # the model started speaking: one tiny message, once per turn
                self.broadcast(ch="status", phase="typing", text="")
            streamer.push(piece)
            expectancy.feed(piece)
            # mid-stream wall cutter: a 2B model degenerating into a word
            # wall costs ~20 s of decode that post-trimming never refunds -
            # stop the stream the MOMENT the tail turns into a wall and keep
            # the clean prefix (checked every ~80 chars, so it stays cheap)
            total = len("".join(pieces))
            if bounded and total >= 240 and total - wall_checked[0] >= 80:
                wall_checked[0] = total
                if salad("".join(pieces)[-600:]) or core.rambles("".join(pieces)[-600:]):
                    raise core.DegenerateOutput("mid-stream wall")

        guard = core.LoopGuard()
        if started is None:
            started = time.time()
        stall_announced = [False]

        def stall_watchdog():
            if marks["first"] is None and not stall_announced[0]:
                stall_announced[0] = True
                age = int((time.time() - started) * 1000)
                print("[%s] turn is %d ms old with no first token - waiting on "
                      "the endpoint, not on the LAN or the typing path"
                      % (stamp(), age))

        threading.Timer(8.0, stall_watchdog).start()
        try:
            result = chat.client.ask(
                messages,
                on_token=on_token,
                guard=guard,
                max_tokens=core.setting("long_max_tokens", 1200, int) if chat.long_mode else core.MAX_TOKENS,
                kind="lan-live",
            )
            answer = result["text"].strip()
        except core.DegenerateOutput:
            answer = "".join(pieces).strip()
            trimmed[0] = True
            print("[%s] wall cut mid-stream at %d chars - kept the clean prefix, "
                  "stopped decoding the junk" % (stamp(), len(answer)))
        except Exception as err:  # noqa: BLE001 - quality path before speed
            print("[%s] live stream failed (%s); full pipeline takes over" % (stamp(), err))
            return chat.ask(prompt)
        if not answer:
            return chat.ask(prompt)
        streamer.flush()
        expectancy.end()
        if rec:
            # feed/video mode: the answer as streamed IS the answer; no
            # reflection, no repetition extension, no note extraction - speed
            chat.remember(prompt, answer)
            if not chat.fast_mode:
                chat.background(chat.maybe_summarize)
            self.broadcast(ch="ai", text=answer, final=True, streamed=True, rec=True, cause=cause,
                           ms_first=self.ms_first(marks, started), ms_total=int((time.time() - started) * 1000), chars=len(answer))
            print("[%s] answered %d chars" % (stamp(), len(answer)))
            return answer
        # The same post-passes Chat.ask runs, so streamed answers are held to
        # the same quality bar as console answers - unless --fast said otherwise.
        if not chat.fast_mode:
            # the salad wall must be caught BEFORE the repetition extender
            # sees it - extending a degenerate comma-chain is how answers
            # grew to 2700+ chars of word salad in the field. (The mid-stream
            # cutter already trimmed walls; this is the fallback for walls
            # that only complete past the last check.)
            if bounded and (salad(answer) or core.rambles(answer)):
                before = len(answer)
                answer = core.tidy_answer(answer, core.setting("tidy_chars", 900, int))
                trimmed[0] = True
                print("[answer was a repetition wall - trimmed %d -> %d chars before extension]" % (before, len(answer)))
            else:
                answer = chat.extend_if_repetitive(prompt, answer, context, intent)
                # the rambling wall the console trims: a 2B model's run-on output
                # must be bounded here too, or the LAN path ships it whole
                problem = None if (bounded and not core.has_code_block(answer)) else core.rambles(answer)
                if problem:
                    before = len(answer)
                    answer = core.tidy_answer(answer, core.setting("tidy_chars", 900, int))
                    print("[answer was %s - trimmed %d -> %d chars]" % (problem, before, len(answer)))
        chat.remember(prompt, answer)
        chat.track_goal(prompt, answer)
        if chat.autonote and not chat.fast_mode and self.health.aux_allowed():
            chat.background(chat.auto_note, prompt, answer, quiet=True)
        if not chat.fast_mode:
            chat.background(chat.maybe_summarize)
        self.broadcast(ch="ai", text=answer, final=True, streamed=True, cause=cause,
                       ms_first=self.ms_first(marks, started), ms_total=int((time.time() - started) * 1000), chars=len(answer))
        print("[%s] answered %d chars · first %s ms · total %d ms · ctx ~%d tok · ~%s tok/s%s" % (
            stamp(), len(answer),
            self.ms_first(marks, started) if self.ms_first(marks, started) is not None else "?",
            int((time.time() - started) * 1000),
            ctx_chars // 4,
            self._tps(marks, started, len(answer)),
            " · trimmed" if trimmed[0] else "",
        ))
        return answer

    @staticmethod
    def _fit_live(messages, budget_tokens):
        """The bridge's own fitter. core.fit_messages protects only the first
        and last messages - with the two-system layout it would DELETE the
        tail system (instructions + notes) wholesale and then truncate the
        stable system prompt from its end, cutting the flow instructions
        mid-sentence. That was the 'losing focus' gibberish. Here: the head
        system and the user question are untouchable, window turns shed
        oldest-first, and overflow truncates the NOTES TAIL only - the
        instructions sit at the tail's front, so notes give way first."""
        budget = max(400, int(budget_tokens))
        trimmed = list(messages)

        def size():
            return sum(core.message_tokens(m) for m in trimmed)

        # [head system, ...window..., tail system, user]: shed window turns
        while len(trimmed) > 3 and size() > budget:
            del trimmed[1]
        # still over: truncate the tail (notes) from its end - never the head
        if size() > budget and len(trimmed) > 2:
            over = size() - budget
            tail = dict(trimmed[-2])
            content = str(tail.get("content", ""))
            keep = max(0, len(content) - over * 4)
            tail["content"] = content[:keep]
            trimmed[-2] = tail
        return trimmed

    @staticmethod
    def _tps(marks, started, chars):
        """Decode throughput of the answer: tokens per second the endpoint
        actually produced once it started speaking. Low = the endpoint's
        hardware is the wall; high with a big 'first' = prefill/network is."""
        if not marks["first"]:
            return "?"
        decode_s = time.time() - marks["first"]
        if decode_s <= 0.05:
            return "?"
        return int((chars / 4.0) / decode_s)

    @staticmethod
    def ms_first(marks, started):
        """Input-received to first token, in ms (was computed against the wrong
        clock and went negative)."""
        return int((marks["first"] - started) * 1000) if marks["first"] else None

    def background_draft(self, partial):
        text = str(partial)
        # a draft is a full model call on a serial endpoint: it must never run
        # while a turn is streaming (the answer owns the pipe), and a 1-2 word
        # fragment is not worth a round trip
        if (features is None or self.drafting or self.chat.fast_mode
                or not self.health.aux_allowed() or self.turn_lock.locked()
                or not (LiveBuffer.looks_complete(text) or len(text.split()) >= 3)):
            return
            return
        text = str(partial)
        hub = self

        def work():
            try:
                # pre-tool: assemble the context for the partial text now, so
                # the real turn starts with its thinking already done
                try:
                    hub.prefetch[text.strip().lower()[:120]] = hub.chat.context_for(text)
                    for stale in list(hub.prefetch)[:-3]:
                        hub.prefetch.pop(stale, None)
                except Exception:  # noqa: BLE001
                    pass
                draft = features.try_draft(hub.chat.client, text, max_tokens=60)
                if draft and draft != hub.pending_draft:
                    hub.pending_draft = draft
                    hub.broadcast(ch="ai-draft", text=draft, partial=True)
            finally:
                # single flight, spaced by its own duration: a draft storm is
                # what made the live path queue behind itself and feel slow
                hub.drafting = False

        hub.drafting = True
        hub.chat.background(work)

    def on_event(self, message):
        text = str(message.get("text", "")).strip()
        if not text:
            return
        self.warm.touch()
        if str(message.get("type", "")) == "note":
            # ':note text' from the user: straight into the notes store, no
            # turn, no gate - note-taking never has to wait for an answer.
            self.chat.notes.add("note", text[:40], text)
            self.broadcast(ch="ai-note", type="note", text="noted: %s" % text[:80])
            return
        # Everything an agent says is on the recorder feed immediately...
        self.broadcast(ch="ai-note", type="event", text=text)
        print("[%s] event: %s" % (stamp(), text[:100]))
        # ...but it interrupts the conversation only if the gate says so.
        inject = self.gate.offer(message)
        if inject:
            self.chat.notes.add("event", inject[:40], inject)
            if not self.turn_lock.acquire(False):
                self.followups.catch("event", inject, source="agent")
                return
            try:
                answer = self.serve_turn(inject, cause="event")
            finally:
                self.turn_lock.release()
            if answer:
                if self.speak and not self.any_live():
                    self.speak_text(answer)
                self.schedule_aux()
                self.present_followups(cause="the event turn")

    def on_steer(self, message):
        text = str(message.get("text", "")).strip()
        if not text:
            return
        # Steering ("zcizo") is not speech; it goes into the notes store, which
        # context_for() retrieves, so it shapes the next turns quietly.
        self.chat.notes.add("steer", text[:40], text)
        self.broadcast(ch="ai-note", type="steer", text="steering noted: %s" % text[:80])
        print("[%s] steer: %s" % (stamp(), text[:80]))

    def peer_review(self, question, answer):
        peer = self.first_peer()
        if peer is None:
            return
        peer.send(ch="peer", type="review", question=question, answer=answer[:3000])

    def on_peer(self, link, message):
        kind = str(message.get("type", ""))
        if kind in ("ping", "pong", "mark", "deliver", "ai-handshake",
                    "ai-handshake-reply", "receipt") and getattr(self, "ai_loop", None):
            self.ai_loop.on_signal(message)
            return
        if kind == "review-result":
            verdict = str(message.get("text", "")).strip()
            if not verdict:
                return
            self.broadcast(ch="ai-note", type="peer-review", text=verdict)
            print("[%s] peer: %s" % (stamp(), verdict[:100]))
            low = verdict.lower()
            if any(word in low for word in ("error", "wrong", "incorrect", "unsupported")):
                # The second model caught something: one refine pass, then the
                # corrected answer supersedes the first on the user's app.
                corrected = self.chat.refine(self.chat.last_prompt, self.chat.last_answer, "", 1)
                if corrected and corrected.strip() != self.chat.last_answer.strip():
                    self.chat.last_answer = corrected
                    self.broadcast(ch="ai", text=corrected, final=True, revised=True)
                    if self.speak:
                        self.speak_text(corrected)
        elif kind == "hello":
            link.send(ch="peer", type="hello", text="peer registered")

    def on_audio(self, message):
        """Raw audio attachment: keep it, use the transcript if the sender made one."""
        data = message.get("b64")
        saved = ""
        if data:
            folder = Path(core.STATE) / "lan_audio"
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / ("call_%d.bin" % now_ms())
            try:
                path.write_bytes(base64.b64decode(data))
                saved = str(path)
            except Exception as err:  # noqa: BLE001
                self.broadcast(ch="ai-note", type="error", text="audio save failed: %s" % err)
        transcript = str(message.get("transcript", "")).strip()
        if transcript:
            self.on_user({"text": transcript})
        else:
            self.broadcast(
                ch="ai-note", type="audio",
                text="audio received (%s); this endpoint takes text, send transcript= too" % (saved or "unsaved"),
            )

    def _add_flow_note(self):
        """The standing 'continuation is the answer' style, kept once in the
        notes store so the classic Chat.ask path retrieves it too."""
        if self._flow_note_added:
            return
        self._flow_note_added = True
        try:
            if not any(item.get("kind") == "flow" for item in self.chat.notes.items):
                self.chat.notes.add("flow", "answer style", HUB_FLOW)
        except Exception:  # noqa: BLE001
            pass

    def set_background_live(self, value):
        self.bg_live = bool(value)
        self.apply_lanes()

    def set_continuation(self, text):
        """A directive for the next turn: keep the topic moving, address what
        was held, treat the correction as standing. Set by corrections and
        held urgent input; consumed once, then saved to the notes store."""
        self.continuation = str(text or "")
        if self.continuation:
            self.broadcast(ch="ai-note", type="continuation", text=self.continuation)

    def take_continuation(self):
        text, self.continuation = self.continuation, ""
        if text:
            try:
                self.chat.notes.add("continuation", text[:40], text)
            except Exception:  # noqa: BLE001
                pass
        return text

    def flush_background(self, timeout=4.0):
        """chat.flush_background, minus the crash: it cannot join the calling
        thread, which is exactly what happens when the self agent (itself a
        background thread) finishes its own turn."""
        threads = list(getattr(self.chat, "_background_threads", []) or [])
        current = threading.current_thread()
        pending = [thread for thread in threads if thread is not current]
        if not pending:
            return
        per = max(0.0, float(timeout) / len(pending))
        for thread in pending:
            try:
                thread.join(per)
            except RuntimeError:
                pass

    def schedule_aux(self, delay=3.0):
        """Prediction, self-review and friends start only after a quiet gap,
        and the timer is cancelled the moment new input arrives - so they can
        never sit between the user's next question and its answer. Skipped
        entirely in --fast mode: raw speed means the GPU does nothing but
        answer."""
        old = getattr(self, "aux_timer", None)
        if old is not None:
            old.cancel()
        if self.chat.fast_mode:
            return
        hub = self

        def work():
            hub.aux_timer = None
            if hub.turn_lock.acquire(False):
                hub.turn_lock.release()
                hub.speculative.schedule()
                hub.self_agent.maybe_schedule()

        self.aux_timer = threading.Timer(delay, work)
        self.aux_timer.daemon = True
        self.aux_timer.start()

    def schedule_quiet(self, name, fn, delay=2.0):
        """Named quiet-gap work: starts only after a delay with no new input,
        and is cancelled the moment input arrives - model-side notes, reviews
        and consolidation enrich the conversation, they never sit in the pipe
        between the user's next question and its answer."""
        attr = "_quiet_%s" % name
        old = getattr(self, attr, None)
        if old is not None:
            old.cancel()

        def run():
            setattr(self, attr, None)
            if self.turn_lock.acquire(False):
                self.turn_lock.release()
                fn()

        timer = threading.Timer(delay, run)
        timer.daemon = True
        timer.start()
        setattr(self, attr, timer)

    def cancel_aux(self):
        old = getattr(self, "aux_timer", None)
        if old is not None:
            old.cancel()
            self.aux_timer = None
        for name in ("familiarity", "reflector", "redirect", "review"):
            timer = getattr(self, "_quiet_%s" % name, None)
            if timer is not None:
                timer.cancel()
                setattr(self, "_quiet_%s" % name, None)

    def present_followups(self, cause="the answer"):
        inject = self.followups.prepare_and_present(cause=cause)
        if inject:
            threading.Thread(target=self.serve_deferred, args=(inject,), daemon=True).start()

    def serve_deferred(self, text, cause="follow-up"):
        """A held urgent item (or the agent's own decision) stepping into the
        conversation once the model is free - as its own turn. The internal
        continue is wrapped: whatever is pending (new input, goals, prepared
        material) rides along as one instruction."""
        wrap = self.continue_wrap.directive()
        if wrap and wrap[:40].lower() not in text.lower():
            text = "%s\n[%s]" % (text, wrap)
        if not self.turn_lock.acquire(False):
            self.followups.catch("follow-up", text, source="queue")
            return
        try:
            self.warm.touch()
            self.serve_turn(text, cause=cause)
            self.schedule_aux()
        finally:
            self.turn_lock.release()
        self.present_followups(cause="the follow-up")

    def apply_lanes(self):
        """Reconfigure the Lanes the engine already uses. Guarded (default) is
        the measured behavior: background only in idle gaps. Live lets the
        background lane run while you chat and think - notes, reflection,
        prefetch and speculative pre-answers keep flowing mid-turn - with a
        slot count and grace period that keep responses and intake first."""
        lanes = self.chat.client.lanes
        if self.bg_live:
            lanes.max_background = max(1, int(core.setting("lan_background_slots", 1, int)))
            lanes.grace = max(0.0, int(core.setting("lan_background_grace_ms", 150, int))) / 1000.0
            label = "live (slots %d, grace %.2fs) - responses and intake stay first" % (lanes.max_background, lanes.grace)
        else:
            lanes.max_background = 2
            lanes.grace = 0.4
            label = "guarded (slots 2, grace 0.40s) - background only in idle gaps"
        self.broadcast(ch="ai-note", type="bg", text="background lane: %s" % label)
        print("[%s] background lane: %s" % (stamp(), label))

    def on_sys(self, link, message):
        kind = str(message.get("type", ""))
        if kind == "ping":
            link.send(ch="sys", type="pong")
        elif kind == "rec":
            info = self.clients.get(link)
            if info:
                on_off = str(message.get("value", "")).lower() in ("on", "1", "true")
                info["rec"] = on_off
                info["buffer"] = LiveBuffer(
                    settle_ms=self.rec_settle if on_off else self.live_settle,
                    fragment_ms=self.rec_settle if on_off else self.fragment_settle,
                    draft_ms=100 if on_off else 400,
                )
                link.send(ch="sys", type="note",
                          text="rec mode %s" % ("on - fast settle, no post-passes" if on_off else "off"))
        elif kind == "bg":
            self.set_background_live(str(message.get("value", "")).lower() in ("on", "1", "true"))
            link.send(ch="sys", type="note", text="background lane reconfigured")
        elif kind == "state":
            link.send(
                ch="sys", type="state",
                model=str(core.MODEL), turns=self.chat.turn_number(),
                lanes=self.chat.client.lanes.state(),
                clients=str(len(self.clients)),
            )

    def speak_text(self, text):
        """Windows SAPI through PowerShell: no packages, works on any Win10/11 box."""
        snippet = str(text).replace("'", "''")[:600]

        def work():
            try:
                import subprocess
                subprocess.run(
                    ["powershell", "-NoProfile", "-Command",
                     "Add-Type -AssemblyName System.Speech;"
                     "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
                     "$s.Speak('%s')" % snippet],
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except Exception as err:  # noqa: BLE001
                print("[%s] tts failed: %s" % (stamp(), err))

        threading.Thread(target=work, daemon=True).start()


# --------------------------------------------------------------------------- #
# the user side / peer side
# --------------------------------------------------------------------------- #
class LinkClient:
    def __init__(self, host, port, role="user", name="", speak=False, live=True):
        self.host = host
        self.port = port
        self.role = role
        self.name = name or socket.gethostname()
        self.speak = speak
        self.live = live
        self.streamed = False
        self.link = None
        self.msg_id = 0
        # console format state: AI output must never destroy a half-typed line
        self.line_lock = threading.Lock()
        self.current_line = ""
        self.saved_partial = None
        self.pending_notes = []
        self.speak_lock = threading.Lock()
        self.speak_generation = 0

    def connect(self):
        sock = socket.create_connection((self.host, self.port), timeout=10)
        sock.settimeout(None)
        self.link = SocketLink(sock)
        self.link.send(ch="sys", type="hello", role=self.role, name=self.name, live=self.live,
                       version=VERSION)
        reply = self.link.recv()
        if reply and reply.get("type") == "welcome":
            print("[%s] linked to %s:%d (%s) - home build %s" % (stamp(), self.host, self.port,
                                                                 reply.get("engine", ""),
                                                                 reply.get("version", "?")))
            if str(reply.get("version", "?")) != VERSION:
                print("[%s] *** VERSION MISMATCH: home %s but this link %s - the home machine "
                      "is running a stale copy; restart it with the current fast_chat_lan.py ***"
                      % (stamp(), reply.get("version"), VERSION))
        else:
            print("[%s] no welcome from home; continuing anyway" % stamp())
        threading.Thread(target=self.read_loop, daemon=True).start()

    def send(self, **fields):
        self.msg_id += 1
        fields.setdefault("id", self.msg_id)
        return self.link.send(**fields)

    # -- inbound ------------------------------------------------------------ #
    def begin_ai(self):
        """AI output never overwrites a half-typed user line: the partial
        draft is left on its own line, remembered, and restored after the AI
        finishes. Returns the partial text (or None)."""
        with self.line_lock:
            partial = self.current_line
        if not partial:
            return None
        print()  # end the user's line; AI output starts clean below it
        self.saved_partial = partial
        return partial

    def restore_input(self):
        partial, self.saved_partial = self.saved_partial, None
        if partial:
            print("\n[you] %s" % partial, end="", flush=True)

    def read_loop(self):
        while self.link.alive:
            message = self.link.recv()
            if message is None:
                print("[%s] link down" % stamp())
                return
            if not message:
                continue
            channel = str(message.get("ch", ""))
            if channel == "ai-draft":
                self.begin_ai()
                tag = "speculative" if message.get("speculative") else "draft"
                print("  [%s %s] %s" % (tag, stamp(), str(message.get("text", ""))[:120]))
                self.restore_input()
            elif channel == "typing":
                # another linked user is typing: show the input forming
                self.begin_ai()
                print("  [typing %s] %s" % (message.get("user", ""), str(message.get("text", ""))[-60:]))
                self.restore_input()
            elif channel == "status":
                if message.get("phase") == "start":
                    self.begin_ai()
                    print("[AI thinking...]")
                    self.start_timer("thinking")
                elif message.get("phase") == "typing":
                    self.start_timer("typing")
                elif message.get("phase") == "done":
                    pass  # the answer itself follows immediately
            elif channel == "ai-live":
                # no redraw: characters append as they arrive; the answer is
                # printed ONCE here, never duplicated by the final line
                if not self.streamed:
                    self.stop_timer()  # the model is speaking; chars show pace
                self.streamed = True
                print(str(message.get("text", "")), end="", flush=True)
            elif channel == "ai-group":
                verdict = "speak" if message.get("speak") else "hold"
                text = str(message.get("text", ""))
                if self.speak and message.get("speak"):
                    self.speak_text(text)
                # sections shown inline - no newlines mid-answer, the text
                # keeps flowing as one readable block
                print(" [%s·§%s]" % (verdict[0], message.get("group_no", 0)), end="", flush=True)
            elif channel == "ai":
                self.stop_timer()
                if self.streamed:
                    self.streamed = False
                    print()
                tag = "revised" if message.get("revised") else "AI"
                timing = ""
                if message.get("ms_total") is not None:
                    # the home may send raw floats (658.0929000005126); round to
                    # whole milliseconds so the link console reads like the home's
                    timing = " · first %s ms · total %s ms" % (
                        ("%d" % round(message["ms_first"]))
                        if isinstance(message.get("ms_first"), (int, float)) else "?",
                        ("%d" % round(message["ms_total"]))
                        if isinstance(message.get("ms_total"), (int, float)) else "?",
                    )
                    if message.get("chars"):
                        timing += " · %s chars" % message.get("chars")
                if message.get("streamed") and not message.get("revised"):
                    # the answer already streamed above in full - print only
                    # the timing summary, never the text twice
                    print("[%s %s%s]" % (stamp(), tag, timing))
                else:
                    print("[%s %s%s] %s" % (stamp(), tag, timing, message.get("text", "")))
                    if self.speak and not message.get("streamed"):
                        self.speak_text(str(message.get("text", "")))
                for note in self.pending_notes:
                    print("  [ai-note %s] %s" % (note[0], note[1]))
                self.pending_notes = []
                self.restore_input()
            elif channel == "ai-note":
                line = (message.get("type", ""), str(message.get("text", ""))[:160])
                if self.streamed:
                    self.pending_notes.append(line)  # shown after the answer
                else:
                    self.begin_ai()
                    print("  [ai-note %s] %s" % line)
                    self.restore_input()
            elif channel == "peer":
                self.on_peer(message)
            elif channel == "sys" and message.get("type") == "error":
                print("  [home] %s" % message.get("text", ""))

    def on_peer(self, message):
        """Peer role: home sends a review request; we answer with the fast model."""
        kind = str(message.get("type", ""))
        if kind != "review":
            return
        question = str(message.get("question", ""))
        answer = str(message.get("answer", ""))
        text = ""
        if features is not None:
            text = features.try_draft(
                self.home_client(),
                "Review this answer. Reply with 'ok' or list errors, repetition, anything unsupported. Be brief.\nQ: %s\nA: %s"
                % (question, answer),
                max_tokens=120,
            )
        if not text:
            text = "ok"
        self.send(ch="peer", type="review-result", text=text)

    @staticmethod
    def home_client():
        """A peer runs its own small engine so it is a second opinion, not a proxy."""
        if getattr(LinkClient, "_engine", None) is not None:
            return LinkClient._engine
        client = core.Client()
        LinkClient._engine = client
        return client

    _engine = None

    def speak_text(self, text):
        """Windows SAPI through PowerShell. Serialized for real: the voice
        lock is held for the whole utterance, so answers speak one at a time,
        and a newer answer's speech supersedes (drops) the older one instead
        of the two voices overlapping - the field bug with multiple
        simultaneous responses in voice."""
        snippet = str(text).replace("'", "''")[:600]
        self.speak_generation += 1
        my_gen = self.speak_generation

        def work():
            with self.speak_lock:
                if my_gen != self.speak_generation:
                    return  # superseded: a newer answer took the voice
                try:
                    import subprocess
                    subprocess.run(
                        ["powershell", "-NoProfile", "-Command",
                         "Add-Type -AssemblyName System.Speech;"
                         "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
                         "$s.Speak('%s')" % snippet],
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                except Exception as err:  # noqa: BLE001
                    print("  tts failed: %s" % err)

        threading.Thread(target=work, daemon=True).start()

    # -- outbound: the typing loop ------------------------------------------ #
    def interact(self):
        if self.role == "peer":
            print("Peer link up. Reviews arrive automatically; Ctrl+C to leave.")
            while True:
                time.sleep(3600)
        if self.live:
            return self.live_typing()
        print("Type and press Enter to send. ':p your text' sends an interim (partial) message")
        print("so the AI can pre-react. ':note <text>' keeps a note without a turn.")
        print("':rec on|off' fast feed mode. ':bg on|off' live background lane.")
        print("':event', ':steer', ':audio <file>' also work. Ctrl+C exits.")
        while True:
            try:
                line = input("> ").strip()
            except (KeyboardInterrupt, EOFError):
                print("bye")
                return
            if not line:
                continue
            if line.startswith(":p "):
                self.send(ch="user", text=line[3:], partial=True)
            elif line.startswith(":note "):
                self.send(ch="event", type="note", text=line[6:])
            elif line.startswith(":rec"):
                self.send(ch="sys", type="rec", value=line[4:].strip() or "on")
            elif line.startswith(":bg"):
                self.send(ch="sys", type="bg", value=line[3:].strip() or "on")
            elif line.startswith(":event "):
                self.send(ch="event", text=line[7:])
            elif line.startswith(":steer "):
                self.send(ch="steer", text=line[7:])
            elif line.startswith(":audio "):
                self.send_audio(line[7:])
            elif line.startswith(":state"):
                self.send(ch="sys", type="state")
            else:
                self.send(ch="user", text=line)

    def start_timer(self, label):
        """Client-side elapsed clock: zero wire traffic, zero engine load."""
        old = getattr(self, "timer_stop", None)
        if old is not None:
            old.set()
        stop = threading.Event()
        self.timer_stop = stop
        timer_t0 = time.time()

        def run():
            while not stop.is_set():
                with self.line_lock:
                    typing_now = bool(self.current_line)
                if not typing_now:
                    # the elapsed clock must never overwrite a half-typed line
                    print("\r  [AI %s... %0.1fs]  " % (label, time.time() - timer_t0), end="", flush=True)
                time.sleep(0.1)

        threading.Thread(target=run, daemon=True).start()

    def stop_timer(self):
        old = getattr(self, "timer_stop", None)
        if old is not None:
            old.set()
            self.timer_stop = None

    def live_typing(self):
        """Character-by-character input (Windows console): every key goes out on
        the live channel as it is typed, so the AI drafts while the sentence is
        still forming and answers by itself when the typing pauses."""
        import msvcrt
        print("live typing: characters stream as you type and the AI answers")
        print("about 0.2 s after you stop. No Enter needed; Esc clears; Ctrl+C exits.")
        seq = 0
        line = ""
        with self.line_lock:
            self.current_line = ""
        print("[you] ", end="", flush=True)
        while True:
            try:
                char = msvcrt.getwch()
            except (KeyboardInterrupt, EOFError):
                print("bye")
                return
            if char in ("\r", "\n"):
                # Enter = fast send: the line goes out NOW as its own turn (the
                # home answers it immediately, no settle wait). The live buffer
                # resets first so the same text cannot settle again behind it.
                text = line.strip()
                line = ""
                with self.line_lock:
                    self.current_line = ""
                if text:
                    seq += 1
                    self.send(ch="live", reset=True, seq=seq)
                    self.send(ch="user", text=text, user=self.name)
                print("\n[you] ", end="", flush=True)
            elif char == "\x1b":
                if line:
                    print("\r" + " " * len(line) + "\r\r[you] ", end="", flush=True)
                line = ""
                with self.line_lock:
                    self.current_line = ""
                seq += 1
                self.send(ch="live", reset=True, seq=seq)
            elif char in ("\x08", "\x7f"):
                if line:
                    line = line[:-1]
                    with self.line_lock:
                        self.current_line = line
                    print("\b \b", end="", flush=True)
            elif char in ("\x00", "\xe0"):
                msvcrt.getwch()  # arrow/function keys: consume the second byte
            elif char >= " ":
                line += char
                with self.line_lock:
                    self.current_line = line
                seq += 1
                self.send(ch="live", text=char, seq=seq)
                print(char, end="", flush=True)  # local echo: you see what you type

    def send_audio(self, path):
        target = Path(path)
        if not target.is_file():
            print("  no such file: %s" % target)
            return
        payload = base64.b64encode(target.read_bytes()).decode("ascii")
        self.send(ch="audio", b64=payload, name=target.name)
        print("  sent %s (%d KB)" % (target.name, target.stat().st_size // 1024))


# --------------------------------------------------------------------------- #
# entry
# --------------------------------------------------------------------------- #
def main():
    parser = argparse.ArgumentParser(description="LAN bridge for fast_chat")
    parser.add_argument("mode", choices=["serve", "link"])
    parser.add_argument("--host", default="", help="link mode: home machine's LAN IP")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--role", choices=["user", "peer"], default="user")
    parser.add_argument("--name", default="")
    parser.add_argument("--speak", action="store_true", help="say answers out loud (Windows SAPI)")
    parser.add_argument("--live", action="store_true", help="link: live mode (already the default; accepted so older commands still work)")
    parser.add_argument("--no-live", action="store_true", help="link: plain line mode (live streaming, drafts and 0.2 s auto-reply are the default)")
    parser.add_argument("--no-peer-review", action="store_true", help="serve: peer review activates automatically when a peer links; this disables it")
    parser.add_argument("--fast", action="store_true", help="serve: one plain call per turn - no memory assembly, no extension passes (fastest, no recall)")
    parser.add_argument("--no-fast", action="store_true", help="serve: force the full pipeline even if fast_mode is set in fast_chat_ext.py")
    parser.add_argument("--audio-port", type=int, default=None, metavar="PORT", help="serve: UDP audio port (default: TCP port + 1; 0 disables)")
    parser.add_argument("--loop", default="", metavar="HOST:PORT", help="serve: open the AI loop to a peer instance (the racetrack)")
    args = parser.parse_args()

    if args.mode == "serve":
        if not hasattr(core, "Chat"):
            print("fast_chat.py did not import its engine; check the folder")
            raise SystemExit(1)
        audio_port = args.port + 1 if args.audio_port is None else args.audio_port
        fast = True if args.fast else (False if args.no_fast else None)
        hub = Hub(speak=args.speak, peer_review=not args.no_peer_review, port=args.port, fast=fast)
        if args.loop and ":" in args.loop:
            host, _, lport = args.loop.rpartition(":")
            threading.Timer(3.0, hub.ai_loop.connect, args=(host, lport)).start()
        hub.serve_forever(audio_port=audio_port)
        return

    if not args.host:
        print("link mode needs --host <home LAN IP>")
        raise SystemExit(1)
    client = LinkClient(args.host, args.port, role=args.role, name=args.name, speak=args.speak, live=not args.no_live)
    client.connect()
    client.interact()


if __name__ == "__main__":
    main()
