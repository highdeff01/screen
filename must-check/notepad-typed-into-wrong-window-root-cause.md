# Notepad workflow: typed into the operator's open document — root cause and fixes

- symptom: clicking Run opened no new Notepad and typed into “*knack convo.txt - Notepad”; the expect step was skipped every time.
- root cause 1: launchApp adopted ANY existing window of the app (“focused existing …”) instead of launching a new instance.
- root cause 2: Show-SightlineFront raised “whichever window has that app name”; with the new process's window not yet visible it raised the operator's document.
- root cause 3: focusWindow and expect were skipped on loose title-contains matches, so typing targeted the wrong window and the verify never ran.
- fixes: adoption is now opt-in (reuseExisting); launch uses Start-Process -PassThru and fronts the launched process's own window (fallback to name search only for tab-hosted apps); skips require exact title match; expect/waitFor verification never skipped.
- verified live: with other Notepad windows open, the run opens a new tab, types there, and the expect step records the new window title as evidence.

Status: fix applied and verified 2026-11-18T22:07:56.366Z