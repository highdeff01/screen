"""Support file for the features that are not wired into the chat loop yet.

Nothing here changes the client unless you call attach(). Every entry in FEATURES
records whether the idea is live, a scaffold, or impossible on this endpoint and
why, so a later pass can pick one up without rediscovering the blocker.

    import fast_chat_features as ff
    ff.attach(chat)        # adds chat.try_draft / chat.build_vectors / chat.search_vectors
    ff.try_draft(chat.client, "what is pyrite")
    ff.search_vectors(ff.build_vectors(chat.notes.items), "pyrite colour")

Kept dependency-free: stdlib only, so it imports even in --demo mode.
"""

import re

STOPWORDS = frozenset(
    """
    a an and are as at be been being but by can could did do does for from had has have he her
    him his how i if in into is it its just me more most my no not of on one only or other our
    out over same she should so some such than that the their them then there these they this
    those to too under up us very was we were what when where which while who why will with you
    your
    """.split()
)


# --------------------------------------------------------------------------- #
# fast first pass: one cheap call, used before the full answer
# --------------------------------------------------------------------------- #
def try_draft(client, prompt, context="", instruction="", max_tokens=120, temperature=0.1):
    """One small call that returns a short draft answer.

    The point is latency: ~120 tokens at low temperature comes back in a fraction
    of a full answer, and the draft can be shown, criticised, or fed to the main
    call as "continue from this".
    """
    messages = [
        {
            "role": "system",
            "content": instruction
            or "Reply with the shortest useful draft answer: one or two sentences, no preamble.",
        }
    ]
    if context:
        messages.append({"role": "system", "content": "Context:\n" + str(context)[:1500]})
    messages.append({"role": "user", "content": str(prompt)})
    try:
        return client.complete(
            messages,
            max_tokens=max_tokens,
            sampling={"temperature": temperature},
            kind="draft",
            priority="background",
        ).strip()
    except Exception:  # noqa: BLE001
        return ""


# --------------------------------------------------------------------------- #
# cheap retrieval: term counts over notes/preplies, no embeddings needed
# --------------------------------------------------------------------------- #
def vectorize(text):
    """Term -> count, stopwords and short tokens dropped."""
    words = [
        word
        for word in re.findall(r"[a-z0-9']+", str(text).lower())
        if len(word) > 2 and word not in STOPWORDS
    ]
    counts = {}
    for word in words:
        counts[word] = counts.get(word, 0) + 1
    return counts


def build_vectors(items):
    """Build searchable vectors from notes/preplies items (dicts with id/title/text)."""
    vectors = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        body = str(item.get("text") or item.get("content") or "")
        counts = vectorize(body)
        if counts:
            vectors.append(
                {
                    "id": item.get("id"),
                    "title": str(item.get("title", ""))[:90],
                    "vector": counts,
                    "chars": len(body),
                }
            )
    return vectors


def search_vectors(vectors, query, limit=5):
    """Score by shared terms, weighted by how much of the query is covered."""
    wanted = vectorize(query)
    if not wanted or not vectors:
        return []
    total = sum(wanted.values())
    scored = []
    for entry in vectors:
        overlap = sum(min(count, entry["vector"].get(term, 0)) for term, count in wanted.items())
        if overlap:
            scored.append((round(overlap / total, 3), entry))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return scored[:limit]


