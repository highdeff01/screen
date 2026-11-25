#!/usr/bin/env python3
"""Sightline sample apps: ten small desktop programs the console can drive.

Every app is a plain Tk window with a stable title ("Sightline <Name>") and
visible control labels, so element-based steps (clickElement by name) work the
same way they do in a real product. They cover the flows the planner is asked to
build: account creation with an emailed code, QR two-factor sign-in, a settings
profile form with Save, a calculator, and a media page whose first video is
unavailable so the courtesy route (scroll, Up next, same topic) can be exercised.

Run one app:

    python sightline_suite.py --app accounts
    python sightline_suite.py --app qr
    python sightline_suite.py --app profile
    python sightline_suite.py --app calculator
    python sightline_suite.py --app media
    ...

List the names with:

    python sightline_suite.py --list

No network, no credentials, no files outside this folder except inbox.txt and
note.txt, which the Accounts and Notes apps write here on purpose.
"""

import argparse
import hashlib
import os
import sys
import tkinter as tk
from tkinter import ttk

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DEMO_CODE = "482913"
DEMO_USER = "dana"
DEMO_PASSWORD = "demo-password-1"

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


def base_window(name, size="760x520"):
    root = tk.Tk()
    root.title("Sightline " + name)
    root.geometry(size)
    root.minsize(560, 380)
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass
    style.configure("Title.TLabel", font=("Segoe UI", 16, "bold"))
    style.configure("Hint.TLabel", foreground="#555555")
    style.configure("Good.TLabel", foreground="#1a7f37", font=("Segoe UI", 11, "bold"))
    style.configure("Bad.TLabel", foreground="#b42318", font=("Segoe UI", 11, "bold"))
    return root


def label(parent, text, style=None):
    return ttk.Label(parent, text=text, style=style) if style else ttk.Label(parent, text=text)


def field(parent, row, name, show=None, width=34):
    ttk.Label(parent, text=name).grid(row=row, column=0, sticky="w", padx=12, pady=6)
    entry = ttk.Entry(parent, width=width, show=show) if show else ttk.Entry(parent, width=width)
    entry.grid(row=row, column=1, sticky="we", padx=12, pady=6)
    return entry


# ---------------------------------------------------------------- accounts


class AccountsApp:
    """Create account -> verification code -> verify -> signed in."""

    def __init__(self, root):
        self.root = root
        self.user = ""
        self.notebook = ttk.Notebook(root)
        self.notebook.pack(fill="both", expand=True, padx=12, pady=12)

        self.signup = ttk.Frame(self.notebook)
        self.notebook.add(self.signup, text="Create account")
        ttk.Label(self.signup, text="Create your account", style="Title.TLabel").grid(
            row=0, column=0, columnspan=2, sticky="w", padx=12, pady=(14, 4)
        )
        ttk.Label(self.signup, text="Demo app - the password is a placeholder.", style="Hint.TLabel").grid(
            row=1, column=0, columnspan=2, sticky="w", padx=12, pady=(0, 10)
        )
        self.username = field(self.signup, 2, "Username")
        self.email = field(self.signup, 3, "Email")
        self.password = field(self.signup, 4, "Password", show="*")
        ttk.Button(self.signup, text="Create account", command=self.create).grid(
            row=5, column=0, columnspan=2, sticky="we", padx=12, pady=14
        )
        self.signup_status = ttk.Label(self.signup, text="", style="Bad.TLabel")
        self.signup_status.grid(row=6, column=0, columnspan=2, sticky="w", padx=12)

        self.verify = ttk.Frame(self.notebook)
        self.notebook.add(self.verify, text="Verify email")
        ttk.Label(self.verify, text="Check your inbox", style="Title.TLabel").grid(
            row=0, column=0, columnspan=2, sticky="w", padx=12, pady=(14, 4)
        )
        self.banner = ttk.Label(self.verify, text="Create the account first.", style="Hint.TLabel")
        self.banner.grid(row=1, column=0, columnspan=2, sticky="w", padx=12, pady=(0, 10))
        self.code = field(self.verify, 2, "Verification code")
        ttk.Button(self.verify, text="Verify", command=self.verify_code).grid(
            row=3, column=0, columnspan=2, sticky="we", padx=12, pady=14
        )
        self.verify_status = ttk.Label(self.verify, text="", style="Bad.TLabel")
        self.verify_status.grid(row=4, column=0, columnspan=2, sticky="w", padx=12)

    def create(self):
        user = self.username.get().strip()
        email = self.email.get().strip()
        password = self.password.get().strip()
        if not user or not email or not password:
            self.signup_status.configure(text="Username, email and password are required.")
            return
        if "@" not in email:
            self.signup_status.configure(text="That email address is not valid.")
            return
        self.user = user
        self.signup_status.configure(text="")
        self.banner.configure(text="Verification code: " + DEMO_CODE + "  (also written to inbox.txt)", style="Good.TLabel")
        try:
            with open(os.path.join(APP_DIR, "inbox.txt"), "w", encoding="utf-8") as handle:
                handle.write("To: " + email + "\nSubject: Verify your Sightline account\n\nYour verification code is " + DEMO_CODE + "\n")
        except OSError:
            pass
        self.notebook.select(self.verify)

    def verify_code(self):
        if not self.user:
            self.verify_status.configure(text="Create the account first.")
            return
        if self.code.get().strip() != DEMO_CODE:
            self.verify_status.configure(text="That code is not correct.")
            return
        self.verify_status.configure(text="Signed in as " + self.user, style="Good.TLabel")
        self.notebook.select(self.signup)
        self.signup_status.configure(text="Signed in as " + self.user, style="Good.TLabel")


