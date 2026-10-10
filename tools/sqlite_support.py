"""Use the standard SQLite driver, or the build-only binary fallback."""
try:
    import sqlite3
except ModuleNotFoundError as error:
    if error.name != '_sqlite3':
        raise
    import pysqlite3 as sqlite3
