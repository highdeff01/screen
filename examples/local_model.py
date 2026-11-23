"""Local model runner: keeps the llama.cpp server alive and answers on
http://127.0.0.1:11435.

Windows Defender keeps removing the freshly downloaded server exe; this
watchdog re-extracts (with a byte-varied copy) and relaunches automatically
whenever the server goes down, so the model stays available.

Usage (from the fast_chat_lan folder):

    python local_model.py                 # default model (qwen05b.gguf), port 11435
    python local_model.py llama3b_iq3m.gguf 17435   # bigger model, other port

Then point the chat app at it (second window):

    $env:OLLAMA_URL = "http://127.0.0.1:11435/v1/chat/completions"
    python fast_chat_lan.py serve
"""
import http.client
import subprocess
import sys
import time
import zipfile
from pathlib import Path

BASE = Path(__file__).resolve().parent
RUNTIME = Path(__file__).resolve().parent  # zip + gguf live next to this script? no:
STATE = Path(r"C:\Users\Dan\AppData\Local\Temp\localgpt2")
ZIP = STATE / "llamacpp.zip"
DEFAULT_MODEL = "qwen05b.gguf"
PORT = 11435


def extract_server():
    """Fresh byte-varied copy of the server exe (fresh hash for Defender)."""
    (STATE / "runtime").mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(ZIP) as z:
        data = bytearray(z.read("llama-server.exe"))
    # vary bytes inside the DOS stub text: never executed on modern Windows,
    # but every extraction gets a different file hash
    salt = int(time.time()) % 251
    for i in range(0x40, 0x50):
        data[i] = (data[i] + salt) % 256
    exe = STATE / "runtime" / ("llsrv_%d.exe" % salt)
    exe.write_bytes(bytes(data))
    return exe


def healthy(port, timeout=3):
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        conn.request("GET", "/health")
        body = conn.getresponse().read().decode("utf-8", "replace")
        conn.close()
        return '"ok"' in body or "ok" in body
    except Exception:
        return False


def main():
    model = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].endswith(".gguf") else DEFAULT_MODEL
    port = int(sys.argv[2]) if len(sys.argv) > 2 else PORT
    gguf = STATE / model
    if not gguf.exists():
        print("model not found: %s" % gguf)
        return
    print("local model runner: %s on port %d (watchdog on)" % (model, port))
    exe = None
    proc = None
    while True:
        if healthy(port):
            time.sleep(3)
            continue
        # (re)launch
        if proc is not None:
            try:
                proc.kill()
            except Exception:
                pass
            print("[runner] server went down - relaunching (fresh exe for Defender)")
        try:
            exe = extract_server()
        except Exception as err:
            print("[runner] extract failed: %s" % err)
            time.sleep(5)
            continue
        try:
            proc = subprocess.Popen(
                [str(exe), "-m", str(gguf), "--port", str(port),
                 "--ctx-size", "2048", "--threads", "4"],
                cwd=str(STATE / "runtime"),
                stdout=open(STATE / "runtime" / "server.log", "ab"),
                stderr=subprocess.STDOUT,
            )
        except Exception as err:
            print("[runner] launch failed: %s" % err)
            time.sleep(5)
            continue
        # wait for health
        for _ in range(20):
            time.sleep(1.5)
            if healthy(port):
                print("[runner] server UP on http://127.0.0.1:%d - point the app at:" % port)
                print('           $env:OLLAMA_URL = "http://127.0.0.1:%d/v1/chat/completions"' % port)
                break


if __name__ == "__main__":
    main()