# ---------------------------------------------------------------------- qr


class QrApp:
    """Username and password, then a QR code that must be scanned."""

    def __init__(self, root):
        self.root = root
        self.user = ""
        self.form = ttk.Frame(root)
        self.form.pack(fill="both", expand=True, padx=12, pady=12)
        ttk.Label(self.form, text="Sign in", style="Title.TLabel").grid(row=0, column=0, columnspan=2, sticky="w", padx=12, pady=(14, 4))
        ttk.Label(self.form, text="Then scan the QR code to finish.", style="Hint.TLabel").grid(
            row=1, column=0, columnspan=2, sticky="w", padx=12, pady=(0, 10)
        )
        self.username = field(self.form, 2, "Username")
        self.password = field(self.form, 3, "Password", show="*")
        ttk.Button(self.form, text="Sign in", command=self.sign_in).grid(row=4, column=0, columnspan=2, sticky="we", padx=12, pady=14)
        self.status = ttk.Label(self.form, text="", style="Bad.TLabel")
        self.status.grid(row=5, column=0, columnspan=2, sticky="w", padx=12)

        self.qr_frame = ttk.Frame(root)
        ttk.Label(self.qr_frame, text="Scan this code", style="Title.TLabel").pack(anchor="w", padx=12, pady=(14, 4))
        self.canvas = tk.Canvas(self.qr_frame, width=252, height=252, background="white", highlightthickness=1, highlightbackground="#cccccc")
        self.canvas.pack(padx=12, pady=8)
        ttk.Button(self.qr_frame, text="I scanned the code", command=self.scanned).pack(fill="x", padx=12, pady=6)
        self.qr_status = ttk.Label(self.qr_frame, text="", style="Good.TLabel")
        self.qr_status.pack(anchor="w", padx=12, pady=6)

    def sign_in(self):
        user = self.username.get().strip()
        password = self.password.get().strip()
        if not user or not password:
            self.status.configure(text="Username and password are required.")
            return
        self.user = user
        self.form.pack_forget()
        self.qr_frame.pack(fill="both", expand=True)
        self.draw_code(user + ":" + password)

    def draw_code(self, seed):
        digest = hashlib.sha256(seed.encode("utf-8")).digest()
        cells = 21
        size = 252 // cells
        self.canvas.delete("all")
        for y in range(cells):
            for x in range(cells):
                bit = digest[(y * cells + x) % len(digest)] >> ((x + y) % 8) & 1
                corner = (x < 7 and y < 7) or (x >= cells - 7 and y < 7) or (x < 7 and y >= cells - 7)
                if bit or corner:
                    self.canvas.create_rectangle(x * size, y * size, (x + 1) * size, (y + 1) * size, fill="black", outline="")

    def scanned(self):
        self.qr_status.configure(text="Signed in as " + self.user)


# ----------------------------------------------------------------- profile


