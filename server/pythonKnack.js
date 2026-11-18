/**
 * Extra Python utilities written into data/python on boot: Knack CSV export,
 * mission runner and error analytics.
 */

export const AUTOMATION_PYTHON_FILES = [
  {
    name: 'knack_export.py',
    purpose: 'Writes the five Knack import CSVs (workflows, steps, runs, sessions, events) from this console.',
    code: `"""Export Sightline records as Knack-ready CSV files.

Usage:
    python knack_export.py
    python knack_export.py --base-url http://127.0.0.1:4317 --out knack-import
    python knack_export.py --include-mapping

Import the files in this order, matching on the *_id columns:
    1. workflows.csv   2. steps.csv   3. runs.csv   4. sessions.csv   5. events.csv
Knack creates fields and pages in Builder only; this script never changes schema.
"""

import argparse
import csv
import json
import os
import sys
import urllib.request


def get_json(base, path):
    with urllib.request.urlopen(base + path, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


ORDER = ["workflows", "steps", "runs", "sessions", "events"]


def write_csv(path, rows):
    if not rows:
        return 0
    columns = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description="Export Sightline records for Knack import")
    parser.add_argument("--base-url", default=os.environ.get("SIGHTLINE_URL", "http://127.0.0.1:4317"))
    parser.add_argument("--out", default="knack-import")
    parser.add_argument("--include-mapping", action="store_true", help="also write knack-mapping.json")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    try:
        payload = get_json(base, "/api/knack/records")
    except Exception as exc:
        sys.exit("Could not reach {}: {}".format(base, exc))
    records = payload.get("records", {})
    os.makedirs(args.out, exist_ok=True)

    total = 0
    for name in ORDER:
        rows = records.get(name) or []
        path = os.path.join(args.out, name + ".csv")
        count = write_csv(path, rows)
        total += count
        print("{:<10} {:>5} rows -> {}".format(name, count, path))

    if args.include_mapping:
        mapping = get_json(base, "/api/knack")
        path = os.path.join(args.out, "knack-mapping.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(mapping, handle, indent=2)
        print("mapping   -> {}".format(path))

    print("\\n{} rows exported. Import in this order: {}.".format(total, ", ".join(ORDER)))
    print("Copy each field's API key from Knack Builder into server/knack.js (knackField).")


if __name__ == "__main__":
    main()
`,
  },
  {
    name: 'mission_runner.py',
    purpose: 'Launch a Command Center mission, stream agent events and print the verdict and review.',
    code: `"""Launch a supervised mission and follow its agent events.

Usage:
    python mission_runner.py --workflow wf_notepad_smoke --goal "Open Notepad and confirm the window"
    python mission_runner.py --workflow wf_notepad_smoke --mode dry --attempts 2 --vision
    python mission_runner.py --id msn_abc123 --follow
    python mission_runner.py --id msn_abc123 --cancel

Exit code is 0 when the mission ends passed, 2 when it fails or is cancelled.
"""

import argparse
import json
import os
import sys
import time
import urllib.request

TERMINAL = {"passed", "failed", "cancelled", "needs_review"}


def api(base, path, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        base + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    parser = argparse.ArgumentParser(description="Run a Sightline mission from the terminal")
    parser.add_argument("--base-url", default=os.environ.get("SIGHTLINE_URL", "http://127.0.0.1:4317"))
    parser.add_argument("--workflow", help="workflow id (see /api/state)")
    parser.add_argument("--goal", default="", help="what must be true at the end")
    parser.add_argument("--mode", choices=["dry", "live"], default="dry")
    parser.add_argument("--attempts", type=int, default=2)
    parser.add_argument("--vision", action="store_true")
    parser.add_argument("--id", dest="mission_id", help="follow an existing mission")
    parser.add_argument("--follow", action="store_true", help="keep streaming events")
    parser.add_argument("--cancel", action="store_true", help="cancel the mission instead of launching")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")

    if args.cancel:
        if not args.mission_id:
            sys.exit("--cancel needs --id")
        result = api(base, "/api/missions/" + args.mission_id + "/cancel", "POST", {})
        print("cancel:", result.get("mission", {}).get("status"))
        return 0

    mission_id = args.mission_id
    if not mission_id:
        if not args.workflow:
            sys.exit("Give --workflow or --id")
        created = api(
            base,
            "/api/missions",
            "POST",
            {
                "workflowId": args.workflow,
                "goal": args.goal,
                "mode": args.mode,
                "conditions": {
                    "maxAttempts": max(1, min(4, args.attempts)),
                    "vision": bool(args.vision),
                    "autoReplan": True,
                    "useLearnedPatterns": True,
                },
            },
        )
        if not created.get("ok"):
            sys.exit("Mission not created: {}".format(created.get("error")))
        mission_id = created["mission"]["id"]
        print("mission:", mission_id)

    seen = set()
    while True:
        detail = api(base, "/api/missions/" + mission_id)
        if not detail.get("ok"):
            sys.exit("Mission not found: " + mission_id)
        mission = detail["mission"]
        for event in reversed(mission.get("events", [])):
            if event["id"] in seen:
                continue
            seen.add(event["id"])
            print("[{:<10} {:<12}] {}".format(event.get("agent", "-"), event.get("kind", "-"), event.get("message", "")))
        if mission["status"] in TERMINAL:
            verdict = (mission.get("verification") or {}).get("verdict", "-")
            review = (mission.get("review") or {}).get("summary", "")
            print("\\nstatus: {} | attempts: {}/{} | verdict: {}".format(
                mission["status"], mission.get("attempts"), mission.get("maxAttempts"), verdict))
            if review:
                print("review: " + review)
            return 0 if mission["status"] == "passed" else 2
        if not args.follow and mission["status"] in ("queued", "planning"):
            print("Launched. Follow with: python mission_runner.py --id {} --follow".format(mission_id))
            return 0
        time.sleep(1.5)


if __name__ == "__main__":
    sys.exit(main())
`,
  },
  {
    name: 'error_analytics.py',
    purpose: 'Retry, failure-category and pattern-tag analytics across runs and missions.',
    code: `"""Report retries, failure categories and pattern-tag performance.

Usage:
    python error_analytics.py
    python error_analytics.py --base-url http://127.0.0.1:4317 --json report.json
"""

import argparse
import json
import os
import sys
import urllib.request
from collections import Counter, defaultdict


def get_json(base, path):
    with urllib.request.urlopen(base + path, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    parser = argparse.ArgumentParser(description="Retry and failure analytics for Sightline")
    parser.add_argument("--base-url", default=os.environ.get("SIGHTLINE_URL", "http://127.0.0.1:4317"))
    parser.add_argument("--json", dest="json_path", help="write the raw report to this file")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    try:
        state = get_json(base, "/api/state")
        missions = get_json(base, "/api/missions").get("missions", [])
    except Exception as exc:
        sys.exit("Could not reach {}: {}".format(base, exc))

    runs = state.get("runs", [])
    workflows = {w["id"]: w for w in state.get("workflows", [])}

    by_workflow = defaultdict(lambda: {"runs": 0, "retries": 0, "failed": 0, "recovered": 0})
    categories = Counter()
    tag_stats = defaultdict(lambda: {"runs": 0, "retries": 0, "passed": 0})

    for run in runs:
        entry = by_workflow[run.get("workflowName", run.get("workflowId", "?"))]
        entry["runs"] += 1
        entry["retries"] += int(run.get("retryCount") or 0)
        if run.get("status") == "failed":
            entry["failed"] += 1
        if run.get("recovered"):
            entry["recovered"] += 1
        categories[run.get("errorCategory") or "none"] += 1

        tags = run.get("patternTags") or []
        if not tags:
            tags = (workflows.get(run.get("workflowId"), {}) or {}).get("patternTags") or []
        for tag in tags:
            stats = tag_stats[str(tag).strip().lower()]
            stats["runs"] += 1
            stats["retries"] += int(run.get("retryCount") or 0)
            if run.get("status") == "passed":
                stats["passed"] += 1

    print("== Runs by workflow ==")
    print("{:<28} {:>5} {:>8} {:>7} {:>10}".format("workflow", "runs", "retries", "failed", "recovered"))
    for name, entry in sorted(by_workflow.items(), key=lambda item: -item[1]["retries"]):
        print("{:<28} {:>5} {:>8} {:>7} {:>10}".format(name[:28], entry["runs"], entry["retries"], entry["failed"], entry["recovered"]))

    print("\\n== Failure categories ==")
    for category, count in categories.most_common():
        print("{:<20} {}".format(category, count))

    print("\\n== Pattern tags ==")
    print("{:<24} {:>5} {:>8} {:>7} {:>8}".format("tag", "runs", "retries", "passed", "pass %"))
    for tag, stats in sorted(tag_stats.items(), key=lambda item: -item[1]["runs"]):
        rate = (100.0 * stats["passed"] / stats["runs"]) if stats["runs"] else 0
        print("{:<24} {:>5} {:>8} {:>7} {:>7.0f}%".format(tag, stats["runs"], stats["retries"], stats["passed"], rate))

    retried_missions = [m for m in missions if int(m.get("attempts") or 0) > 1]
    print("\\n== Missions ==")
    print("{} sessions, {} used more than one attempt".format(len(missions), len(retried_missions)))
    for mission in retried_missions[:10]:
        print("- {} {} {}/{} {}".format(
            mission["id"], mission["status"], mission.get("attempts"), mission.get("maxAttempts"), mission.get("workflowName")))

    report = {
        "runs": len(runs),
        "retriedRuns": sum(1 for run in runs if int(run.get("retryCount") or 0) > 0),
        "recoveredRuns": sum(1 for run in runs if run.get("recovered")),
        "byWorkflow": by_workflow,
        "categories": categories,
        "tags": tag_stats,
        "missions": missions,
    }
    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, default=dict)
        print("\\nreport -> " + args.json_path)


if __name__ == "__main__":
    main()
`,
  },
  {
    name: 'agents_orchestrator.py',
    purpose: 'Compact supervisor main loop: plan, dispatch, verify, replan and review a mission.',
    code: `"""Compact supervisor main loop for the multi-agent chain.

States: plan -> dispatch -> verify -> replan -> rerun -> review.
The loop delegates the actual agents to Sightline's mission API and only decides
when to replan, pause/resume or start a fresh attempt budget.

Usage:
    python agents_orchestrator.py --workflow wf_desktop_browser_chain --goal "Sign in and verify the token"
    python agents_orchestrator.py --workflow ... --mode live --rounds 2 --admin-password sightline-admin
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

TERMINAL = {"passed", "cancelled"}


def request(base, path, method="GET", body=None, cookie=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError("{} {}: {}".format(method, path, detail[:200]))


def login(base, username, password):
    data = json.dumps({"username": username, "password": password}).encode("utf-8")
    req = urllib.request.Request(base + "/api/auth/login", data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as response:
        cookie = response.headers.get("Set-Cookie", "").split(";")[0]
    return {"Cookie": cookie} if cookie else {}


def supervisor_loop(base, workflow_id, goal, mode="dry", attempts=2, rounds=3, cookie=None, poll=1.5):
    """Plan, dispatch, verify, replan and review with a bounded budget."""
    created = request(
        base,
        "/api/missions",
        "POST",
        {
            "workflowId": workflow_id,
            "goal": goal,
            "mode": mode,
            "conditions": {"maxAttempts": attempts, "autoReplan": True, "useLearnedPatterns": True},
        },
        cookie,
    )
    mission_id = created["mission"]["id"]
    print("session:", mission_id)
    seen, replans, paused_for = set(), 0, False

    while True:
        mission = request(base, "/api/missions/" + mission_id)["mission"]
        for event in reversed(mission.get("events", [])):
            if event["id"] in seen:
                continue
            seen.add(event["id"])
            print("[{:<10} {:<12}] {}".format(event.get("agent", "-"), event.get("kind", "-"), event.get("message", "")))

        status = mission["status"]
        if status in TERMINAL:
            verdict = (mission.get("verification") or {}).get("verdict", "-")
            print("done: {} after {} attempt(s), verdict {}".format(status, mission.get("attempts"), verdict))
            return mission

        if mission.get("paused") and not paused_for:
            request(base, "/api/missions/" + mission_id + "/resume", "POST", {}, cookie)
            paused_for = True
            print("resumed paused session")

        if status == "failed":
            if replans >= rounds:
                print("budget exhausted after {} replan round(s)".format(replans))
                return mission
            replans += 1
            if cookie:
                request(base, "/api/missions/" + mission_id + "/command", "POST", {"command": "FORCE_REPLAN", "reason": "Supervisor loop repair"}, cookie)
            else:
                request(base, "/api/missions/" + mission_id + "/replan", "POST", {}, cookie)
            retried = request(base, "/api/missions/" + mission_id + "/retry", "POST", {}, cookie)["mission"]
            mission_id = retried["id"]
            seen.clear()
            paused_for = False
            print("new attempt budget ->", mission_id)
            continue

        verdict = (mission.get("verification") or {}).get("verdict")
        if verdict == "off_target" and replans < rounds and status not in ("planning", "replanning"):
            replans += 1
            if cookie:
                request(base, "/api/missions/" + mission_id + "/command", "POST", {"command": "FORCE_REPLAN", "reason": "Verifier off target"}, cookie)
            else:
                request(base, "/api/missions/" + mission_id + "/replan", "POST", {}, cookie)
            print("off target -> replan {}/{}".format(replans, rounds))

        time.sleep(poll)


def main():
    parser = argparse.ArgumentParser(description="Compact supervisor loop for a multi-agent mission")
    parser.add_argument("--base-url", default=os.environ.get("SIGHTLINE_URL", "http://127.0.0.1:4317"))
    parser.add_argument("--workflow", required=True)
    parser.add_argument("--goal", default="Complete the workflow and verify the result")
    parser.add_argument("--mode", choices=["dry", "live"], default="dry")
    parser.add_argument("--attempts", type=int, default=2)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--poll", type=float, default=1.5)
    parser.add_argument("--admin-user", default="admin")
    parser.add_argument("--admin-password", help="optional: sign in so the loop can FORCE_REPLAN")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    cookie = None
    if args.admin_password:
        headers = login(base, args.admin_user, args.admin_password)
        cookie = headers.get("Cookie")
        print("admin signed in" if cookie else "admin login returned no cookie")
    mission = supervisor_loop(base, args.workflow, args.goal, args.mode, args.attempts, args.rounds, cookie, args.poll)
    return 0 if mission.get("status") == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
`,
  },
  {
    name: 'server_probe.py',
    purpose: 'Detect server, model endpoint, auth and storage connections; prints a PASS/FAIL table.',
    code: `"""Check every connection the console depends on.

Usage:
    python server_probe.py
    python server_probe.py --base-url http://127.0.0.1:4317 --json
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def get(base, path, timeout=15):
    with urllib.request.urlopen(base + path, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    parser = argparse.ArgumentParser(description="Probe Sightline server connections")
    parser.add_argument("--base-url", default=os.environ.get("SIGHTLINE_URL", "http://127.0.0.1:4317"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")

    checks = []

    def check(name, fn):
        try:
            detail = fn()
            checks.append({"check": name, "status": "PASS", "detail": detail})
        except Exception as exc:
            checks.append({"check": name, "status": "FAIL", "detail": str(exc)[:180]})

    check("console", lambda: "pid {}".format(get(base, "/api/state")["platform"]["pid"]))
    check("model", lambda: "{} / {} · {} model(s)".format(
        get(base, "/api/health").get("model"),
        get(base, "/api/health").get("online") and "online" or "offline",
        get(base, "/api/health").get("models", 0)))
    check("auth", lambda: "admin={} signed_in={}".format(
        get(base, "/api/auth/status").get("defaultUser"), get(base, "/api/auth/status").get("authenticated")))
    check("workspace", lambda: "{} workflow(s), {} run(s)".format(
        len(get(base, "/api/state")["workflows"]), len(get(base, "/api/state")["runs"])))
    check("files", lambda: "{} data file(s)".format(len(get(base, "/api/files")["files"])))
    check("python", lambda: "{} file(s)".format(len(get(base, "/api/python")["files"])))
    check("knack", lambda: "{} field(s), {} object(s)".format(
        get(base, "/api/knack")["counts"]["fields"], get(base, "/api/knack")["counts"]["objects"]))

    if args.json:
        print(json.dumps({"base": base, "checks": checks}, indent=2))
    else:
        for row in checks:
            print("{:<10} {:<10} {}".format(row["status"], row["check"], row["detail"]))
    failures = [row for row in checks if row["status"] == "FAIL"]
    print()
    print("{} check(s), {} failure(s)".format(len(checks), len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
`,
  },
];