# --------------------------------------------------------------------------- #
# what exists, what is a scaffold, and what this endpoint cannot do
# --------------------------------------------------------------------------- #
FEATURES = [
    {"name": "draft pass", "status": "live", "where": "try_draft()", "note": "one small call before the full answer"},
    {"name": "term vectors", "status": "live", "where": "build_vectors()/search_vectors()", "note": "notes + preplies, no embeddings"},
    {"name": "variations", "status": "live", "where": "Chat.best_of / /vary", "note": "early exit keeps the normal cost at one call"},
    {"name": "layers", "status": "live", "where": "Chat.refine / /layers", "note": "user-set number of rewrites"},
    {"name": "goal tracking", "status": "live", "where": "Chat.track_goal", "note": "auto-created from the first question"},
    {"name": "preplies", "status": "live", "where": "Preplies / /preply", "note": "long output set aside, appended on request"},
    {"name": "frames + readiness", "status": "live", "where": "server/automation.js, continuation-engine.js", "note": "live capture, readiness cache keyed on params"},
    {"name": "multi-read vision", "status": "live", "where": "vision_samples", "note": "consistency score across reads"},
    {"name": "parallel sampling", "status": "live", "where": "parallel setting", "note": "measured slower here: 2794 ms vs 579 ms"},
    {"name": "feedback relay", "status": "scaffold", "where": "FeedbackRelay", "note": "needs a second endpoint to review answers"},
    {"name": "agent bridge", "status": "scaffold", "where": "AgentBridge", "note": "needs another agent's API, not this client"},
    {"name": "draft pipeline", "status": "scaffold", "where": "DraftPipeline", "note": "draft -> critique -> final; steps exist, not wired"},
    {"name": "tensor stream", "status": "blocked", "where": "-", "note": "endpoint is HTTP JSON; there is no tensor channel"},
    {"name": "self-evolving weights", "status": "blocked", "where": "-", "note": "temperature and answer choice can change, the model cannot"},
    {"name": "petabyte store", "status": "blocked", "where": "chat_store.db", "note": "SQLite FTS5, disk-bound; 1611 chunks measured"},
    {"name": "live pixel capture", "status": "elsewhere", "where": "server/automation.js", "note": "liveScreenshot, modelImage, signature cache"},
]


class DraftPipeline:
    """draft -> critique -> final.

    try_draft() supplies the draft; the critique is a normal `complete` call with
    the draft attached. Deliberately not wired: on this endpoint the draft plus
    critique costs more than one direct answer, so it is a latency tool only.
    """

    def __init__(self, client):
        self.client = client

    def run(self, prompt, context=""):
        draft = try_draft(self.client, prompt, context)
        if not draft:
            return ""
        messages = [
            {"role": "system", "content": "Improve this draft answer. Keep its facts, fix its errors, add what is missing."},
            {"role": "user", "content": "Question: %s\n\nDraft:\n%s" % (prompt, draft[:1200])},
        ]
        return self.client.complete(messages, max_tokens=300, sampling={"temperature": 0.2}, kind="draft-final").strip()


class FeedbackRelay:
    """Send an answer to a second model for review.

    `endpoint` must be an OpenAI-compatible chat URL. The client's own URL is not
    used: asking the same model to grade itself mostly returns agreement.
    """

    def __init__(self, endpoint="", model=""):
        self.endpoint = endpoint
        self.model = model

    def review(self, question, answer, timeout=60):
        if not self.endpoint:
            raise RuntimeError("FeedbackRelay needs an endpoint= for the reviewing model")
        import json
        import urllib.request

        body = json.dumps(
            {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": "Find errors, repetition and anything unsupported. Be brief."},
                    {"role": "user", "content": "Q: %s\nA: %s" % (question, answer[:3000])},
                ],
                "stream": False,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint, data=body, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return (payload.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()


class AgentBridge:
    """Placeholder for a second agent: no transport is assumed here."""

    def __init__(self, send=None):
        self.send = send

    def ask(self, message):
        if self.send is None:
            raise RuntimeError("AgentBridge needs send= (a callable that takes text and returns text)")
        return self.send(message)


def attach(chat):
    """Attach the live helpers to a Chat instance without touching its loop."""
    chat.try_draft = lambda prompt, context="": try_draft(chat.client, prompt, context)
    chat.build_vectors = lambda: build_vectors(getattr(chat.notes, "items", []))
    chat.search_vectors = lambda query, limit=5: search_vectors(chat.build_vectors(), query, limit)
    return chat
