/**
 * Python files offered on the Python page. They are written into data/python on
 * boot so they can be viewed, downloaded and edited without leaving the console.
 */

export const PYTHON_FILES = [
  {
    name: 'ai_chat.py',
    purpose: 'The original Qwen/Ollama chat loop: keeps conversation history, retries cleanly and prints UTF-8 on Windows.',
    code: `"""Chat with the Sightline model and keep a local conversation history.

Runs on Python 3.8+, needs only "requests".
Endpoint and model can be overridden with environment variables.
"""

import json
import os
import sys

if sys.platform == "win32":
    import codecs

    sys.stdout = codecs.getwriter("utf-8")(sys.stdout.detach())
    sys.stderr = codecs.getwriter("utf-8")(sys.stderr.detach())

try:
    import requests
except ImportError:
    sys.exit("Install requests first:  python -m pip install requests")

ENDPOINT = os.environ.get("SIGHTLINE_AI_URL", "https://quantumclaw.net/ollama/api/chat")
MODEL = os.environ.get("SIGHTLINE_MODEL", "qwen3.5:2b")
HISTORY_FILE = os.environ.get("SIGHTLINE_HISTORY", "conversation_history.txt")


class LLM:
    def __init__(self):
        self.messages = self.load_history()

    def get_ai_response(self, user_message):
        self.messages.append({"role": "user", "content": user_message})
        body = {
            "model": MODEL,
            "messages": self.messages,
            "stream": False,
            # Reasoning models can spend the whole reply on hidden thinking and
            # return empty content. The console disables thinking for tool calls.
            "think": False,
        }
        try:
            response = requests.post(ENDPOINT, json=body, timeout=90)
            response.raise_for_status()
            data = response.json()
            content = (data.get("message") or {}).get("content", "").strip()
            if not content:
                print("The model returned an empty reply. Try a shorter prompt.")
                return None
            self.messages.append({"role": "assistant", "content": content})
            self.save_history()
            return content
        except requests.exceptions.RequestException as exc:
            print("Request failed: {}".format(exc))
        except json.JSONDecodeError as exc:
            print("Could not decode the response: {}".format(exc))
        except Exception as exc:  # noqa: BLE001 - keep the chat loop alive
            print("Unexpected error: {}".format(exc))
        return None

    def save_history(self):
        try:
            with open(HISTORY_FILE, "w", encoding="utf-8") as handle:
                json.dump(self.messages, handle, indent=2, ensure_ascii=False)
        except OSError as exc:
            print("Could not save history: {}".format(exc))

    def load_history(self):
        try:
            if os.path.exists(HISTORY_FILE):
                with open(HISTORY_FILE, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
                if isinstance(data, list):
                    return [m for m in data if m.get("role") in ("user", "assistant")]
        except (OSError, json.JSONDecodeError, AttributeError) as exc:
            print("Could not load history: {}".format(exc))
        return []


def main():
    llm = LLM()
    print("Model: {} via {}".format(MODEL, ENDPOINT))
    print("Type 'quit' to exit. Press Ctrl+C at any time.")
    while True:
        try:
            message = input("You: ")
            if message.strip().lower() in ("quit", "exit"):
                break
            reply = llm.get_ai_response(message)
            if reply:
                print("AI:", reply)
        except (KeyboardInterrupt, EOFError):
            print("\\nBye.")
            break


if __name__ == "__main__":
    main()
`,
  },
  {
    name: 'sightline_client.py',
    purpose: 'Stdlib-only client for the local console API: list workflows, queue a run, poll it and download evidence.',
    code: `"""Minimal client for the Sightline console (standard library only).

Examples:
    python sightline_client.py list
    python sightline_client.py run wf_notepad_smoke --mode dry
    python sightline_client.py watch run_abc123
    python sightline_client.py evidence run_abc123
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("SIGHTLINE_BASE", "http://127.0.0.1:4317")


def call(path, method="GET", payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit("HTTP {} for {}: {}".format(exc.code, path, body))
    except urllib.error.URLError as exc:
        raise SystemExit("Cannot reach {}. Is the console running? ({})".format(BASE, exc.reason))


def list_workflows():
    state = call("/api/state")
    for workflow in state["workflows"]:
        print("{:<22} {:<8} {:>2} steps  {}".format(
            workflow["id"], workflow["status"], len(workflow["steps"]), workflow["name"]))
    return state["workflows"]


def start_run(workflow_id, mode="dry", trigger="manual"):
    result = call("/api/workflows/{}/runs".format(urllib.parse.quote(workflow_id)), "POST",
                  {"mode": mode, "trigger": trigger})
    run = result["run"]
    print("Queued {} ({})".format(run["id"], "live" if mode == "live" else "simulated"))
    return run["id"]


def watch(run_id, interval=1.5, timeout=600):
    deadline = time.time() + timeout
    while time.time() < deadline:
        run = call("/api/runs/{}".format(urllib.parse.quote(run_id)))["run"]
        if run["status"] not in ("queued", "running"):
            break
        time.sleep(interval)
    print("Run {} finished: {}".format(run["id"], run["status"].upper()))
    for index, step in enumerate(run["steps"], start=1):
        marker = {"passed": "PASS", "failed": "FAIL", "skipped": "SKIP"}.get(step["status"], "....")
        print("  {:>2}. [{}] {}".format(index, marker, step["name"]))
        if step.get("error"):
            print("      error: {}".format(step["error"]))
    for evidence in run.get("evidence", []):
        print("  evidence: {} -> {}".format(evidence.get("caption"), evidence.get("path")))
    if run.get("analysis"):
        print("  diagnosis: {}".format(run["analysis"].get("summary")))
    return run


def download_evidence(run_id, directory="evidence"):
    run = call("/api/runs/{}".format(urllib.parse.quote(run_id)))["run"]
    os.makedirs(directory, exist_ok=True)
    saved = []
    for evidence in run.get("evidence", []):
        path = evidence.get("path")
        if not path:
            continue
        url = "{}/api/files/raw?path={}".format(BASE, urllib.parse.quote(path))
        target = os.path.join(directory, os.path.basename(path))
        with urllib.request.urlopen(url, timeout=60) as response, open(target, "wb") as handle:
            handle.write(response.read())
        saved.append(target)
        print("Saved {}".format(target))
    return saved


def main(argv):
    if not argv or argv[0] == "list":
        list_workflows()
    elif argv[0] == "run" and len(argv) > 1:
        mode = "dry"
        if "--mode" in argv:
            mode = argv[argv.index("--mode") + 1]
        watch(start_run(argv[1], mode))
    elif argv[0] == "watch" and len(argv) > 1:
        watch(argv[1])
    elif argv[0] == "evidence" and len(argv) > 1:
        download_evidence(argv[1])
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
`,
  },
  {
    name: 'batch_runner.py',
    purpose: 'Queue several workflows in order, wait for each and write a markdown report with evidence paths.',
    code: `"""Run a batch of Sightline workflows and write a markdown report.

Usage:
    python batch_runner.py wf_notepad_smoke ex_address_bar --mode dry

Workflow ids come from the console (Test runs name or API state). The report is
written next to this script as batch-report.md.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sightline_client as client  # noqa: E402


def main(argv):
    mode = "dry"
    if "--mode" in argv:
        index = argv.index("--mode")
        mode = argv[index + 1]
        argv = argv[:index] + argv[index + 2:]
    if not argv:
        print(__doc__)
        return

    lines = ["# Sightline batch report", "", "Mode: **{}**".format(mode), ""]
    failures = 0
    for workflow_id in argv:
        print("\\n== {} ==".format(workflow_id))
        try:
            run_id = client.start_run(workflow_id, mode)
            run = client.watch(run_id)
        except SystemExit as exc:
            lines.append("## {} — could not start\\n\\n{}".format(workflow_id, exc))
            failures += 1
            continue

        lines.append("## {} — {}".format(workflow_id, run["status"]))
        lines.append("")
        for step in run["steps"]:
            lines.append("- [{}] {}".format(step["status"], step["name"]))
            if step.get("error"):
                lines.append("  - error: {}".format(step["error"]))
        for evidence in run.get("evidence", []):
            lines.append("- evidence: {} (data/{})".format(evidence.get("caption"), evidence.get("path")))
        if run.get("analysis"):
            lines.append("- diagnosis: {}".format(run["analysis"].get("summary")))
        lines.append("")
        if run["status"] in ("failed", "needs_review"):
            failures += 1

    report = os.path.join(os.path.dirname(os.path.abspath(__file__)), "batch-report.md")
    with open(report, "w", encoding="utf-8") as handle:
        handle.write("\\n".join(lines))
    print("\\nReport written to {}\\n{} workflow(s), {} with failures".format(report, len(argv), failures))


if __name__ == "__main__":
    main(sys.argv[1:])
`,
  },
];
