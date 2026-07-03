"""WebSocket-мост между Python MCP-сервером и BetterDiscord-плагином.

Python поднимает WS-сервер на localhost. Плагин (внутри Discord)
подключается к нему как клиент. Обмен — простой JSON-RPC:

    -> {"id": "abc", "method": "getGuilds", "params": {}}
    <- {"id": "abc", "ok": true, "result": [...]}
    <- {"id": "abc", "ok": false, "error": "текст ошибки"}

Токен не нужен: плагин работает внутри уже авторизованного клиента.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import websockets
from websockets.server import WebSocketServerProtocol


class BridgeError(Exception):
    """Ошибка на стороне плагина или моста."""


class Bridge:
    """Держит одно активное соединение с плагином и роутит запросы."""

    def __init__(self, host: str = "127.0.0.1", port: int = 8787) -> None:
        self._host = host
        self._port = port
        self._conn: WebSocketServerProtocol | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._server: Any = None

    async def start(self) -> None:
        """Запустить WS-сервер (не блокирует — работает в фоне)."""
        self._server = await websockets.serve(
            self._handle_conn, self._host, self._port
        )

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    @property
    def connected(self) -> bool:
        return self._conn is not None

    async def _handle_conn(self, ws: WebSocketServerProtocol) -> None:
        """Обслуживаем соединение плагина. Держим только одно активное."""
        self._conn = ws
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                fut = self._pending.pop(msg.get("id", ""), None)
                if fut is not None and not fut.done():
                    fut.set_result(msg)
        finally:
            if self._conn is ws:
                self._conn = None
            # Отменяем всё, что ждало ответа от отвалившегося плагина.
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(BridgeError("Плагин отключился"))
            self._pending.clear()

    async def call(
        self, method: str, params: dict | None = None, timeout: float = 30.0
    ) -> Any:
        """Вызвать метод на стороне плагина и дождаться результата."""
        if self._conn is None:
            raise BridgeError(
                "Плагин BetterDiscord не подключён. Убедись, что Discord "
                "запущен и плагин DiscordMcpBridge включён."
            )
        req_id = uuid.uuid4().hex
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        payload = json.dumps(
            {"id": req_id, "method": method, "params": params or {}}
        )
        await self._conn.send(payload)

        try:
            msg = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise BridgeError(f"Таймаут ожидания ответа на {method}")

        if not msg.get("ok"):
            raise BridgeError(msg.get("error", "неизвестная ошибка плагина"))
        return msg.get("result")