class ProfileApp:
    """Home -> Settings -> Profile -> fill every field -> Save profile."""

    def __init__(self, root):
        self.root = root
        self.home = ttk.Frame(root)
        self.home.pack(fill="both", expand=True, padx=12, pady=12)
        ttk.Label(self.home, text="Sightline Profile", style="Title.TLabel").pack(anchor="w", padx=12, pady=(14, 4))
        ttk.Label(self.home, text="Open Settings to edit your profile.", style="Hint.TLabel").pack(anchor="w", padx=12, pady=(0, 12))
        ttk.Button(self.home, text="Settings", command=self.open_settings).pack(anchor="w", padx=12)

        self.nav = ttk.Frame(root)
        ttk.Label(self.nav, text="Settings", style="Title.TLabel").pack(anchor="w", padx=12, pady=(14, 4))
        ttk.Button(self.nav, text="Profile", command=self.open_profile).pack(anchor="w", padx=12, pady=4)
        ttk.Button(self.nav, text="Notifications", command=lambda: None).pack(anchor="w", padx=12, pady=4)

        self.form = ttk.Frame(root)
        ttk.Label(self.form, text="Profile", style="Title.TLabel").grid(row=0, column=0, columnspan=2, sticky="w", padx=12, pady=(14, 4))
        self.name = field(self.form, 1, "Full name")
        self.email = field(self.form, 2, "Email")
        self.bio = field(self.form, 3, "Bio")
        self.zone = field(self.form, 4, "Time zone")
        ttk.Button(self.form, text="Save profile", command=self.save).grid(row=5, column=0, columnspan=2, sticky="we", padx=12, pady=14)
        self.status = ttk.Label(self.form, text="", style="Good.TLabel")
        self.status.grid(row=6, column=0, columnspan=2, sticky="w", padx=12)

    def open_settings(self):
        self.home.pack_forget()
        self.nav.pack(fill="both", expand=True)

    def open_profile(self):
        self.nav.pack_forget()
        self.form.pack(fill="both", expand=True)

    def save(self):
        values = {
            "Full name": self.name.get().strip(),
            "Email": self.email.get().strip(),
            "Bio": self.bio.get().strip(),
            "Time zone": self.zone.get().strip(),
        }
        empty = [key for key, value in values.items() if not value]
        if empty:
            self.status.configure(text="Still empty: " + ", ".join(empty), style="Bad.TLabel")
            return
        self.status.configure(text="Profile saved for " + values["Full name"], style="Good.TLabel")


# -------------------------------------------------------------- calculator


class CalculatorApp:
    def __init__(self, root):
        self.root = root
        self.expression = tk.StringVar(value="")
        display = ttk.Entry(root, textvariable=self.expression, font=("Consolas", 20), justify="right")
        display.pack(fill="x", padx=12, pady=12)
        grid = ttk.Frame(root)
        grid.pack(fill="both", expand=True, padx=12, pady=(0, 12))
        keys = [
            ["7", "8", "9", "/"],
            ["4", "5", "6", "*"],
            ["1", "2", "3", "-"],
            ["0", ".", "=", "+"],
        ]
        for row, entries in enumerate(keys):
            for column, key in enumerate(entries):
                ttk.Button(grid, text=key, command=lambda value=key: self.press(value)).grid(
                    row=row, column=column, sticky="nsew", padx=3, pady=3, ipady=10
                )
                grid.columnconfigure(column, weight=1)
            grid.rowconfigure(row, weight=1)
        ttk.Button(root, text="Clear", command=self.clear).pack(fill="x", padx=12, pady=(0, 12))
        root.bind("<Return>", lambda _event: self.press("="))

    def press(self, key):
        if key == "=":
            try:
                result = eval(self.expression.get(), {"__builtins__": {}}, {})
                self.expression.set(str(result))
            except Exception:
                self.expression.set("Error")
            return
        self.expression.set(self.expression.get() + key)

    def clear(self):
        self.expression.set("")


# ------------------------------------------------------------------- notes


