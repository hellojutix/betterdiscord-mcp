"""MCP-сервер: отдаёт агенту инструменты для сбора данных с Discord.

Вся работа с Discord делегируется BetterDiscord-плагину через мост.
Здесь — логика инструментов, пагинация истории и экспорт.
"""

from __future__ import annotations

import json
import os
import pathlib
from contextlib import asynccontextmanager

from mcp.server.fastmcp import FastMCP

from .bridge import Bridge

BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "8787"))
EXPORT_DIR = pathlib.Path(__file__).resolve().parent.parent / "exports"

_bridge = Bridge(port=BRIDGE_PORT)


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

    Возвращает список сообщений: id, author, content, timestamp, attachments,
    embeds, reactions, edited_timestamp, pinned, referenced_message.
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
async def list_members(guild_id: str) -> list[dict]:
    """Список участников сервера, известных клиенту.

    Внимание: клиент знает не всех участников больших серверов, а только
    подгруженных. Возвращает id, username, nick и роли.

    Args:
        guild_id: id сервера.
    """
    return await _bridge.call("getMembers", {"guildId": guild_id})


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
    """Список активных веток (threads).

    Args:
        channel_id: id канала-родителя (необязательно).
        guild_id: id сервера (необязательно).

    Возвращает id, name, parent_id и archived каждой ветки.
    """
    return await _bridge.call(
        "getThreads", {"channelId": channel_id, "guildId": guild_id}
    )


@mcp.tool()
async def get_user_info(user_id: str) -> dict:
    """Информация о пользователе по id.

    Args:
        user_id: id пользователя.

    Возвращает id, username, global_name, bot и avatar.
    """
    return await _bridge.call("getUserInfo", {"userId": user_id})


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


def main() -> None:
    """Точка входа: запуск MCP-сервера по stdio."""
    mcp.run()


if __name__ == "__main__":
    main()
