# Recurring app action/error — http-error
- signature: `server:http-error:run not found`
- seen: **2×**, first 2026-11-18T21:46:34.661Z, last 2026-11-18T21:46:36.849Z
- status: fix-suggested (AI suggestion drafted, see below)
## Error
```
Run not found
```
## Context
```json
{
  "code": 400
}
```
## AI suggestion

The script is trying to run a non-existent command `run` on the target system. This likely means the automation tool lacks permissions or the target environment doesn't support that specific action. You should add an explicit check in your code to verify if the `run` command exists before executing it, or remove the execution logic entirely if it's not required.

## Notes for the fixer

(append findings here; auto-sync carries this file to GitHub and back)
