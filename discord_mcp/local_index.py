"""Локальный полнотекстовый индекс по выгруженным каналам (exports/*.json).

Строит SQLite FTS5-индекс поверх JSON-файлов экспорта и умеет искать по нему
без обращения к Discord. Индекс перестраивается инкрементально: пересобираем
только файлы, чей mtime изменился (отслеживается в таблице index_meta).

Всё на stdlib: sqlite3 + json + pathlib. Никакой сети, только чтение локальных
файлов, созданных export_channel.
"""

from __future__ import annotations

import json
import pathlib
import sqlite3
from typing import Any


class LocalIndex:
    """FTS5-индекс над файлами exports/*.json с ленивой пересборкой."""

    def __init__(self, export_dir: pathlib.Path, db_path: pathlib.Path) -> None:
        self._export_dir = export_dir
        self._db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
                message_id UNINDEXED,
                channel_id UNINDEXED,
                author UNINDEXED,
                timestamp UNINDEXED,
                content,
                payload UNINDEXED
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS index_meta (
                source TEXT PRIMARY KEY,
                mtime REAL NOT NULL
            )
            """
        )
        conn.commit()

    def rebuild_if_stale(self) -> None:
        """Пересобрать индекс для изменённых/новых/удалённых файлов экспорта."""
        self._export_dir.mkdir(exist_ok=True)
        conn = self._connect()
        try:
            self._ensure_schema(conn)
            known = {
                row["source"]: row["mtime"]
                for row in conn.execute("SELECT source, mtime FROM index_meta")
            }
            current_files = {
                p.name: p
                for p in self._export_dir.glob("*.json")
                if p.name != ".index.db"
            }

            # Удалённые с диска файлы вычищаем из индекса.
            for gone in set(known) - set(current_files):
                self._purge_source(conn, gone)

            for name, path in current_files.items():
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    continue
                if known.get(name) == mtime:
                    continue  # не изменился
                self._reindex_file(conn, name, path, mtime)
            conn.commit()
        finally:
            conn.close()

    def _purge_source(self, conn: sqlite3.Connection, source: str) -> None:
        conn.execute(
            "DELETE FROM messages WHERE json_extract(payload, '$._source') = ?",
            (source,),
        )
        conn.execute("DELETE FROM index_meta WHERE source = ?", (source,))

    def _reindex_file(
        self,
        conn: sqlite3.Connection,
        source: str,
        path: pathlib.Path,
        mtime: float,
    ) -> None:
        # Сносим старые записи этого файла и вставляем заново.
        conn.execute(
            "DELETE FROM messages WHERE json_extract(payload, '$._source') = ?",
            (source,),
        )
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            data = []
        if not isinstance(data, list):
            data = []

        for msg in data:
            if not isinstance(msg, dict):
                continue
            author = msg.get("author")
            if isinstance(author, dict):
                author_str = author.get("username") or author.get("id") or ""
            else:
                author_str = str(author or "")
            stored = dict(msg)
            stored["_source"] = source
            conn.execute(
                "INSERT INTO messages "
                "(message_id, channel_id, author, timestamp, content, payload) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    str(msg.get("id", "")),
                    str(msg.get("channel_id", "") or msg.get("channelId", "")),
                    author_str,
                    str(msg.get("timestamp", "")),
                    str(msg.get("content", "") or ""),
                    json.dumps(stored, ensure_ascii=False),
                ),
            )
        conn.execute(
            "INSERT INTO index_meta (source, mtime) VALUES (?, ?) "
            "ON CONFLICT(source) DO UPDATE SET mtime = excluded.mtime",
            (source, mtime),
        )

    def search(
        self, query: str, channel_id: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        """Найти сообщения по FTS-запросу. Возвращает dict'ы как в get_messages."""
        self.rebuild_if_stale()
        conn = self._connect()
        try:
            self._ensure_schema(conn)
            sql = "SELECT payload FROM messages WHERE messages MATCH ?"
            args: list[Any] = [query]
            if channel_id:
                sql += " AND channel_id = ?"
                args.append(channel_id)
            sql += " LIMIT ?"
            args.append(limit)
            try:
                rows = conn.execute(sql, args).fetchall()
            except sqlite3.OperationalError as exc:
                raise ValueError(f"Некорректный FTS-запрос: {exc}") from exc

            results: list[dict[str, Any]] = []
            for row in rows:
                try:
                    payload = json.loads(row["payload"])
                except (json.JSONDecodeError, TypeError):
                    continue
                payload.pop("_source", None)
                results.append(payload)
            return results
        finally:
            conn.close()
