#!/usr/bin/env python3
"""fast_chat_desk.py - the desktop control panel for the fast_chat system.

One window, every option, each with an explanation of what it actually does
and what it costs:

  START      role (home server / link), host, port, input box, live log
  ENGINE     endpoint, models, reply budget, CPU/GPU routing, routing mode
  FEATURES   every feature with a toggle + explanation, and usage dials for
             how often each one runs
  INTERJECT  prompt-injection points at three stages of the pipeline - to see
             whether the model actually INCORPORATES the instruction while it
             thinks and processes updated responses (there is a marker test:
             inject "mention ZEPHYR" and check the answer)
  BENCH      cross-reference speed: the same questions run with each feature
             on and off; see which features fall off (cost speed) and which
             can be added for free; then ask the AI for the verdict
  FILES      upload text / picture / video: text joins notes + context;
             pictures are described by a direct vision call to the same
             endpoint; video is stored and noted (frame decoding needs extra
             libraries, so it is archived, not analysed)

Stdlib only (tkinter + the engine's own requests). fast_chat.py untouched;
this panel drives fast_chat_lan.py's Hub (home role) and LinkClient (link).

Run:  python fast_chat_desk.py
"""
import base64
import json
import queue
import sys
import threading
import time
import traceback
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import fast_chat as core
import fast_chat_lan as lan
import fast_chat_ext as ext

HERE = Path(__file__).parent
STATE = HERE / "state"
FILES_DIR = STATE / "files"
SETTINGS_PATH = STATE / "desk_settings.json"


def stamp():
    return time.strftime("%H:%M:%S")


# --------------------------------------------------------------------------- #
# explanations: what each option does and what it costs
# --------------------------------------------------------------------------- #
EXPLAIN = {
    "role": "HOME runs the engine and listens on this PC. LINK connects to a home running on another PC and streams your typing there live.",
    "host": "Home only needs a port. Link needs the home machine's IP (e.g. 192.168.1.112).",
    "port": "TCP port for the chat link; the UDP audio port is this +1. Home listens here, link connects here.",
    "url": "Where model calls go. A local Ollama (http://127.0.0.1:11434/ollama/api/chat) is always the fastest option; a remote endpoint adds network time to every single call.",
    "model": "The main brain. Heavier = better answers but slower first token. This one choice drives most of the speed.",
    "fast_model": "Used for aux work (drafts, checks). Same model is fine; a smaller one saves memory only if you have one.",
    "code_model": "Model used when the question looks like code.",
    "max_tokens": "Reply budget. Bigger = longer possible answers but more decode time and more rambling risk on small models. 400 is tuned for 2B.",
    "timeout": "Safety ceiling per call, not a speed knob - it only stops a dead call from hanging forever.",
    "gpu": "CPU vs GPU for inference. Auto = runtime decides. Force CPU frees the graphics card but is slower. Force GPU needs the model to fit in VRAM. Applied as num_gpu in every request payload.",
    "num_thread": "CPU threads for inference when on CPU. Roughly your physical core count. Applied as num_thread in every request payload.",
    "routing": "DIRECT PIPELINE: the classic full pipeline (expansion, memory, quality passes). STREAMED LIVE: characters stream to the link as generated - the answer starts faster, quality passes still apply. FAST SINGLE-CALL: one plain call, nothing else - fastest, fewest features.",
    "fast_mode": "Master speed switch: the model does nothing but answer. Notes are still captured (local and free); every model-backed extra is off.",
    "live": "Live typing: characters stream as you type and the answer starts about 0.2 s after you stop. Off = type, then press Enter.",
    "speak": "Read answers aloud with Windows built-in speech (SAPI). Zero network cost; purely output.",
    "audio_method": "NONE: silent. SPEAK: Windows SAPI voice on this machine. UDP: raw audio stream on port+1 for remote relays. BOTH: speak here and stream.",
    "warm": "Keeps the model loaded with tiny pings so it never unloads between questions. Costs one tiny call every N seconds when idle. Skip on metered/remote endpoints.",
    "health": "Uptime/health report every N seconds: turns, first-token times, error causes. Local only, no model call.",
    "speculative": "After each answer, the model predicts your likely next question and pre-drafts it in idle time - a possible 0 ms reply.",
    "reflector": "Re-reads its own answer against history/notes and corrects mistakes mid-flight (a correction replaces the answer, never a silence). Costs 1-3 background calls per turn.",
    "expectancy": "While streaming, groups the answer into speakable chunks and runs a cheap check whether to speak or hold. Costs about one tiny call per 3 groups.",
    "selfagent": "The AI decides itself to SPEAK, PREPARE or stay OK between turns. Costs a call every N seconds when quiet.",
    "autonote": "Extracts durable facts from each Q/A into the notes store. Costs 1 background call per turn.",
    "familiarity": "Notes every turn instantly (local, free), scores how familiar the topic is, and fires review / continuation / consolidation. Scoring is local and free; the fired work is model-backed and waits for a quiet gap.",
    "drafts": "While you type, drafts a pre-answer on what exists so far (shown as 'draft'). Costs background calls per pause; gated to real questions, never during a turn.",
    "followups": "Input that arrives mid-answer is caught, shown, and prepared for right after - never dropped.",
    "continuewrap": "Before anything continues by itself, pending goals/inputs/prepared items are folded into one instruction.",
    "peer_review": "A second-opinion pass by a linked peer machine. Needs a peer connected.",
    "rec": "Recording/feed mode: answers stream with no post passes at all - maximum speed, minimum quality work.",
    "settle_ms": "How long after your LAST keystroke the answer fires when the text looks complete (long or punctuated). 200 ms is the tuned default. Set 0 for 0s mode: answers fire on the next tick after typing stops - faster, but a mid-sentence pause becomes a new turn.",
    "fragment_ms": "Same, for fragments (short, unpunctuated): longer, so mid-word pauses never fire junk turns. 1-2 word fragments wait even longer.",
    "rec_settle_ms": "Settle time in recording/feed mode.",
    "warm_every": "Seconds between warm pings while idle.",
    "warm_idle": "Seconds of quiet before warm pings begin.",
    "self_every": "Seconds between self-direction decisions while quiet.",
    "reflect_max": "How many reflection/correction passes a turn may run (0 = off).",
    "bg_slots": "Max simultaneous background model calls. A remote endpoint serializes anyway; 1-2 avoids pile-ups.",
    "grace_ms": "Background calls yield this long after interactive activity before starting.",
    "aux_pause": "If average first-token time exceeds this (ms), ALL aux work pauses automatically until the pipe recovers - accuracy work stands down for speed.",
    "audio_port": "UDP port for the audio stream (0 = off). Usually main port + 1.",
}


