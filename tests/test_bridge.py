"""Tests for discord_mcp.bridge.Bridge.

The Bridge is a WebSocket *server* on 127.0.0.1:<port>. A BetterDiscord
plugin connects to it as a client and answers JSON-RPC requests. These tests
stand up the server on an unusual port and, where needed, connect a fake
plugin using the ``websockets`` client library.
"""

from __future__ import annotations

import asyncio
import json

import pytest
import websockets

from discord_mcp.bridge import Bridge, BridgeError

# Unusual port to avoid clashing with a real server on the default 8787.
TEST_PORT = 8811


@pytest.mark.asyncio
async def test_start_and_stop_cleanly():
    """start() opens a listening server; stop() closes it without error."""
    bridge = Bridge(port=TEST_PORT)
    await bridge.start()
    assert bridge._server is not None
    # No plugin connected yet.
    assert bridge.connected is False
    await bridge.stop()

    # After stop, the port should be free to bind again immediately.
    bridge2 = Bridge(port=TEST_PORT)
    await bridge2.start()
    await bridge2.stop()


@pytest.mark.asyncio
async def test_call_without_plugin_raises_quickly():
    """call() with no plugin connected raises BridgeError fast."""
    bridge = Bridge(port=TEST_PORT)
    await bridge.start()
    try:
        with pytest.raises(BridgeError):
            await bridge.call("getGuilds", timeout=0.5)
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_full_round_trip():
    """A fake plugin connects, answers one request, bridge returns result."""
    bridge = Bridge(port=TEST_PORT)
    await bridge.start()

    expected = [{"id": "1", "name": "Test Guild"}]

    async def fake_plugin():
        uri = f"ws://127.0.0.1:{TEST_PORT}"
        async with websockets.connect(uri) as ws:
            raw = await ws.recv()
            req = json.loads(raw)
            assert req["method"] == "getGuilds"
            await ws.send(
                json.dumps({"id": req["id"], "ok": True, "result": expected})
            )
            # Keep the connection open briefly so the bridge can read the reply.
            await asyncio.sleep(0.2)

    try:
        plugin_task = asyncio.create_task(fake_plugin())
        # Wait for the plugin to register as connected.
        for _ in range(50):
            if bridge.connected:
                break
            await asyncio.sleep(0.05)
        assert bridge.connected is True

        result = await bridge.call("getGuilds", timeout=5.0)
        assert result == expected

        await plugin_task
    finally:
        await bridge.stop()
