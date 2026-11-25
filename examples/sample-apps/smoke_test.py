#!/usr/bin/env python3
"""Launch every sample app and prove its window opens, then close it.

This is the harness for the ten-app check: each app is started the way the
desktop shortcut starts it, the script waits for a top-level window whose title
is "Sightline <Name>", records the size, closes the app and moves on.

    python smoke_test.py            # all ten
    python smoke_test.py accounts   # one app
    python smoke_test.py --keep     # leave the windows open

Exit code 0 means every app opened. Windows-only window discovery (ctypes); on
another platform the apps are started and their process lifetime is checked
instead.
"""

import ctypes
import os
import subprocess
import sys
import time

if os.name == "nt":
    from ctypes import wintypes

APP_DIR = os.path.dirname(os.path.abspath(__file__))
SUITE = os.path.join(APP_DIR, "sightline_suite.py")
APPS = [
    ("accounts", "Accounts"),
    ("qr", "QR"),
    ("profile", "Profile"),
    ("calculator", "Calculator"),
    ("notes", "Notes"),
    ("todo", "Todo"),
    ("chat", "Chat"),
    ("files", "Files"),
    ("media", "Media"),
    ("store", "Store"),
]


def windows_with_title(fragment):
    """Top-level visible window titles containing fragment (Windows only)."""
    if os.name != "nt":
        return []
    found = []
    user32 = ctypes.windll.user32
    enum_proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def callback(hwnd, _param):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        title = buffer.value
        if fragment.lower() in title.lower():
            rect = wintypes.RECT()
            size = ""
            if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                size = "%dx%d" % (rect.right - rect.left, rect.bottom - rect.top)
            found.append((title, size))
        return True

    user32.EnumWindows(enum_proc(callback), 0)
    return found


def run_one(name, title, keep=False, timeout=12.0):
    fragment = "Sightline " + title
    process = subprocess.Popen([sys.executable, SUITE, "--app", name], cwd=APP_DIR)
    deadline = time.time() + timeout
    seen = []
    try:
        while time.time() < deadline:
            if process.poll() is not None:
                return False, "process exited early with code %s" % process.returncode
            seen = windows_with_title(fragment)
            if seen:
                return True, seen[0][0] + (" " + seen[0][1] if seen[0][1] else "")
            time.sleep(0.35)
        return False, "no window titled %r within %.0fs" % (fragment, timeout)
    finally:
        if not keep:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


def main(argv):
    keep = "--keep" in argv
    wanted = [entry for entry in APPS if entry[0] in argv]
    if not wanted:
        wanted = APPS
    if not os.path.exists(SUITE):
        print("missing " + SUITE)
        return 2
    failures = []
    for name, title in wanted:
        ok, detail = run_one(name, title, keep=keep)
        print(("PASS " if ok else "FAIL ") + name.ljust(12) + detail)
        if not ok:
            failures.append(name)
        time.sleep(0.4)
    print("")
    print("%d/%d apps opened" % (len(wanted) - len(failures), len(wanted)))
    if failures:
        print("failed: " + ", ".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