# --------------------------------------------------------------------------- #
# small widgets
# --------------------------------------------------------------------------- #
def show_help_popup(owner, key):
    text = EXPLAIN.get(key, "(no explanation yet)")
    win = tk.Toplevel(owner)
    win.title("What this does / what it costs")
    win.attributes("-topmost", True)
    x = owner.winfo_rootx() + 560
    y = owner.winfo_rooty() + 60
    win.geometry("+%d+%d" % (x, y))
    tk.Label(win, text=text, wraplength=380, justify="left", bg="#ffffe0",
             relief="solid", padx=10, pady=8).pack()
    win.bind("<Leave>", lambda e: win.destroy())
    win.after(15000, win.destroy)


class Explained(ttk.Frame):
    """A label + widget + '?' that pops the explanation of what it does."""

    def __init__(self, parent, text, widget, key):
        super().__init__(parent)
        ttk.Label(self, text=text, width=24, anchor="w").pack(side="left")
        widget.pack(side="left", fill="x", expand=True, padx=4)
        help_btn = ttk.Label(self, text=" ? ", cursor="question_arrow", foreground="#06c")
        help_btn.pack(side="left")
        help_btn.bind("<Button-1>", lambda e: show_help_popup(self, key))


class LogBox(ttk.Frame):
    """Thread-safe log: everything the system prints lands here too."""

    def __init__(self, parent, height=10):
        super().__init__(parent)
        self.text = tk.Text(self, height=height, state="disabled", font=("Consolas", 9),
                            bg="#111", fg="#cfcfcf")
        scroll = ttk.Scrollbar(self, command=self.text.yview)
        self.text.configure(yscrollcommand=scroll.set)
        self.text.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.q = queue.Queue()
        self.after(200, self._drain)

    def write(self, line):
        self.q.put(str(line))

    def _drain(self):
        try:
            while True:
                line = self.q.get_nowait()
                self.text.configure(state="normal")
                self.text.insert("end", line)
                lines = int(self.text.index("end-1c").split(".")[0])
                if lines > 4000:
                    self.text.delete("1.0", "%d.0" % (lines - 4000))
                self.text.see("end")
                self.text.configure(state="disabled")
        except queue.Empty:
            pass
        self.after(200, self._drain)


class Tee:
    """stdout/stderr splitter: real console AND the desk log."""

    def __init__(self, original, log):
        self.original = original
        self.log = log

    def write(self, data):
        try:
            self.original.write(data)
            if data.strip():
                self.log.write(data if data.endswith("\n") else data + "\n")
        except Exception:
            pass

    def flush(self):
        try:
            self.original.flush()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# the bench: cross-reference speed between features
# --------------------------------------------------------------------------- #
BENCH_PROMPTS = [
    "What is gold?",
    "What is thought?",
    "Explain photosynthesis simply.",
]
BENCH_FEATURES = [
    "warm ping",
    "self agent",
    "reflector",
    "familiarity fire",
    "drafts",
    "expectancy check",
    "auto note",
]