class NotesApp:
    def __init__(self, root):
        self.root = root
        ttk.Label(root, text="Notes", style="Title.TLabel").pack(anchor="w", padx=12, pady=(14, 4))
        self.text = tk.Text(root, height=14, wrap="word", font=("Segoe UI", 11))
        self.text.pack(fill="both", expand=True, padx=12, pady=8)
        ttk.Button(root, text="Save note", command=self.save).pack(anchor="w", padx=12, pady=(0, 6))
        self.status = ttk.Label(root, text="", style="Good.TLabel")
        self.status.pack(anchor="w", padx=12, pady=(0, 10))

    def save(self):
        body = self.text.get("1.0", "end").strip()
        try:
            with open(os.path.join(APP_DIR, "note.txt"), "w", encoding="utf-8") as handle:
                handle.write(body + "\n")
            self.status.configure(text="Saved " + str(len(body)) + " characters to note.txt")
        except OSError as error:
            self.status.configure(text="Could not save: " + str(error), style="Bad.TLabel")


# -------------------------------------------------------------------- todo


class TodoApp:
    def __init__(self, root):
        self.root = root
        ttk.Label(root, text="Todo", style="Title.TLabel").pack(anchor="w", padx=12, pady=(14, 4))
        self.list = tk.Listbox(root, height=12, font=("Segoe UI", 11))
        self.list.pack(fill="both", expand=True, padx=12, pady=8)
        row = ttk.Frame(root)
        row.pack(fill="x", padx=12, pady=(0, 6))
        ttk.Label(row, text="New task").pack(side="left")
        self.entry = ttk.Entry(row, width=34)
        self.entry.pack(side="left", fill="x", expand=True, padx=8)
        ttk.Button(row, text="Add task", command=self.add).pack(side="left")
        ttk.Button(root, text="Mark done", command=self.done).pack(anchor="w", padx=12, pady=(0, 10))

    def add(self):
        value = self.entry.get().strip()
        if value:
            self.list.insert("end", value)
            self.entry.delete(0, "end")

    def done(self):
        selected = self.list.curselection()
        if selected:
            index = selected[0]
            text = self.list.get(index)
            self.list.delete(index)
            self.list.insert(index, "[done] " + text)


# -------------------------------------------------------------------- chat


class ChatApp:
    def __init__(self, root):
        self.root = root
        ttk.Label(root, text="Chat", style="Title.TLabel").pack(anchor="w", padx=12, pady=(14, 4))
        self.history = tk.Text(root, height=12, wrap="word", state="disabled", font=("Segoe UI", 11))
        self.history.pack(fill="both", expand=True, padx=12, pady=8)
        row = ttk.Frame(root)
        row.pack(fill="x", padx=12, pady=(0, 10))
        ttk.Label(row, text="Message").pack(side="left")
        self.entry = ttk.Entry(row, width=40)
        self.entry.pack(side="left", fill="x", expand=True, padx=8)
        ttk.Button(row, text="Send", command=self.send).pack(side="left")
        self.reply = "Reply: I received your message and I am ready for the next step."

    def send(self):
        value = self.entry.get().strip()
        if not value:
            return
        self.history.configure(state="normal")
        self.history.insert("end", "You: " + value + "\n")
        self.history.insert("end", self.reply + "\n")
        self.history.see("end")
        self.history.configure(state="disabled")
        self.entry.delete(0, "end")


# ------------------------------------------------------------------- files


class FilesApp:
    def __init__(self, root):
        self.root = root
        ttk.Label(root, text="Files", style="Title.TLabel").pack(anchor="w", padx=12, pady=(14, 4))
        body = ttk.Frame(root)
        body.pack(fill="both", expand=True, padx=12, pady=8)
        self.tree = ttk.Treeview(body, columns=("size",), show="tree headings", height=10)
        self.tree.heading("#0", text="Name")
        self.tree.heading("size", text="Size")
        self.tree.pack(side="left", fill="both", expand=True)
        self.tree.bind("<<TreeviewSelect>>", self.show)
        self.preview = tk.Text(body, width=34, height=12, wrap="word", state="disabled")
        self.preview.pack(side="right", fill="both", expand=True, padx=(8, 0))
        for name, body_text in [
            ("readme.txt", "Sightline sample files. Select a file to read it."),
            ("report.csv", "month,passed,failed\nJanuary,42,3\nFebruary,51,1"),
            ("settings.json", '{"theme":"light","profile":"dana"}'),
        ]:
            self.tree.insert("", "end", text=name, values=(str(len(body_text)) + " B",), tags=(body_text,))

    def show(self, _event=None):
        selected = self.tree.selection()
        if not selected:
            return
        tags = self.tree.item(selected[0], "tags")
        body = tags[0] if tags else ""
        self.preview.configure(state="normal")
        self.preview.delete("1.0", "end")
        self.preview.insert("1.0", body)
        self.preview.configure(state="disabled")


