import platform
import sqlite3
import sys


def check():
    return {"status": "ok", "backendVersion": "0.1.0",
            "pythonVersion": platform.python_version(),
            "sqliteVersion": sqlite3.sqlite_version, "executable": sys.executable}