class Bench:
    """Measures each feature's real cost on THIS endpoint.

    Method: a baseline with every aux feature off (fast_mode), then one run
    per feature with everything else off and only that feature on. A feature
    that barely moves the numbers can be added for free; a feature whose
    absence saves a lot is the one 'falling off'. Accuracy is proxied locally:
    answer present, repetition/ramble guards, corrections."""

    def __init__(self, hub, log):
        self.hub = hub
        self.log = log
        self.rows = []  # (feature, first_ms, total_ms, note/verdict)
        self.lock = threading.Lock()
        self.running = False
        self.saved = {}

    def _stub(self, name):
        """Turn a feature off by stubbing its entry point; returns undo."""
        hub = self.hub
        if name == "warm ping":
            old = hub.warm.ping
            hub.warm.ping = lambda: None
            return lambda: setattr(hub.warm, "ping", old)
        if name == "self agent":
            old = hub.self_agent.maybe_schedule
            hub.self_agent.maybe_schedule = lambda **k: None
            return lambda: setattr(hub.self_agent, "maybe_schedule", old)
        if name == "reflector":
            old = hub.reflector.schedule
            hub.reflector.schedule = lambda q, a: None
            return lambda: setattr(hub.reflector, "schedule", old)
        if name == "familiarity fire":
            old = hub.familiarity.fire
            hub.familiarity.fire = lambda p, a: hub.familiarity.capture(p, a)
            return lambda: setattr(hub.familiarity, "fire", old)
        if name == "drafts":
            old = hub.background_draft
            hub.background_draft = lambda t: None
            return lambda: setattr(hub, "background_draft", old)
        if name == "expectancy check":
            old_cls = lan.Expectancy

            class QuietExpectancy(old_cls):
                def check_sync(self, group):
                    return  # local score stands; no second-model call

            lan.Expectancy = QuietExpectancy
            return lambda: setattr(lan, "Expectancy", old_cls)
        if name == "auto note":
            old = hub.chat.autonote
            hub.chat.autonote = False
            return lambda: setattr(hub.chat, "autonote", old)
        if name == "speculative":
            old = hub.speculative.schedule
            hub.speculative.schedule = lambda: None
            return lambda: setattr(hub.speculative, "schedule", old)
        return lambda: None

    def _save(self):
        """Save the CURRENT entry points (user flags already applied), so every
        bench mode starts from exactly the state the panel set up."""
        hub = self.hub
        self.saved = {
            "warm": hub.warm.ping,
            "selfagent": hub.self_agent.maybe_schedule,
            "reflector": hub.reflector.schedule,
            "familiarity": hub.familiarity.fire,
            "drafts": hub.background_draft,
            "autonote": hub.chat.autonote,
            "expectancy": lan.Expectancy,
            "speculative": hub.speculative.schedule,
        }

    def restore_all(self):
        hub = self.hub
        if not self.saved:
            return
        hub.warm.ping = self.saved["warm"]
        hub.self_agent.maybe_schedule = self.saved["selfagent"]
        hub.reflector.schedule = self.saved["reflector"]
        hub.familiarity.fire = self.saved["familiarity"]
        hub.background_draft = self.saved["drafts"]
        hub.chat.autonote = self.saved["autonote"]
        lan.Expectancy = self.saved["expectancy"]
        hub.speculative.schedule = self.saved["speculative"]

    def _one_mode(self, feature=None, prompts=None):
        """Run the prompt set in one mode; returns (first_avg, total_avg, note)."""
        hub = self.hub
        self.restore_all()
        undos = []
        try:
            if feature is None:
                # baseline: every aux entry point off, fast_mode on
                for name in BENCH_FEATURES + ["speculative"]:
                    undos.append(self._stub(name))
                hub.chat.fast_mode = True
            else:
                hub.chat.fast_mode = False
                # everything off except the feature under test
                for name in BENCH_FEATURES + ["speculative"]:
                    if name != feature:
                        undos.append(self._stub(name))
            firsts, totals, notes = [], [], []
            for prompt in (prompts or BENCH_PROMPTS):
                started = time.time()
                answer, first_ms, total_ms, note = self._timed_turn(prompt, started)
                firsts.append(first_ms or 0)
                totals.append(total_ms)
                notes.append(note)
            avg_first = int(sum(firsts) / len(firsts)) if firsts else 0
            avg_total = int(sum(totals) / len(totals)) if totals else 0
            return avg_first, avg_total, " | ".join(n for n in notes if n) or "clean"
        finally:
            for undo in undos:
                undo()

    def _timed_turn(self, prompt, started):
        hub = self.hub
        box = {"ms": None, "total": None, "note": ""}
        original_broadcast = hub.broadcast

        def spy(**message):
            if message.get("ch") == "ai" and message.get("final"):
                box["ms"] = message.get("ms_first")
                box["total"] = message.get("ms_total")
                if message.get("revised"):
                    box["note"] = "correction ran"
            return original_broadcast(**message)

        hub.broadcast = spy
        try:
            answer = hub.serve_turn(prompt, rec=False)
        except Exception as err:  # noqa: BLE001
            answer = ""
            box["note"] = "error: %s" % str(err)[:60]
        finally:
            hub.broadcast = original_broadcast
        if not answer or answer.startswith("("):
            box["note"] = (box["note"] + " NO-ANSWER").strip()
        elif core.rambles(answer):
            box["note"] = (box["note"] + " ramble-guard").strip()
        total = box["total"] if box["total"] is not None else int((time.time() - started) * 1000)
        return answer, box["ms"] or 0, total, box["note"]

    def run(self, prompts_per_mode=1, done_cb=None):
        """Full matrix: baseline + one run per feature. Never blocks the GUI."""

        def work():
            try:
                hub = self.hub
                self._save()
                original_fast = hub.chat.fast_mode
                prompts = BENCH_PROMPTS[:max(1, min(3, prompts_per_mode))]
                rows = []

                first, total, note = self._one_mode(None, prompts=prompts)
                rows.append(("BASELINE (all aux off)", first, total, note))
                base_total = max(1, total)

                for name in BENCH_FEATURES:
                    first, total, note = self._one_mode(name, prompts=prompts)
                    delta = total - base_total
                    verdict = ("free" if abs(delta) <= max(300, base_total * 0.15)
                               else ("costs %d%% more" % int(100 * delta / base_total) if delta > 0
                                     else "saves %d%%" % int(-100 * delta / base_total)))
                    rows.append((name, first, total, "%s | %s" % (note, verdict)))

                self.restore_all()
                hub.chat.fast_mode = original_fast
                with self.lock:
                    self.rows = rows
                self.log.write("[%s] bench done: %d modes measured\n" % (stamp(), len(rows)))
            except Exception as err:  # noqa: BLE001
                self.log.write("[%s] bench failed: %s\n" % (stamp(), err))
                self.log.write(traceback.format_exc(limit=3))
            finally:
                self.restore_all()
                self.running = False
                if done_cb:
                    try:
                        done_cb()
                    except Exception:
                        pass

        self.running = True
        threading.Thread(target=work, daemon=True).start()

    def ai_verdict(self, done_cb=None):
        """The AI reads its own bench table and says what to keep."""
        hub = self.hub
        with self.lock:
            rows = list(self.rows)
        if not rows:
            if done_cb:
                done_cb("(run the bench first)")
            return

        def work():
            table = "\n".join("%-24s first %5d ms | total %5d ms | %s" % r for r in rows)
            try:
                verdict = hub.chat.client.complete(
                    [
                        {"role": "system", "content": (
                            "You are tuning your own runtime. This table shows the cost of each "
                            "feature measured on this endpoint (baseline = all aux off). Reply SHORT: "
                            "one line per feature saying KEEP (cheap, keeps accuracy) or DROP or "
                            "OFF-PEAK ONLY, then one final line 'PROFILE: ...' naming the best "
                            "all-round feature set."
                        )},
                        {"role": "user", "content": table},
                    ],
                    max_tokens=300,
                    sampling={"temperature": 0.2},
                    kind="bench",
                    priority="interactive",
                ).strip()
            except Exception as err:  # noqa: BLE001
                verdict = "(verdict failed: %s)" % str(err)[:80]
            self.log.write("\n===== AI VERDICT =====\n%s\n======================\n" % verdict)
            if done_cb:
                done_cb(verdict)

        threading.Thread(target=work, daemon=True).start()