# ------------------------------------------------------------------- media


class MediaApp:
    """First video is unavailable; Up next holds same-topic videos."""

    VIDEOS = [
        ("Unavailable video", False),
        ("Same topic video 2", True),
        ("Same topic video 3", True),
    ]

    def __init__(self, root):
        self.root = root
        self.selected = None
        self.playing = None
        ttk.Label(root, text="Sightline Media", style="Title.TLabel").pack(anchor="w", padx=12, pady=(14, 4))
        body = ttk.Frame(root)
        body.pack(fill="both", expand=True, padx=12, pady=8)
        left = ttk.Frame(body)
        left.pack(side="left", fill="both", expand=True)
        self.list = tk.Listbox(left, height=10, font=("Segoe UI", 11))
        self.list.pack(fill="both", expand=True)
        for title, _playable in self.VIDEOS:
            self.list.insert("end", title)
        self.list.bind("<<ListboxSelect>>", self.select)
        ttk.Button(left, text="Play", command=self.play).pack(fill="x", pady=6)
        self.status = ttk.Label(left, text="Select a video, then Play.", style="Hint.TLabel")
        self.status.pack(anchor="w")
        right = ttk.Frame(body)
        right.pack(side="right", fill="y", padx=(12, 0))
        ttk.Label(right, text="Up next", style="Title.TLabel").pack(anchor="w", pady=(0, 6))
        for title, _playable in self.VIDEOS:
            ttk.Button(right, text=title, command=lambda value=title: self.choose(value)).pack(fill="x", pady=3)

    def select(self, _event=None):
        chosen = self.list.curselection()
        if chosen:
            self.selected = self.list.get(chosen[0])
            self.status.configure(text="Selected: " + self.selected, style="Hint.TLabel")

    def choose(self, title):
        self.selected = title
        self.status.configure(text="Selected: " + title, style="Hint.TLabel")

    def play(self):
        if not self.selected:
            self.status.configure(text="Select a video first.", style="Bad.TLabel")
            return
        playable = dict(self.VIDEOS).get(self.selected, False)
        if not playable:
            self.playing = None
            self.status.configure(text="This video is unavailable. Try Up next or another same-topic video.", style="Bad.TLabel")
            return
        self.playing = self.selected
        self.status.configure(text="Now playing: " + self.selected, style="Good.TLabel")


# ------------------------------------------------------------------- store


class StoreApp:
    APPS = [("Note Keeper", "1.4 MB"), ("Timer Plus", "900 KB"), ("Pixel Paint", "2.1 MB")]

    def __init__(self, root):
        self.root = root
        ttk.Label(root, text="Sightline Store", style="Title.TLabel").pack(anchor="w", padx=12, pady=(14, 4))
        ttk.Label(root, text="Install a sample app.", style="Hint.TLabel").pack(anchor="w", padx=12, pady=(0, 8))
        for name, size in self.APPS:
            row = ttk.Frame(root)
            row.pack(fill="x", padx=12, pady=4)
            ttk.Label(row, text=name, width=18).pack(side="left")
            ttk.Label(row, text=size, width=10).pack(side="left")
            ttk.Button(row, text="Install " + name, command=lambda value=name: self.install(value)).pack(side="right")
        self.status = ttk.Label(root, text="", style="Good.TLabel")
        self.status.pack(anchor="w", padx=12, pady=12)

    def install(self, name):
        self.status.configure(text="Installed " + name)


# -------------------------------------------------------------------- main


BUILDERS = {
    "accounts": AccountsApp,
    "qr": QrApp,
    "profile": ProfileApp,
    "calculator": CalculatorApp,
    "notes": NotesApp,
    "todo": TodoApp,
    "chat": ChatApp,
    "files": FilesApp,
    "media": MediaApp,
    "store": StoreApp,
}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Sightline sample desktop apps")
    parser.add_argument("--app", choices=[name for name, _title in APPS], help="which app to open")
    parser.add_argument("--list", action="store_true", help="print the app names and exit")
    args = parser.parse_args(argv)
    if args.list or not args.app:
        for name, title in APPS:
            print(name + "\tSightline " + title)
        return 0
    title = dict(APPS)[args.app]
    root = base_window(title)
    BUILDERS[args.app](root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
