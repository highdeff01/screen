# Sightline sample apps

Ten small Tk desktop programs with stable window titles and visible control
labels. They exist so a workflow can be planned and run against real windows
without pointing the console at the operator's own work.

| App | Shortcut / target | What it proves |
| --- | --- | --- |
| Accounts | `Sightline Accounts` | create an account, read the verification code from the banner and `inbox.txt`, verify, signed-in state |
| QR | `Sightline QR` | username + password, then a QR panel that must be scanned |
| Profile | `Sightline Profile` | Home → Settings → Profile → fill every field → Save profile |
| Calculator | `Sightline Calculator` | expression entry and keyboard `Enter` |
| Notes | `Sightline Notes` | type a body, save it to `note.txt` |
| Todo | `Sightline Todo` | add a task, mark it done |
| Chat | `Sightline Chat` | send a message and read the reply |
| Files | `Sightline Files` | select a file and read its preview |
| Media | `Sightline Media` | first video is unavailable; Up next holds same-topic videos |
| Store | `Sightline Store` | install buttons per app card |

## Run one app

```powershell
python .\sightline_suite.py --app accounts
python .\sightline_suite.py --app media
python .\sightline_suite.py --list
```

## Desktop icons

```powershell
powershell -ExecutionPolicy Bypass -File .\make_shortcuts.ps1
```

Creates ten `.lnk` shortcuts on the current user's Desktop, each running
`pythonw.exe sightline_suite.py --app <name>`. The console can then launch an app
by name (`launchApp { "target": "Sightline Accounts" }`) exactly like an `.exe`.

## Ten-app smoke test

```powershell
python .\smoke_test.py
```

Launches every app, waits for its window title, records the size, closes it and
prints `PASS`/`FAIL` per app plus a total. Use `--keep` to leave them open, or
name apps to check only those.

## What the sample app fixes

- Accounts always issues the demo code `482913` and writes it to `inbox.txt`, so
  a run can read the code instead of guessing it.
- Media deliberately marks its first video unavailable and lists same-topic
  videos under **Up next**, which is the courtesy route the replan uses: scroll,
  look right, choose another video — never re-enter the address.
- Profile refuses to report "saved" while any field is empty, so a half-filled
  form cannot pass.

The workflows `ex_account_email_verify`, `ex_qr_signin`,
`ex_profile_settings_save` and `ex_video_unavailable_fallback` in
`server/examples.js` are written against these apps.
