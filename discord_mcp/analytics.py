"""Аналитика по выгруженной истории канала (exports/*.json).

Считает статистику из списка сообщений в формате, который отдаёт export_channel
(поля как у get_messages: id, author, content, timestamp, referenced_message,
mentions/embeds и т.п.). Только stdlib.

Snowflake -> unix-ms: (id >> 22) + 1420070400000.
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timezone
from typing import Any

DISCORD_EPOCH_MS = 1420070400000
_MENTION_RE = re.compile(r"<@!?(\d+)>")


def _author_of(msg: dict[str, Any]) -> tuple[str, str]:
    """Вернуть (author_id, display) сообщения."""
    author = msg.get("author")
    if isinstance(author, dict):
        aid = str(author.get("id", "") or "")
        disp = author.get("username") or author.get("global_name") or aid
        return aid, str(disp)
    s = str(author or "")
    return s, s


def _ts_from_msg(msg: dict[str, Any]) -> datetime | None:
    """Достать время сообщения: из timestamp ISO или из snowflake id."""
    ts = msg.get("timestamp")
    if isinstance(ts, str) and ts:
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            pass
    raw_id = msg.get("id")
    try:
        ms = (int(raw_id) >> 22) + DISCORD_EPOCH_MS
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def compute_stats(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Посчитать сводную статистику по списку сообщений.

    Возвращает per_user, top_authors, reply_mention_graph, active_hours,
    active_days, time_distribution и summary.
    """
    if not isinstance(messages, list):
        messages = []

    per_user: dict[str, dict[str, Any]] = {}
    hours: Counter[int] = Counter()
    weekdays: Counter[int] = Counter()
    dates: Counter[str] = Counter()
    edges: Counter[tuple[str, str]] = Counter()

    first_dt: datetime | None = None
    last_dt: datetime | None = None
    id_to_author: dict[str, str] = {}

    # Первый проход: индексируем id->author для рёбер ответов.
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        aid, _ = _author_of(msg)
        mid = str(msg.get("id", "") or "")
        if mid and aid:
            id_to_author[mid] = aid

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        aid, disp = _author_of(msg)
        content = str(msg.get("content", "") or "")

        stats = per_user.setdefault(
            aid,
            {
                "author_id": aid,
                "display": disp,
                "messages": 0,
                "chars": 0,
                "attachments": 0,
                "with_reactions": 0,
            },
        )
        stats["messages"] += 1
        stats["chars"] += len(content)
        atts = msg.get("attachments")
        if isinstance(atts, list):
            stats["attachments"] += len(atts)
        reactions = msg.get("reactions")
        if isinstance(reactions, list) and reactions:
            stats["with_reactions"] += 1

        dt = _ts_from_msg(msg)
        if dt is not None:
            hours[dt.hour] += 1
            weekdays[dt.weekday()] += 1
            dates[dt.date().isoformat()] += 1
            if first_dt is None or dt < first_dt:
                first_dt = dt
            if last_dt is None or dt > last_dt:
                last_dt = dt

        # Рёбра графа: ответы + упоминания.
        ref = msg.get("referenced_message")
        if isinstance(ref, dict):
            ref_aid, _ = _author_of(ref)
            if not ref_aid:
                ref_aid = id_to_author.get(str(ref.get("id", "") or ""), "")
            if aid and ref_aid and aid != ref_aid:
                edges[(aid, ref_aid)] += 1
        for target in _MENTION_RE.findall(content):
            if aid and target and aid != target:
                edges[(aid, target)] += 1

    total = sum(u["messages"] for u in per_user.values())

    top_authors = [
        {"author_id": u["author_id"], "display": u["display"], "messages": u["messages"]}
        for u in sorted(
            per_user.values(), key=lambda x: x["messages"], reverse=True
        )[:10]
    ]

    reply_mention_graph = [
        {"from": src, "to": dst, "count": cnt}
        for (src, dst), cnt in sorted(
            edges.items(), key=lambda kv: kv[1], reverse=True
        )[:50]
    ]

    weekday_names = [
        "Monday", "Tuesday", "Wednesday", "Thursday",
        "Friday", "Saturday", "Sunday",
    ]

    summary = {
        "total_messages": total,
        "unique_authors": len(per_user),
        "first_message": first_dt.isoformat() if first_dt else None,
        "last_message": last_dt.isoformat() if last_dt else None,
        "days_active": len(dates),
    }

    return {
        "per_user": sorted(
            per_user.values(), key=lambda x: x["messages"], reverse=True
        ),
        "top_authors": top_authors,
        "reply_mention_graph": reply_mention_graph,
        "active_hours": {str(h): hours.get(h, 0) for h in range(24)},
        "active_days": {
            weekday_names[d]: weekdays.get(d, 0) for d in range(7)
        },
        "time_distribution": dict(sorted(dates.items())),
        "summary": summary,
    }
