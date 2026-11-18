# Local model gateway (Respan Gateway)

Sightline can put the open-source [Respan Gateway](https://github.com/respanai/respan-gateway) between its AI features and the model provider. The gateway is a loopback OpenAI-compatible endpoint that sits in front of the provider already configured in Control → settings, so chat, planner, memory summarising and every other `chat()` caller keep the same provider and credentials while gaining named routes (`[routes."<model>"]`, `tries = 2` retries), one place to see requests, and room to point a model at a different provider later. No Respan account, hosted credits or tracing export is involved: the gateway spends the provider key the console already uses.

Gateway guide: https://github.com/respanai/respan-gateway?utm_source=freebuff&utm_medium=paid&utm_campaign=respan-gateway&bfcid=bfc_1.eyJpZCI6ImFmM2Q3ZGZhLTZlMjMtNDg1OS04NTM5LTYzOTExNWIyYjczMyIsImMiOiIyMDM2ODZkZS1mMzg0LTQ4NTQtYmViNC1hYzBiYWRmNmM1NTUiLCJrIjoiM2IxMGE4YmUtNzgyOS00MmJhLWFmNmEtYmI0YWUxZTRhY2Y4IiwiaWF0IjoxNzk1MDIxOTczfQ.ZnpFXt2tsFHqc_1E8TMXHICFGv0Uak6gXMXHuuIkhIA

## Install

The gateway is a Python 3.10+ package; the console itself stays dependency-free Node. `requirements.txt` pins it, and wheel-only installs avoid a compiler:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install --only-binary=:all: -r requirements.txt
```

`.venv/` is ignored by Git. `server/gateway.js` uses that interpreter automatically; set `SIGHTLINE_GATEWAY_PYTHON` to a full path to use another one.

## Turn it on

Set the gateway fields through the existing settings API (or any caller of it):

```powershell
Invoke-RestMethod -Method Patch http://127.0.0.1:4317/api/settings -ContentType 'application/json' -Body '{"gatewayEnabled":true}'
Invoke-RestMethod http://127.0.0.1:4317/api/gateway
```

- `gatewayEnabled` — route model calls through the local gateway. Off by default.
- `gatewayPort` — fixed loopback port; `0` picks a free one on each start.
- `gatewayKeyEnv` — optional name of the environment variable holding the provider key, written into the config as `key = "env:NAME"`. Keys never appear in source, generated config or the browser.

While it runs, `http://127.0.0.1:<port>/ui/` shows the gateway's own request log. The listener is loopback-only and no client keys are configured, so anyone who reaches that port spends your provider key: do not expose it beyond the machine.

## What it is wired to

`data/gateway.toml` is regenerated from the console's model settings on every start and is never hand-edited:

```toml
[providers.app]
vendor   = "ollama"                        # or formats = ["openai-chat"]
base_url = "http://provider-host/ollama/v1" # the provider's OpenAI-compatible root

[routes."qwen3.5:2b"]
to    = "app/qwen3.5:2b"
tries = 2
```

`server/llm.js` sends `chat()` to `http://127.0.0.1:<port>/v1/chat/completions` while the gateway is up, records `via: "gateway"` on the usage entry, and falls back to the direct endpoint (with a `[llm] gateway unavailable` warning) if the interpreter or package is missing, so the assistant never breaks because of the gateway. Stopping the console stops the child; `data/gateway.log` holds its own output, and `data/gateway.toml` its last config.

## Verify it

`npm test` runs `test/gateway.test.js`: it starts the real gateway against a local stand-in provider (no keys, no network), calls the app's own `chat()`, and asserts the reply arrives through the gateway and that the provider saw the forwarded request for the configured model; a second case proves the direct call still works with the gateway off. Observed result: all five cases pass, and the integration case reports `via: "gateway"` with the gateway answering on a free loopback port.

A live provider request was **not** verified: this environment had no provider keys and no route to the configured provider, so the smoke test used the local stand-in. Confirm with your own provider by enabling the gateway and running the normal app:

```powershell
npm start
```

The console prints `Sightline console running at http://127.0.0.1:4317`; ask the assistant anything in the UI, then check `GET /api/gateway` (`status: "running"`) and the usage entry's `via` field.