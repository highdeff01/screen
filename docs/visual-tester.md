# Visual tester connection

Sightline sends one screenshot plus the current workflow/proposal context to an external HTTP service. The service can return findings, suggestions and normalized screen annotations. It is a connection point, not a live input driver: Sightline never grants the external process control of the desktop through this API.

## Configure

Set the receiver URL in **Settings → Visual tester URL**, or use the environment variable:

```text
SIGHTLINE_VISUAL_TESTER_URL=http://127.0.0.1:8790/visual-test
SIGHTLINE_VISUAL_TESTER_TOKEN=optional-bearer-token
```

The token is read only from the environment and is never returned by the API. `SIGHTLINE_VISUAL_TESTER_URL` takes precedence over the saved setting.

## Request

`POST` JSON to the configured URL:

```json
{
  "protocol": "sightline-visual-test/v1",
  "type": "visual-test",
  "at": "2026-11-16T12:00:00.000Z",
  "goal": "open kiro ...",
  "expected": "optional expected state",
  "workflow": {
    "id": "wf_x",
    "name": "Kiro answer capture",
    "description": "...",
    "steps": [{ "type": "clickElement", "name": "Copy answer", "params": {} }]
  },
  "proposal": {
    "id": "prop_x",
    "confidence": 0.96,
    "stepCount": 24,
    "rejectedSteps": [],
    "backups": ["source.copy", "destination.paste"]
  },
  "step": { "type": "screenshot", "name": "Final state", "params": {} },
  "screenshot": {
    "path": "captures/run.png",
    "caption": "Final state",
    "mime": "image/png",
    "bytes": 123456,
    "width": 1920,
    "height": 1080,
    "base64": "..."
  }
}
```

## Response

Return JSON:

```json
{
  "ok": true,
  "confidence": 0.82,
  "summary": "The answer is visible, but the save button is obscured.",
  "findings": [
    { "label": "Save button", "detail": "hidden by the dialog", "step": 21, "confidence": 0.7 }
  ],
  "suggestions": [
    { "label": "Wait for save dialog", "detail": "verify the dialog before pressing ctrl+s", "step": 22 }
  ],
  "annotations": [
    { "label": "Save button", "x": 840, "y": 610, "width": 90, "height": 28, "confidence": 0.8 }
  ]
}
```

`annotations[].x/y/width/height` are screenshot pixel coordinates. Sightline draws them over the proposal thumbnail when the received `width`/`height` are available.

Sightline stores the result on the proposal (`visualTests`) and adds an `external-visual` test entry. Findings do not modify workflow steps automatically; they are evidence for the operator, and the next proposal's research pack includes them as external findings.
