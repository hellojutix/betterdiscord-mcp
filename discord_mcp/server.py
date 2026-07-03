"""MCP-сервер: отдаёт агенту инструменты для сбора данных с Discord.

Вся работа с Discord делегируется BetterDiscord-плагину через мост.
Здесь — логика инструментов, пагинация истории и экспорт.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
from contextlib import asynccontextmanager

import httpx
from mcp.server.fastmcp import FastMCP

from . import analytics
from .bridge import Bridge
from .local_index import LocalIndex

BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "8787"))
EXPORT_DIR = pathlib.Path(__file__).resolve().parent.parent / "exports"

_bridge = Bridge(port=BRIDGE_PORT)
_local_index = LocalIndex(export_dir=EXPORT_DIR, db_path=EXPORT_DIR / ".index.db")

# Хосты Discord CDN, с которых разрешено качать вложения.
_ALLOWED_CDN_HOSTS = {"cdn.discordapp.com", "media.discordapp.net"}


@asynccontextmanager
async def _lifespan(_server: FastMCP):
    """Поднимаем WS-мост на старте, гасим на выходе."""
    await _bridge.start()
    try:
        yield
    finally:
        await _bridge.stop()


mcp = FastMCP("discord-mcp", lifespan=_lifespan)


@mcp.tool()
async def bridge_status() -> str:
    """Проверить, подключён ли плагин BetterDiscord к мосту.

    Вызывай первым, если другие инструменты падают с ошибкой соединения.
    """
    if _bridge.connected:
        return "OK: плагин подключён, можно собирать данные."
    return (
        "Плагин НЕ подключён. Проверь: 1) Discord запущен, "
        "2) плагин DiscordMcpBridge включён в настройках BetterDiscord, "
        f"3) порт моста {BRIDGE_PORT} совпадает в .env и в плагине."
    )


@mcp.tool()
async def diagnostics() -> dict:
    """Показать, какие внутренние модули Discord нашёл плагин.

    Используй для отладки, если list_channels/get_messages падают с ошибкой
    вида 'is not a function' или 'reading undefined'.
    """
    return await _bridge.call("diag")


@mcp.tool()
async def list_guilds() -> list[dict]:
    """Список серверов (гильдий), к которым имеет доступ клиент.

    Возвращает id и name каждого сервера. Используй id в других инструментах.
    """
    return await _bridge.call("getGuilds")


@mcp.tool()
async def list_channels(guild_id: str) -> list[dict]:
    """Список текстовых каналов сервера.

    Args:
        guild_id: id сервера (из list_guilds).

    Возвращает id, name, type и topic каналов, доступных для чтения.
    """
    return await _bridge.call("getChannels", {"guildId": guild_id})


@mcp.tool()
async def get_messages(
    channel_id: str,
    limit: int = 100,
    before: str | None = None,
    author_id: str | None = None,
    after: str | None = None,
    humanize: bool = False,
) -> list[dict]:
    """Прочитать историю сообщений канала (с догрузкой через API клиента).

    Догружает сообщения родным механизмом клиента, страницами по 100.
    Для длинной истории вызывай повторно, передавая before = id самого
    старого полученного сообщения.

    Args:
        channel_id: id канала (из list_channels).
        limit: сколько сообщений вернуть (макс. рекомендованно 500 за раз,
            чтобы не создавать лишний трафик).
        before: вернуть сообщения старше этого message id (для пагинации).
        author_id: оставить только сообщения этого автора (id пользователя).
        after: вернуть сообщения новее этого message id (snowflake).
        humanize: если True, к каждому сообщению добавляется поле content_human
            с разрешёнными упоминаниями (<#канал>, <@юзер>, <@&роль>,
            <:эмодзи:id>). Исходное content не меняется.

    Возвращает список сообщений: id, author, content, timestamp, attachments,
    embeds, reactions, edited_timestamp, pinned, referenced_message. При
    humanize=True — дополнительно content_human.
    """
    limit = max(1, min(limit, 500))
    return await _bridge.call(
        "fetchMessages",
        {
            "channelId": channel_id,
            "limit": limit,
            "before": before,
            "authorId": author_id,
            "after": after,
            "humanize": humanize,
        },
        timeout=60.0,
    )


@mcp.tool()
async def search_messages(
    guild_id: str, query: str, limit: int = 25
) -> list[dict]:
    """Поиск сообщений по серверу через родной поиск Discord.

    Args:
        guild_id: id сервера.
        query: строка поиска (текст, from:user, has:link и т.п.).
        limit: сколько результатов вернуть (макс. 25 — как в клиенте).

    Возвращает найденные сообщения с указанием канала.
    """
    limit = max(1, min(limit, 25))
    return await _bridge.call(
        "searchMessages",
        {"guildId": guild_id, "query": query, "limit": limit},
        timeout=60.0,
    )


@mcp.tool()
async def list_members(
    guild_id: str, resolve_role_names: bool = False
) -> list[dict]:
    """Список участников сервера, известных клиенту.

    Внимание: клиент знает не всех участников больших серверов, а только
    подгруженных. Возвращает id, username, nick и роли (id ролей).

    Args:
        guild_id: id сервера.
        resolve_role_names: если True, к каждому участнику добавляется поле
            role_names (человекочитаемые имена ролей). Поле roles с id ролей
            остаётся без изменений.
    """
    return await _bridge.call(
        "getMembers",
        {"guildId": guild_id, "includeRoleNames": resolve_role_names},
    )


@mcp.tool()
async def get_roles(guild_id: str) -> list[dict]:
    """Список ролей сервера.

    Args:
        guild_id: id сервера.

    Возвращает id, name, color, position, permissions и другие поля роли —
    удобно для расшифровки id ролей из list_members.
    """
    return await _bridge.call("getRoles", {"guildId": guild_id})


@mcp.tool()
async def ping() -> dict:
    """Лёгкая проверка здоровья плагина.

    Возвращает версию плагина и карту найденных внутренних модулей Discord.
    Работает всегда, если плагин подключён — удобно для быстрой диагностики.
    """
    return await _bridge.call("ping")


@mcp.tool()
async def get_message_by_link(link: str) -> dict:
    """Получить одно сообщение по ссылке Discord.

    Args:
        link: ссылка вида
            https://discord.com/channels/<guildId>/<channelId>/<messageId>
            (поддерживаются также ptb./canary. и discordapp.com).

    Возвращает то же представление сообщения, что и get_messages.
    """
    return await _bridge.call("getMessageByLink", {"link": link})


@mcp.tool()
async def list_dms() -> list[dict]:
    """Список личных и групповых переписок (DM) текущего аккаунта.

    Возвращает id, type, name и список участников (recipients) каждой личной
    или групповой переписки.
    """
    return await _bridge.call("getDMs")


@mcp.tool()
async def list_threads(
    channel_id: str | None = None, guild_id: str | None = None
) -> list[dict]:
    """Список веток (threads) или постов форума.

    Для форум-каналов и обычных каналов с ветками подгружает архивные посты
    родным механизмом клиента, если их ещё нет в кэше (нужен channel_id).

    Args:
        channel_id: id канала-родителя (для форумов — обязателен).
        guild_id: id сервера (необязательно).

    Возвращает id, name, parent_id, archived, message_count и — если доступно —
    first_message (автор, текст, вложения первого сообщения поста).
    """
    return await _bridge.call(
        "getThreads", {"channelId": channel_id, "guildId": guild_id}
    )


@mcp.tool()
async def list_threads_paginated(
    channel_id: str | None = None,
    guild_id: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> dict:
    """Постраничный список веток/постов форума.

    Отдельный инструмент с пагинацией (list_threads остаётся без изменений и
    возвращает плоский список). Полезно для форумов с большим числом постов.

    Args:
        channel_id: id канала-родителя (для форумов — обязателен).
        guild_id: id сервера (необязательно).
        offset: сколько веток пропустить с начала.
        limit: сколько веток вернуть (1..250).

    Возвращает dict {threads, hasMore, total}. Внимание: hasMore и total —
    эвристики (клиент подгружает архив постранично и не всегда знает полный
    объём), полагаться на них как на точные значения нельзя.
    """
    limit = max(1, min(limit, 250))
    offset = max(0, offset)
    return await _bridge.call(
        "getThreadsPaginated",
        {
            "channelId": channel_id,
            "guildId": guild_id,
            "offset": offset,
            "limit": limit,
        },
        timeout=30.0,
    )


@mcp.tool()
async def read_thread(thread_id: str, limit: int = 100) -> list[dict]:
    """Прочитать сообщения ветки/поста форума по-порядку (старые сверху).

    Ветка в Discord — это тоже канал, её id совпадает с id первого сообщения
    поста (из list_threads). Удобно для чтения тредов и форумных постов:
    возвращает сообщения в хронологическом порядке (в отличие от get_messages,
    который отдаёт свежие сверху).

    Args:
        thread_id: id ветки/поста (поле id из list_threads).
        limit: сколько сообщений вернуть (макс. 500).

    Возвращает список сообщений в порядке от старых к новым.
    """
    limit = max(1, min(limit, 500))
    msgs = await _bridge.call(
        "fetchMessages",
        {"channelId": thread_id, "limit": limit},
        timeout=60.0,
    )
    # fetchMessages отдаёт свежие сверху — переворачиваем в хронологию.
    return list(reversed(msgs)) if isinstance(msgs, list) else msgs


@mcp.tool()
async def get_pins(channel_id: str) -> list[dict]:
    """Закреплённые сообщения канала или ветки.

    Подгружает пины родным механизмом клиента, если они ещё не в кэше.

    Args:
        channel_id: id канала или ветки.

    Возвращает список закреплённых сообщений (поле pinned_at + обычные поля
    сообщения), самые свежие пины сверху.
    """
    return await _bridge.call("getPins", {"channelId": channel_id}, timeout=30.0)


@mcp.tool()
async def get_channel_info(channel_id: str) -> dict:
    """Информация о канале или ветке по id.

    Args:
        channel_id: id канала или ветки.

    Возвращает id, name, type, guild_id, parent_id, topic и — для веток —
    owner_id, message_count, member_count, archived, last_message_id.
    """
    return await _bridge.call("getChannelInfo", {"channelId": channel_id})


@mcp.tool()
async def get_guild_info(guild_id: str) -> dict:
    """Информация о сервере (гильдии) по id.

    Args:
        guild_id: id сервера.

    Возвращает id, name, описание, дату создания, число участников, роли,
    категории/каналы, features, уровень буста (premium tier) и владельца —
    насколько эти данные известны клиенту.
    """
    return await _bridge.call("getGuildInfo", {"guildId": guild_id})


@mcp.tool()
async def get_user_info(user_id: str) -> dict:
    """Информация о пользователе по id.

    Args:
        user_id: id пользователя.

    Возвращает id, username, global_name, bot и avatar.
    """
    return await _bridge.call("getUserInfo", {"userId": user_id})


@mcp.tool()
async def resolve_id(snowflake_id: str) -> dict:
    """Определить, чему соответствует произвольный snowflake-id.

    Классифицирует id как сервер (guild), канал, ветку/пост форума,
    пользователя или сообщение и возвращает краткую информацию о найденном
    объекте.

    Args:
        snowflake_id: числовой id Discord (сервер, канал, пользователь,
            сообщение и т.п.).

    Возвращает поле type (guild/channel/thread/user/message/unknown) и
    доступные данные объекта, плюс время создания из snowflake.
    """
    return await _bridge.call("resolveId", {"id": snowflake_id})


@mcp.tool()
async def get_reactions(
    channel_id: str, message_id: str, emoji: str
) -> list[dict]:
    """Список пользователей, поставивших конкретную реакцию на сообщение.

    Args:
        channel_id: id канала или ветки, где лежит сообщение.
        message_id: id сообщения.
        emoji: эмодзи реакции — либо unicode-символ (например, 👍), либо
            snowflake-id кастомного эмодзи (строкой).

    Возвращает список пользователей (id, username, global_name и т.п.),
    поставивших эту реакцию.
    """
    return await _bridge.call(
        "getReactions",
        {"channelId": channel_id, "messageId": message_id, "emoji": emoji},
        timeout=20.0,
    )


@mcp.tool()
async def export_channel(
    channel_id: str, max_messages: int = 1000, filename: str | None = None
) -> str:
    """Выгрузить историю канала в JSON-файл для дальнейшей обработки.

    Догружает сообщения страницами до max_messages и сохраняет в exports/.

    Args:
        channel_id: id канала.
        max_messages: сколько сообщений максимум выгрузить.
        filename: имя файла (по умолчанию channel_<id>.json).

    Возвращает путь к сохранённому файлу и число сообщений.
    """
    max_messages = max(1, min(max_messages, 50000))
    collected: list[dict] = []
    before: str | None = None

    while len(collected) < max_messages:
        batch_size = min(100, max_messages - len(collected))
        batch = await _bridge.call(
            "fetchMessages",
            {"channelId": channel_id, "limit": batch_size, "before": before},
            timeout=60.0,
        )
        if not batch:
            break
        collected.extend(batch)
        before = batch[-1]["id"]
        if len(batch) < batch_size:
            break  # достигли начала истории

    EXPORT_DIR.mkdir(exist_ok=True)
    name = filename or f"channel_{channel_id}.json"
    out_path = EXPORT_DIR / name
    out_path.write_text(
        json.dumps(collected, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return f"Сохранено {len(collected)} сообщений в {out_path}"


def _sanitize_filename(name: str) -> str:
    """Убрать из имени файла путь и небезопасные символы."""
    name = name.replace("\\", "/").split("/")[-1]
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name).strip("._")
    return name or "attachment"


def _unique_path(directory: pathlib.Path, filename: str) -> pathlib.Path:
    """Подобрать путь без коллизий, добавляя суффикс _1/_2/..."""
    candidate = directory / filename
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    i = 1
    while True:
        candidate = directory / f"{stem}_{i}{suffix}"
        if not candidate.exists():
            return candidate
        i += 1


async def _download_one(
    client: httpx.AsyncClient, url: str, filename: str | None
) -> tuple[pathlib.Path, int]:
    """Скачать один файл с Discord CDN в EXPORT_DIR. Возвращает (путь, байты)."""
    host = httpx.URL(url).host
    if host not in _ALLOWED_CDN_HOSTS:
        raise ValueError(
            f"Хост {host!r} не разрешён. Качать можно только с "
            f"{', '.join(sorted(_ALLOWED_CDN_HOSTS))}."
        )
    EXPORT_DIR.mkdir(exist_ok=True)
    name = _sanitize_filename(
        filename or httpx.URL(url).path.rsplit("/", 1)[-1] or "attachment"
    )
    out_path = _unique_path(EXPORT_DIR, name)
    resp = await client.get(url, follow_redirects=True)
    resp.raise_for_status()
    data = resp.content
    out_path.write_bytes(data)
    return out_path, len(data)


@mcp.tool()
async def download_attachment(url: str, filename: str | None = None) -> str:
    """Скачать одно вложение с Discord CDN в папку exports/.

    Разрешены только хосты cdn.discordapp.com и media.discordapp.net.

    Args:
        url: прямая ссылка на файл (из поля attachments[].url сообщения).
        filename: желаемое имя файла (по умолчанию берётся из url); при
            коллизии добавляется суффикс _1/_2.

    Возвращает абсолютный путь к сохранённому файлу и его размер в байтах.
    """
    async with httpx.AsyncClient(timeout=60.0) as client:
        out_path, size = await _download_one(client, url, filename)
    return f"Сохранено {size} байт в {out_path}"


@mcp.tool()
async def export_attachments(
    channel_id: str, max_messages: int = 1000, concurrent: int = 5
) -> str:
    """Скачать все вложения канала в exports/ и записать манифест.

    Проходит историю канала (как export_channel), собирает ссылки на вложения
    и качает их параллельно с Discord CDN. Пропускает то, что не удалось
    скачать, и пишет манифест attachments_<channel_id>.json со списком
    url/local_path/size/status.

    Args:
        channel_id: id канала.
        max_messages: сколько сообщений максимум просмотреть.
        concurrent: сколько загрузок вести параллельно (1..20).

    Возвращает краткую сводку: сколько вложений скачано и путь к манифесту.
    """
    max_messages = max(1, min(max_messages, 50000))
    concurrent = max(1, min(concurrent, 20))

    # Собираем ссылки на вложения, листая историю страницами.
    urls: list[str] = []
    before: str | None = None
    seen = 0
    while seen < max_messages:
        batch_size = min(100, max_messages - seen)
        batch = await _bridge.call(
            "fetchMessages",
            {"channelId": channel_id, "limit": batch_size, "before": before},
            timeout=60.0,
        )
        if not batch:
            break
        seen += len(batch)
        for msg in batch:
            for att in msg.get("attachments") or []:
                if isinstance(att, dict) and att.get("url"):
                    urls.append(att["url"])
        before = batch[-1]["id"]
        if len(batch) < batch_size:
            break

    EXPORT_DIR.mkdir(exist_ok=True)
    manifest: list[dict] = []
    sem = asyncio.Semaphore(concurrent)

    async with httpx.AsyncClient(timeout=60.0) as client:

        async def fetch(u: str) -> None:
            async with sem:
                entry: dict = {"url": u, "local_path": None, "size": 0}
                try:
                    out_path, size = await _download_one(client, u, None)
                    entry["local_path"] = str(out_path)
                    entry["size"] = size
                    entry["status"] = "ok"
                except Exception as exc:  # noqa: BLE001 — фиксируем в манифест
                    entry["status"] = f"error: {exc}"
                manifest.append(entry)

        await asyncio.gather(*(fetch(u) for u in urls))

    ok = sum(1 for e in manifest if e.get("status") == "ok")
    manifest_path = EXPORT_DIR / f"attachments_{channel_id}.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return (
        f"Скачано {ok}/{len(manifest)} вложений из {seen} сообщений. "
        f"Манифест: {manifest_path}"
    )


@mcp.tool()
async def search_local(query: str, channel_id: str | None = None) -> list[dict]:
    """Полнотекстовый поиск по локально выгруженным каналам (exports/*.json).

    Ищет офлайн по файлам, созданным export_channel, через SQLite FTS5 —
    без обращения к Discord. Индекс строится и обновляется автоматически по
    mtime файлов экспорта.

    Args:
        query: поисковый запрос (синтаксис FTS5: слова, "фраза", OR, AND, *).
        channel_id: ограничить поиск одним каналом (по его id).

    Возвращает список сообщений в том же виде, что и get_messages.
    """
    query = query.strip()
    if not query:
        raise ValueError("Пустой поисковый запрос")
    return await asyncio.to_thread(_local_index.search, query, channel_id)


@mcp.tool()
async def channel_stats(
    channel_id: str | None = None, file: str | None = None
) -> dict:
    """Аналитика по ранее выгруженной истории канала.

    Работает офлайн по JSON-экспорту (сам экспорт не запускает — сначала
    вызови export_channel).

    Args:
        channel_id: id канала; читается exports/channel_<id>.json.
        file: явный путь к файлу экспорта (приоритетнее channel_id).

    Возвращает per_user, top_authors, reply_mention_graph, active_hours,
    active_days, time_distribution и summary.
    """
    if file:
        path = pathlib.Path(file)
        if not path.is_absolute():
            path = EXPORT_DIR / file
    elif channel_id:
        path = EXPORT_DIR / f"channel_{channel_id}.json"
    else:
        raise ValueError("Укажи channel_id или file")

    if not path.exists():
        raise FileNotFoundError(
            f"Файл экспорта не найден: {path}. Сначала выгрузи канал через "
            f"export_channel."
        )

    messages = json.loads(path.read_text(encoding="utf-8"))
    return await asyncio.to_thread(analytics.compute_stats, messages)


def main() -> None:
    """Точка входа: запуск MCP-сервера по stdio."""
    mcp.run()


if __name__ == "__main__":
    main()