# --------------------------------------------------------------------------- #
# the desktop app
# --------------------------------------------------------------------------- #
class DeskApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("fast chat - desktop control panel")
        self.geometry("1000x780")
        self.hub = None
        self.client = None
        self.bench = None

        outer = ttk.Frame(self)
        outer.pack(fill="both", expand=True)
        self.note = ttk.Notebook(outer)
        self.note.pack(fill="both", expand=True)
        self.log = LogBox(outer, height=9)
        self.log.pack(fill="x", side="bottom")
        sys.stdout = Tee(sys.__stdout__, self.log)
        sys.stderr = Tee(sys.__stderr__, self.log)

        self._saved = self._persist_load()
        for name, attr in (("Start", "start"), ("Engine", "engine"), ("Features", "feat"),
                           ("Interject", "inter"), ("Bench", "bench"), ("Files", "files")):
            frame = ttk.Frame(self.note)
            self.note.add(frame, text=" %s " % name)
            setattr(self, "tab_" + attr, frame)
        self._build_start()
        self._build_engine()
        self._build_features()
        self._build_interject()
        self._build_bench()
        self._build_files()
        self._persist_apply()

    # -- settings persistence ------------------------------------------------ #
    def _persist_load(self):
        try:
            return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - first run or unreadable: defaults
            return {}

    def _persist_apply(self):
        """Put every saved panel value back into the widgets."""
        for name, value in self._saved.items():
            var = getattr(self, name, None)
            try:
                if isinstance(var, (tk.StringVar, tk.BooleanVar, tk.IntVar, tk.DoubleVar)):
                    var.set(value)
            except Exception:  # noqa: BLE001
                pass
        if self._saved.get("preamble"):
            self.preamble.delete("1.0", "end")
            self.preamble.insert("1.0", self._saved["preamble"])
        if self._saved.get("poststream"):
            self.poststream.delete("1.0", "end")
            self.poststream.insert("1.0", self._saved["poststream"])
        if self._saved.get("reflection"):
            self.reflection.delete("1.0", "end")
            self.reflection.insert("1.0", self._saved["reflection"])
        for name in ("preamble_on", "post_on", "refl_on"):
            if name in self._saved:
                getattr(self, name).set(self._saved[name])

    def _persist_save(self):
        data = {}
        for name in ("url", "model", "fast_model", "code_model", "max_tokens", "timeout",
                     "gpu", "num_thread", "host", "port", "audio_port",
                     "settle_ms", "fragment_ms", "rec_settle_ms", "warm_every", "warm_idle",
                     "self_every", "reflect_max", "bg_slots", "grace_ms", "aux_pause"):
            try:
                data[name] = getattr(self, name).get()
            except Exception:  # noqa: BLE001
                pass
        for name in ("fast_mode", "live", "speak", "warm", "health", "speculative",
                     "reflector", "expectancy", "selfagent", "autonote", "familiarity",
                     "drafts", "followups", "continuewrap", "peer_review", "rec",
                     "link_live", "preamble_on", "post_on", "refl_on"):
            try:
                data[name] = bool(getattr(self, name).get())
            except Exception:  # noqa: BLE001
                pass
        for name in ("role", "audio_method"):
            try:
                data[name] = getattr(self, name).get()
            except Exception:  # noqa: BLE001
                pass
        data["preamble"] = self.preamble.get("1.0", "end").strip()
        data["poststream"] = self.poststream.get("1.0", "end").strip()
        data["reflection"] = self.reflection.get("1.0", "end").strip()
        try:
            SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
            SETTINGS_PATH.write_text(json.dumps(data, indent=1), encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass

    # -- endpoint diagnostics -------------------------------------------------- #
    def _ping_endpoint(self, attempts=2):
        """Straight pings to the configured endpoint; returns the first-token
        ms of the fastest attempt, or None. Logged either way."""
        import requests
        url = ext.SETTINGS.get("url", "")
        model = ext.SETTINGS.get("model", "")
        body = {
            "model": model,
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
            "keep_alive": "30m",
            "options": dict(core.SAMPLING or {}, num_predict=3),
            "think": False,
        }
        best = None
        for attempt in range(1, attempts + 1):
            t0 = time.time()
            try:
                resp = requests.post(url, json=body, stream=True, timeout=120)
                resp.raise_for_status()
                first = None
                for line in resp.iter_lines():
                    if line and first is None:
                        first = time.time()
                ttft = int((first - t0) * 1000) if first else -1
                total = int((time.time() - t0) * 1000)
                best = ttft if ttft >= 0 and (best is None or ttft < best) else best
                self.log.write("[%s] endpoint ping %d: first token %d ms | total %d ms\n"
                               % (stamp(), attempt, ttft, total))
            except Exception as err:
                self.log.write("[%s] endpoint ping %d FAILED: %s\n" % (stamp(), attempt, str(err)[:120]))
        return best

    def on_speed_test(self):
        """Manual endpoint diagnostic: 2 pings, plain verdict."""
        try:
            self._collect_engine()
        except Exception as err:
            messagebox.showerror("bad setting", str(err))
            return

        def work():
            self._ping_endpoint()
            self.log.write("(these numbers ARE your floor - every answer pays this + decode time)\n")

        threading.Thread(target=work, daemon=True).start()

    def _auto_ping_after_start(self):
        """Run automatically when a home starts: measure the endpoint floor
        and say what it means for answer speed - no guessing, ever."""
        best = self._ping_endpoint()
        if best is None:
            self.log.write("[%s] endpoint unreachable - answers will fail or hang\n" % stamp())
        elif best > 8000:
            self.log.write(
                "[%s] *** ENDPOINT IS THE WALL: %d ms before the first token. ***\n"
                "    No code can make answers faster than this pipe. Do ONE of:\n"
                "      1. Features tab: turn 'fast mode' ON (pure answers, zero extra calls)\n"
                "      2. Run Ollama on THIS machine and set the URL to\n"
                "         http://127.0.0.1:11434/ollama/api/chat - first tokens drop to ~200-500 ms\n"
                % (stamp(), best))
        elif best > 2500:
            self.log.write(
                "[%s] endpoint floor %d ms: every answer waits at least this.\n"
                "    The aux breaker stands extra work down; for pure speed turn 'fast mode' ON.\n"
                % (stamp(), best))
        else:
            self.log.write("[%s] endpoint floor %d ms - healthy. Full feature set is affordable.\n" % (stamp(), best))

    # -- START tab ----------------------------------------------------------- #
    def _build_start(self):
        f = self.tab_start
        pad = {"padx": 10, "pady": 4}
        self.role = tk.StringVar(value="home")
        row = ttk.Frame(f); row.pack(fill="x", **pad)
        Explained(row, "Role",
                  ttk.Combobox(row, textvariable=self.role, values=["home", "link"],
                               state="readonly", width=12), "role").pack(fill="x")
        self.host = tk.StringVar(value="192.168.1.112")
        self.port = tk.StringVar(value="9514")
        row = ttk.Frame(f); row.pack(fill="x", **pad)
        host_frame = ttk.Frame(row)
        Explained(row, "Host / Port", host_frame, "host").pack(fill="x")
        ttk.Entry(host_frame, textvariable=self.host, width=18).pack(side="left")
        ttk.Entry(host_frame, textvariable=self.port, width=7).pack(side="left", padx=4)
        self.audio_port = tk.StringVar(value="0")
        row2 = ttk.Frame(f); row2.pack(fill="x", **pad)
        Explained(row2, "UDP audio port (0 off)",
                  ttk.Entry(row2, textvariable=self.audio_port, width=8), "audio_port").pack(fill="x")
        btns = ttk.Frame(f); btns.pack(pady=6)
        self.start_btn = ttk.Button(btns, text="START", command=self.on_start)
        self.start_btn.pack(side="left", padx=4)
        self.stop_btn = ttk.Button(btns, text="stop", command=self.on_stop, state="disabled")
        self.stop_btn.pack(side="left", padx=4)
        ttk.Button(btns, text="test endpoint speed", command=self.on_speed_test).pack(side="left", padx=4)
        # link-mode input box
        ttk.Label(f, text="Link input (sent when you press Send; or live-send per keystroke):").pack(anchor="w", **pad)
        in_row = ttk.Frame(f); in_row.pack(fill="x", **pad)
        self.link_input = tk.StringVar()
        self.link_live = tk.BooleanVar(value=False)
        entry = ttk.Entry(in_row, textvariable=self.link_input)
        entry.pack(side="left", fill="x", expand=True, padx=4)
        entry.bind("<Return>", lambda e: self.on_link_send())
        entry.bind("<KeyRelease>", self.on_link_key)
        ttk.Button(in_row, text="Send", command=self.on_link_send).pack(side="left", padx=2)
        ttk.Checkbutton(in_row, text="live-send keystrokes", variable=self.link_live).pack(side="left")
        ttk.Label(f, foreground="#555", wraplength=900, justify="left", text=(
            "Start the panel with the role you need. HOME serves everyone; LINK is a client. "
            "Everything the system prints also lands in the log below. The chat engine itself is "
            "fast_chat.py - this panel only configures and drives it."
        )).pack(**pad)

    def _collect_engine(self):
        """Push every panel value into the settings the engine actually reads."""
        ext.SETTINGS["url"] = self.url.get().strip() or ext.SETTINGS.get("url", "")
        ext.SETTINGS["model"] = self.model.get().strip() or ext.SETTINGS.get("model", "")
        ext.SETTINGS["fast_model"] = self.fast_model.get().strip() or ext.SETTINGS.get("fast_model", "")
        ext.SETTINGS["code_model"] = self.code_model.get().strip() or ext.SETTINGS.get("code_model", "")
        ext.SETTINGS["max_tokens"] = int(self.max_tokens.get() or 400)
        ext.SETTINGS["timeout"] = float(self.timeout.get() or 240)
        # routing: CPU/GPU and threads ride into every request payload
        sampling = {}
        if self.gpu.get() == "force CPU":
            sampling["num_gpu"] = 0
        elif self.gpu.get() == "force GPU":
            sampling["num_gpu"] = 99
        if self.num_thread.get():
            try:
                sampling["num_thread"] = int(self.num_thread.get())
            except ValueError:
                pass
        core.SAMPLING.clear()
        core.SAMPLING.update(sampling)
        # timing + usage dials
        ext.SETTINGS["lan_settle_ms"] = int(self.settle_ms.get() or 200)
        ext.SETTINGS["lan_fragment_settle_ms"] = int(self.fragment_ms.get() or 800)
        ext.SETTINGS["lan_rec_settle_ms"] = int(self.rec_settle_ms.get() or 120)
        ext.SETTINGS["lan_warm_every"] = int(self.warm_every.get() or 60)
        ext.SETTINGS["lan_warm_idle"] = int(self.warm_idle.get() or 20)
        ext.SETTINGS["lan_self_every"] = int(self.self_every.get() or 120)
        ext.SETTINGS["lan_reflect_max"] = int(self.reflect_max.get() or 1)
        ext.SETTINGS["lan_background_slots"] = int(self.bg_slots.get() or 1)
        ext.SETTINGS["lan_background_grace_ms"] = int(self.grace_ms.get() or 100)
        ext.SETTINGS["lan_aux_pause_ttft_ms"] = int(self.aux_pause.get() or 8000)

    def on_start(self):
        try:
            self._collect_engine()
        except Exception as err:
            messagebox.showerror("bad setting", str(err))
            return
        port = int(self.port.get() or 9514)
        role = self.role.get()
        # audio method mapping: SAPI is the hub's speak flag; udp needs a port
        if self.audio_method.get().startswith("speak") or self.audio_method.get() == "both":
            self.speak.set(True)
        audio_port = int(self.audio_port.get() or 0)
        if self.audio_method.get() in ("udp stream", "both") and not audio_port:
            audio_port = port + 1
            self.audio_port.set(str(audio_port))
        self._persist_save()
        self.start_btn.configure(state="disabled")

        def work():
            try:
                if role == "home":
                    self.log.write("[%s] starting HOME on port %d...\n" % (stamp(), port))
                    hub = lan.Hub(port=port, speak=self.speak.get(),
                                  peer_review=self.peer_review.get(),
                                  fast=self.fast_mode.get())
                    self.hub = hub
                    self._apply_feature_flags(hub)
                    self._apply_interject(hub)
                    self.bench = Bench(hub, self.log)
                    threading.Thread(target=self._auto_ping_after_start, daemon=True).start()
                    hub.serve_forever(audio_port=int(self.audio_port.get() or 0))
                else:
                    self.log.write("[%s] linking to %s:%d...\n" % (stamp(), self.host.get(), port))
                    self.client = lan.LinkClient(self.host.get().strip(), port,
                                                 speak=self.speak.get(), live=self.live.get())
                    self.client.connect()
                    self.log.write("[%s] linked - type in the box above\n" % stamp())
            except Exception as err:
                self.log.write("[%s] start failed: %s\n" % (stamp(), err))
                self.log.write(traceback.format_exc(limit=4))
            finally:
                self.after(0, lambda: self.start_btn.configure(state="normal"))

        threading.Thread(target=work, daemon=True).start()
        self.stop_btn.configure(state="normal")

    def on_stop(self):
        if self.hub:
            try:
                self.hub.stop()
            except Exception:
                pass
        if self.client:
            try:
                self.client.link.close()
            except Exception:
                pass
        self.log.write("[%s] stopped\n" % stamp())
        self.stop_btn.configure(state="disabled")

    def on_link_send(self):
        text = self.link_input.get().strip()
        if text and self.client:
            self.client.send(ch="user", text=text, user=self.client.name)
            self.link_input.set("")

    def on_link_key(self, event):
        if self.link_live.get() and self.client and len(event.char) == 1 and event.char >= " ":
            self.client.send(ch="live", text=event.char, user=self.client.name)

    # -- ENGINE tab ----------------------------------------------------------- #
    def _build_engine(self):
        f = self.tab_engine
        pad = {"padx": 10, "pady": 3}
        self.url = tk.StringVar(value=str(ext.SETTINGS.get("url", "")))
        self.model = tk.StringVar(value=str(ext.SETTINGS.get("model", "")))
        self.fast_model = tk.StringVar(value=str(ext.SETTINGS.get("fast_model", "")))
        self.code_model = tk.StringVar(value=str(ext.SETTINGS.get("code_model", "")))
        self.max_tokens = tk.StringVar(value=str(ext.SETTINGS.get("max_tokens", 400)))
        self.timeout = tk.StringVar(value=str(ext.SETTINGS.get("timeout", 240)))
        self.gpu = tk.StringVar(value="auto")
        self.num_thread = tk.StringVar(value="")

        rows = [
            ("Endpoint URL", ttk.Entry(f, textvariable=self.url), "url"),
            ("Model", ttk.Entry(f, textvariable=self.model), "model"),
            ("Fast model", ttk.Entry(f, textvariable=self.fast_model), "fast_model"),
            ("Code model", ttk.Entry(f, textvariable=self.code_model), "code_model"),
            ("Max tokens", ttk.Entry(f, textvariable=self.max_tokens, width=8), "max_tokens"),
            ("Timeout s", ttk.Entry(f, textvariable=self.timeout, width=8), "timeout"),
            ("CPU / GPU", ttk.Combobox(f, textvariable=self.gpu, state="readonly",
                                       values=["auto", "force CPU", "force GPU"], width=12), "gpu"),
            ("CPU threads", ttk.Entry(f, textvariable=self.num_thread, width=8), "num_thread"),
        ]
        for text, widget, key in rows:
            Explained(f, text, widget, key).pack(fill="x", **pad)
        ttk.Label(f, wraplength=900, justify="left", foreground="#555", text=(
            "CPU/GPU applies num_gpu / num_thread inside every request payload (Ollama options) - "
            "it routes COMPUTE, not network. A remote endpoint's network time is unaffected; "
            "running Ollama locally is the real speed win.\n"
            "Routing mode lives on the Features tab: fast mode / live typing / the classic pipeline "
            "all combine there."
        )).pack(**pad)

    # -- FEATURES tab ---------------------------------------------------------- #
    def _check_row(self, f, text, key, initial=True):
        var = tk.BooleanVar(value=initial)
        cb = ttk.Checkbutton(f, text=text, variable=var)
        cb.pack(anchor="w", padx=10, pady=1)
        help_btn = ttk.Label(f, text="      ? what it does / costs", cursor="question_arrow", foreground="#06c")
        help_btn.pack(anchor="w", padx=30)
        help_btn.bind("<Button-1>", lambda e: show_help_popup(self, key))
        return var

    def _dial_row(self, f, text, key, var, width=8):
        row = ttk.Frame(f); row.pack(fill="x", padx=10, pady=1)
        Explained(row, text, ttk.Entry(row, textvariable=var, width=width), key).pack(fill="x")

    def _build_features(self):
        f = self.tab_feat
        pad = {"padx": 10, "pady": 2}
        self.fast_mode = tk.BooleanVar(value=False)
        self.live = tk.BooleanVar(value=True)
        self.speak = tk.BooleanVar(value=False)
        self.audio_method = tk.StringVar(value="none")
        ttk.Label(f, text="Master + output", font=("TkDefaultFont", 10, "bold")).pack(anchor="w", **pad)
        for text, var, key in [
            ("fast mode: model does nothing but answer", self.fast_mode, "fast_mode"),
            ("live typing (auto-answer ~0.2s, no Enter)", self.live, "live"),
            ("speak answers aloud (Windows SAPI)", self.speak, "speak"),
        ]:
            cb = ttk.Checkbutton(f, text=text, variable=var)
            cb.pack(anchor="w", padx=10)
            tip = ttk.Label(f, text="      ? " + EXPLAIN[key][:100] + "...", foreground="#888")
            tip.pack(anchor="w", padx=30)
            tip.bind("<Button-1>", lambda e, k=key: show_help_popup(self, k))
        row = ttk.Frame(f); row.pack(fill="x", **pad)
        Explained(row, "Audio method",
                  ttk.Combobox(row, textvariable=self.audio_method, state="readonly",
                               values=["none", "speak (SAPI)", "udp stream", "both"], width=16),
                  "audio_method").pack(fill="x")

        ttk.Label(f, text="Aux features (each with its cost)", font=("TkDefaultFont", 10, "bold")).pack(anchor="w", **pad)
        self.warm = self._check_row(f, "warm pings (keep model loaded)", "warm")
        self.health = self._check_row(f, "health reports", "health", initial=True)
        self.speculative = self._check_row(f, "speculative pre-answers", "speculative", initial=True)
        self.reflector = self._check_row(f, "reflector (self-check + corrections)", "reflector", initial=True)
        self.expectancy = self._check_row(f, "expectancy pacing (speak/hold groups)", "expectancy", initial=True)
        self.selfagent = self._check_row(f, "self-agent (SPEAK/PREPARE/OK)", "selfagent", initial=True)
        self.autonote = self._check_row(f, "auto-note fact extraction", "autonote", initial=True)
        self.familiarity = self._check_row(f, "familiarity trail + firing", "familiarity", initial=True)
        self.drafts = self._check_row(f, "drafts while typing", "drafts", initial=True)
        self.followups = self._check_row(f, "followups (caught input)", "followups", initial=True)
        self.continuewrap = self._check_row(f, "continue wrap", "continuewrap", initial=True)
        self.peer_review = self._check_row(f, "peer review (needs a peer link)", "peer_review", initial=False)
        self.rec = self._check_row(f, "recording/feed mode (no post passes)", "rec", initial=False)

        ttk.Label(f, text="Usage dials - how often / how much", font=("TkDefaultFont", 10, "bold")).pack(anchor="w", **pad)
        self.settle_ms = tk.StringVar(value=str(ext.SETTINGS.get("lan_settle_ms", 200)))
        self.fragment_ms = tk.StringVar(value=str(ext.SETTINGS.get("lan_fragment_settle_ms", 800)))
        self.rec_settle_ms = tk.StringVar(value=str(ext.SETTINGS.get("lan_rec_settle_ms", 120)))
        self.warm_every = tk.StringVar(value=str(ext.SETTINGS.get("lan_warm_every", 60)))
        self.warm_idle = tk.StringVar(value=str(ext.SETTINGS.get("lan_warm_idle", 20)))
        self.self_every = tk.StringVar(value=str(ext.SETTINGS.get("lan_self_every", 120)))
        self.reflect_max = tk.StringVar(value=str(ext.SETTINGS.get("lan_reflect_max", 1)))
        self.bg_slots = tk.StringVar(value=str(ext.SETTINGS.get("lan_background_slots", 1)))
        self.grace_ms = tk.StringVar(value=str(ext.SETTINGS.get("lan_background_grace_ms", 100)))
        self.aux_pause = tk.StringVar(value=str(ext.SETTINGS.get("lan_aux_pause_ttft_ms", 8000)))
        for text, key, var in [
            ("settle ms (complete text)", "settle_ms", self.settle_ms),
            ("fragment settle ms", "fragment_ms", self.fragment_ms),
            ("rec settle ms", "rec_settle_ms", self.rec_settle_ms),
            ("warm every s", "warm_every", self.warm_every),
            ("warm idle s", "warm_idle", self.warm_idle),
            ("self every s", "self_every", self.self_every),
            ("reflect max", "reflect_max", self.reflect_max),
            ("background slots", "bg_slots", self.bg_slots),
            ("background grace ms", "grace_ms", self.grace_ms),
            ("aux pause ttft ms", "aux_pause", self.aux_pause),
        ]:
            self._dial_row(f, text, key, var)

    def _apply_feature_flags(self, hub):
        """Apply the Features tab to a freshly built hub."""
        chat = hub.chat
        chat.fast_mode = self.fast_mode.get()
        chat.autonote = self.autonote.get()
        if not self.warm.get():
            hub.warm.ping = lambda: None
        if not self.speculative.get():
            hub.speculative.schedule = lambda: None
        hub.reflector.max_fixes = int(self.reflect_max.get() or 0) if self.reflector.get() else 0
        if not self.selfagent.get():
            hub.self_agent.maybe_schedule = lambda **k: None
        if not self.drafts.get():
            hub.background_draft = lambda t: None
        if not self.expectancy.get():
            base = lan.Expectancy

            class QuietExpectancy(base):
                def check_sync(self, group):
                    return

            lan.Expectancy = QuietExpectancy
        if not self.followups.get():
            hub.followups.prepare_and_present = lambda **k: None
        if not self.continuewrap.get():
            hub.continue_wrap.directive = lambda: None
        self.log.write("[%s] features applied: fast=%s warm=%s reflect=%s drafts=%s fam=%s notes=%s\n"
                       % (stamp(), chat.fast_mode, self.warm.get(), self.reflector.get(),
                          self.drafts.get(), self.familiarity.get(), self.autonote.get()))

    # -- INTERJECT tab ---------------------------------------------------------- #
    def _build_interject(self):
        f = self.tab_inter
        pad = {"padx": 10, "pady": 3}
        ttk.Label(f, wraplength=900, justify="left", text=(
            "Prompt interjection points: text you inject INTO the pipeline, to test whether the "
            "model actually incorporates it while it thinks and processes updated responses - not "
            "just an on/off toggle. Three stages:\n"
            "  1. PREAMBLE - rides into the context before the model starts thinking.\n"
            "  2. POST-STREAM - a rewrite pass after the answer streams: did it re-process and "
            "produce an updated response that follows your instruction?\n"
            "  3. REFLECTION - added to the self-check the model runs against its own answer.\n"
            "Marker test: put a weird word in the instruction (e.g. 'mention ZEPHYR'). If the "
            "answer contains it, the model truly incorporated the injection."
        )).pack(**pad)
        self.preamble_on = tk.BooleanVar(value=False)
        self.preamble = tk.Text(f, height=3)
        self.preamble.pack(fill="x", **pad)
        ttk.Checkbutton(f, text="preamble ON (rides in before thinking)", variable=self.preamble_on).pack(anchor="w", **pad)
        self.post_on = tk.BooleanVar(value=False)
        self.poststream = tk.Text(f, height=3)
        self.poststream.pack(fill="x", **pad)
        ttk.Checkbutton(f, text="post-stream rewrite ON (answer re-processed after streaming)", variable=self.post_on).pack(anchor="w", **pad)
        self.refl_on = tk.BooleanVar(value=False)
        self.reflection = tk.Text(f, height=3)
        self.reflection.pack(fill="x", **pad)
        ttk.Checkbutton(f, text="reflection ON (added to the self-check)", variable=self.refl_on).pack(anchor="w", **pad)
        btns = ttk.Frame(f); btns.pack(pady=6)
        ttk.Button(btns, text="APPLY to running home", command=self.on_apply_interject).pack(side="left", padx=4)
        ttk.Button(btns, text="MARKER TEST ('what is gold' with ZEPHYR injected)",
                   command=self.on_marker_test).pack(side="left", padx=4)

    def _apply_interject(self, hub=None):
        hub = hub or self.hub
        if not hub:
            return
        hub.interject = {
            "preamble": self.preamble.get("1.0", "end").strip(),
            "preamble_on": self.preamble_on.get(),
            "poststream": self.poststream.get("1.0", "end").strip(),
            "poststream_on": self.post_on.get(),
            "reflection": self.reflection.get("1.0", "end").strip(),
            "reflection_on": self.refl_on.get(),
        }
        active = [k for k in ("preamble", "poststream", "reflection") if hub.interject.get(k + "_on")]
        self.log.write("[%s] interjections applied: %s\n" % (stamp(), ", ".join(active) or "none"))

    def on_apply_interject(self):
        if not self.hub:
            messagebox.showinfo("not running", "Start a HOME first (interjections live in the bridge).")
            return
        self._apply_interject()

    def on_marker_test(self):
        if not self.hub:
            messagebox.showinfo("not running", "Start a HOME first.")
            return
        self.preamble.delete("1.0", "end")
        self.preamble.insert("1.0", "For testing: casually mention the word ZEPHYR once in this answer.")
        self.preamble_on.set(True)
        self._apply_interject()

        def work():
            answer = self.hub.serve_turn("what is gold", rec=False)
            hit = "ZEPHYR" in answer.upper()
            self.log.write("[%s] MARKER TEST: %s\n  answer: %s\n"
                           % (stamp(), "INCORPORATED" if hit else "NOT incorporated",
                              (answer or "")[:200]))

        threading.Thread(target=work, daemon=True).start()

    # -- BENCH tab ---------------------------------------------------------------- #
    def _build_bench(self):
        f = self.tab_bench
        pad = {"padx": 10, "pady": 3}
        ttk.Label(f, wraplength=900, justify="left", text=(
            "Cross-reference speed between features: the SAME questions run once with everything "
            "aux off (baseline) and once per feature with only that feature on. A feature whose "
            "numbers barely move can be ADDED for free; the one whose absence saves real time is "
            "what 'falls off'. Accuracy is proxied locally (answer present, repetition/ramble "
            "guards, corrections). 'AI VERDICT' asks the model to read its own table and name the "
            "best all-round feature set. Needs a running HOME (uses its engine directly).\n"
            "Heads-up: this makes real model calls on a slow remote endpoint - that IS the measurement."
        )).pack(**pad)
        self.bench_prompts = tk.StringVar(value="1")
        row = ttk.Frame(f); row.pack(**pad)
        Explained(row, "Questions per mode (1-3)",
                  ttk.Spinbox(row, textvariable=self.bench_prompts, from_=1, to=3, width=6),
                  "settle_ms").pack(fill="x")
        btns = ttk.Frame(f); btns.pack(**pad)
        ttk.Button(btns, text="RUN BENCH", command=self.on_bench).pack(side="left", padx=4)
        ttk.Button(btns, text="AI VERDICT", command=self.on_verdict).pack(side="left", padx=4)
        cols = ("feature", "first ms", "total ms", "note / verdict")
        self.tree = ttk.Treeview(f, columns=cols, show="headings", height=10)
        for c, w in zip(cols, (210, 80, 80, 430)):
            self.tree.heading(c, text=c)
            self.tree.column(c, width=w, anchor="w")
        self.tree.pack(fill="both", expand=True, **pad)

    def on_bench(self):
        if not self.hub or not self.bench:
            messagebox.showinfo("not running", "Start a HOME first - the bench drives its engine.")
            return
        if self.bench.running:
            messagebox.showinfo("running", "A bench is already running.")
            return
        for item in self.tree.get_children():
            self.tree.delete(item)
        self.log.write("[%s] bench starting (%s prompt(s) per mode)...\n" % (stamp(), self.bench_prompts.get()))

        def done():
            self.after(0, self._fill_bench)

        self.bench.run(prompts_per_mode=int(self.bench_prompts.get() or 1), done_cb=done)

    def _fill_bench(self):
        for row in self.bench.rows:
            self.tree.insert("", "end", values=row)

    def on_verdict(self):
        if not self.bench:
            return
        self.bench.ai_verdict()

    # -- FILES tab ------------------------------------------------------------------ #
    def _build_files(self):
        f = self.tab_files
        pad = {"padx": 10, "pady": 3}
        ttk.Label(f, wraplength=900, justify="left", text=(
            "File intake: TEXT files are read and added to the notes store and context (the model "
            "can use them immediately). PICTURES are described by a direct vision call to the same "
            "endpoint (Ollama images field) and the description joins the notes. VIDEO is stored "
            "and noted - decoding frames needs extra libraries, so it is archived with metadata, "
            "not analysed. Files are copied into state\\files so the home always has them."
        )).pack(**pad)
        ttk.Button(f, text="Upload text / picture / video...", command=self.on_upload).pack(**pad)
        cols = ("file", "kind", "status")
        self.files_tree = ttk.Treeview(f, columns=cols, show="headings", height=8)
        for c, w in zip(cols, (280, 90, 400)):
            self.files_tree.heading(c, text=c)
            self.files_tree.column(c, width=w, anchor="w")
        self.files_tree.pack(fill="both", expand=True, **pad)

    def on_upload(self):
        path = filedialog.askopenfilename(title="choose a file")
        if not path:
            return
        FILES_DIR.mkdir(parents=True, exist_ok=True)
        src = Path(path)
        suffix = src.suffix.lower()
        if suffix in (".txt", ".md", ".json", ".csv", ".log", ".py", ".ini"):
            kind = "text"
        elif suffix in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"):
            kind = "picture"
        elif suffix in (".mp4", ".avi", ".mov", ".mkv", ".webm"):
            kind = "video"
        else:
            kind = "other"

        def work():
            dest = FILES_DIR / src.name
            try:
                dest.write_bytes(src.read_bytes())
            except Exception as err:
                self.after(0, lambda: self._file_row(src.name, kind, "copy failed: %s" % err))
                return
            hub = self.hub
            if kind == "text":
                try:
                    content = dest.read_text(errors="replace")[:4000]
                    if hub:
                        hub.chat.notes.add("file", src.name, content)
                        hub.broadcast(ch="ai-note", type="file",
                                      text="text file added to notes: %s (%d chars)" % (src.name, len(content)))
                        self.after(0, lambda: self._file_row(src.name, kind,
                                                             "in notes + context (%d chars)" % len(content)))
                    else:
                        self.after(0, lambda: self._file_row(src.name, kind,
                                                             "stored (%d chars) - start HOME to inject into notes" % len(content)))
                except Exception as err:
                    self.after(0, lambda: self._file_row(src.name, kind, "read failed: %s" % err))
            elif kind == "picture":
                self._describe_picture(dest, src.name, kind)
            else:
                size_kb = dest.stat().st_size // 1024
                if hub:
                    hub.chat.notes.add("file", src.name,
                                       "%s file stored: %s (%d KB). Frame analysis needs extra libraries."
                                       % (kind, dest, size_kb))
                self.after(0, lambda: self._file_row(src.name, kind, "stored (%d KB), noted" % size_kb))

        threading.Thread(target=work, daemon=True).start()

    def _describe_picture(self, dest, name, kind):
        """Direct vision call: same endpoint, Ollama images field, bypassing the
        text-only client payload (fast_chat.py stays untouched)."""
        try:
            import requests  # the engine already depends on it
            url = ext.SETTINGS.get("url", "")
            model = ext.SETTINGS.get("fast_model", "")
            b64 = base64.b64encode(dest.read_bytes()).decode()
            body = {
                "model": model,
                "messages": [{"role": "user", "content": "Describe this picture in two sentences.",
                              "images": [b64]}],
                "stream": False,
                "options": {"num_predict": 120},
            }
            started = time.time()
            resp = requests.post(url, json=body, timeout=float(ext.SETTINGS.get("timeout", 240)))
            resp.raise_for_status()
            text = (resp.json().get("message", {}).get("content") or "").strip()
            ms = int((time.time() - started) * 1000)
            hub = self.hub
            if text and hub:
                hub.chat.notes.add("picture", name, text[:600])
                hub.broadcast(ch="ai-note", type="file",
                              text="picture described (%d ms): %s" % (ms, text[:100]))
                self.after(0, lambda: self._file_row(name, kind, "described in %d ms, in notes" % ms))
            else:
                self.after(0, lambda: self._file_row(name, kind, text or "(empty description)"))
        except Exception as err:
            self.after(0, lambda: self._file_row(name, kind, "vision call failed: %s" % str(err)[:120]))

    def _file_row(self, name, kind, status):
        self.files_tree.insert("", "end", values=(name, kind, status))

    # -- exit ------------------------------------------------------------------------ #
    def on_close(self):
        self._persist_save()
        self.on_stop()
        self.destroy()


def main():
    app = DeskApp()
    app.protocol("WM_DELETE_WINDOW", app.on_close)
    app.mainloop()


if __name__ == "__main__":
    main()
