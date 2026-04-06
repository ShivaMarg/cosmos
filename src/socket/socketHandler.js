/**
 * socketHandler — wires all Socket.IO events for one connected client.
 *
 * Events (client → server):
 *   cosmos:join        { userId, name, color, position }
 *   cosmos:move        { x, y }
 *   cosmos:proximity   { nearbyIds: string[] }   // client-driven detection
 *   cosmos:message     { roomId, text }
 *   cosmos:disconnect  (built-in socket event)
 *
 * Events (server → client):
 *   cosmos:welcome     { user, onlineUsers[] }           to the joiner
 *   cosmos:user_joined { user }                          to everyone else
 *   cosmos:user_moved  { userId, position }              to everyone
 *   cosmos:connected   { roomId, peer }                  to both peers
 *   cosmos:disconnected{ roomId, peerId }                to both peers
 *   cosmos:message     { roomId, message }               to room participants
 *   cosmos:history     { roomId, messages[] }            to requester
 *   cosmos:user_left   { userId }                        to everyone
 *   cosmos:online_count{ count }                         to everyone
 */

const User = require("../models/User");
const ChatMessage = require("../models/ChatMessage");
const state = require("./StateManager/User");

const PROXIMITY_RADIUS = Number(process.env.PROXIMITY_RADIUS) || 160;

module.exports = function registerSocketHandlers(io) {
  io.on("connection", (socket) => {
    console.log(`[Socket] New connection: ${socket.id}`);

    let currentUserId = null; // set after cosmos:join

    /* ─────────────────────────────────────────
       JOIN
    ───────────────────────────────────────── */
    socket.on("cosmos:join", async ({ userId, name, color, position }) => {
      try {
        currentUserId = userId;

        // 1. Upsert in MongoDB
        await User.upsertOnJoin({
          userId,
          name: sanitize(name, 24),
          color: sanitizeColor(color),
          socketId: socket.id,
          position,
        });

        // 2. Register in hot state
        state.addUser({
          userId,
          socketId: socket.id,
          name: sanitize(name, 24),
          color: sanitizeColor(color),
          position,
        });

        const me = state.getUser(userId);

        // 3. Tell the joiner about every other online user
        socket.emit("cosmos:welcome", {
          user: me,
          onlineUsers: state.getAllUsers().filter((u) => u.userId !== userId),
        });

        // 4. Tell everyone else about the new joiner
        socket.broadcast.emit("cosmos:user_joined", { user: me });

        // 5. Broadcast updated count
        io.emit("cosmos:online_count", { count: state.onlineCount() });

        console.log(`[Join] ${name} (${userId})`);
      } catch (err) {
        console.error("[cosmos:join] Error:", err.message);
        socket.emit("cosmos:error", { message: "Failed to join. Please retry." });
      }
    });

    /* ─────────────────────────────────────────
       MOVE
    ───────────────────────────────────────── */
    socket.on("cosmos:move", ({ x, y }) => {
      if (!currentUserId) return;

      // Clamp to world bounds
      const clampedX = Math.max(0, Math.min(2000, Number(x) || 0));
      const clampedY = Math.max(0, Math.min(1600, Number(y) || 0));

      state.updatePosition(currentUserId, { x: clampedX, y: clampedY });

      // Broadcast position to all other clients
      socket.broadcast.emit("cosmos:user_moved", {
        userId: currentUserId,
        position: { x: clampedX, y: clampedY },
      });
    });

    /* ─────────────────────────────────────────
       PROXIMITY  (client reports who is nearby)
       The client runs its own distance check and
       tells the server which users just entered /
       exited its radius.  The server validates,
       opens/closes rooms, and notifies both peers.
    ───────────────────────────────────────── */
    socket.on("cosmos:proximity", async ({ entered = [], exited = [] }) => {
      if (!currentUserId) return;

      // ── ENTERED proximity ──
      for (const peerId of entered) {
        if (!state.getUser(peerId)) continue;            // peer not online
        if (state.roomExists(currentUserId, peerId)) continue; // already connected

        const { roomId, created } = state.openRoom(currentUserId, peerId);
        if (!created) continue;

        const me = state.getUser(currentUserId);
        const peer = state.getUser(peerId);

        // Notify both sides
        socket.emit("cosmos:connected", {
          roomId,
          peer: { userId: peer.userId, name: peer.name, color: peer.color },
        });

        const peerSocket = io.sockets.sockets.get(peer.socketId);
        if (peerSocket) {
          peerSocket.emit("cosmos:connected", {
            roomId,
            peer: { userId: me.userId, name: me.name, color: me.color },
          });
        }

        // Send chat history for this pair
        const history = await ChatMessage.getHistory(roomId, 50);
        socket.emit("cosmos:history", { roomId, messages: history });
        if (peerSocket) {
          peerSocket.emit("cosmos:history", { roomId, messages: history });
        }

        console.log(`[Proximity] Connected: ${currentUserId} ↔ ${peerId} (room: ${roomId})`);
      }

      // ── EXITED proximity ──
      for (const peerId of exited) {
        if (!state.roomExists(currentUserId, peerId)) continue;

        const roomId = [currentUserId, peerId].sort().join(":::");
        const { closed } = state.closeRoom(currentUserId, peerId);
        if (!closed) continue;

        const peer = state.getUser(peerId);

        socket.emit("cosmos:disconnected", { roomId, peerId });

        if (peer) {
          const peerSocket = io.sockets.sockets.get(peer.socketId);
          if (peerSocket) {
            peerSocket.emit("cosmos:disconnected", { roomId, peerId: currentUserId });
          }
        }

        // Persist session-end marker on most recent messages in this room
        await ChatMessage.updateMany(
          { roomId, sessionEnded: false },
          { $set: { sessionEnded: true } }
        ).catch(() => {});

        console.log(`[Proximity] Disconnected: ${currentUserId} ↔ ${peerId}`);
      }

      // Persist updated position + connections to DB (debounced via MongoDB upsert)
      const user = state.getUser(currentUserId);
      if (user) {
        User.findOneAndUpdate(
          { userId: currentUserId },
          {
            $set: {
              position: user.position,
              lastSeen: new Date(),
              activeConnections: Array.from(user.connections).map((id) => ({
                userId: id,
                connectedAt: new Date(),
              })),
            },
          }
        ).catch(() => {});
      }
    });

    /* ─────────────────────────────────────────
       MESSAGE
    ───────────────────────────────────────── */
    socket.on("cosmos:message", async ({ roomId, text }) => {
      if (!currentUserId) return;
      if (!text || typeof text !== "string") return;

      const trimmed = text.trim().slice(0, 1000);
      if (!trimmed) return;

      // Validate the room — both participants must be online and connected
      const [idA, idB] = roomId.split(":::");
      if (idA !== currentUserId && idB !== currentUserId) {
        return socket.emit("cosmos:error", { message: "Not a participant of this room." });
      }
      if (!state.roomExists(idA, idB)) {
        return socket.emit("cosmos:error", { message: "Room no longer active." });
      }

      const me = state.getUser(currentUserId);
      if (!me) return;

      // 1. Persist to MongoDB
      const saved = await ChatMessage.create({
        roomId,
        senderId: currentUserId,
        senderName: me.name,
        text: trimmed,
      }).catch((err) => {
        console.error("[cosmos:message] DB error:", err.message);
        return null;
      });

      if (!saved) return;

      const payload = {
        roomId,
        message: {
          id: saved._id,
          senderId: currentUserId,
          senderName: me.name,
          text: trimmed,
          createdAt: saved.createdAt,
        },
      };

      // 2. Deliver to sender
      socket.emit("cosmos:message", payload);

      // 3. Deliver to peer
      const peerId = idA === currentUserId ? idB : idA;
      const peer = state.getUser(peerId);
      if (peer) {
        const peerSocket = io.sockets.sockets.get(peer.socketId);
        if (peerSocket) peerSocket.emit("cosmos:message", payload);
      }
    });

    /* ─────────────────────────────────────────
       DISCONNECT
    ───────────────────────────────────────── */
    socket.on("disconnect", async (reason) => {
      if (!currentUserId) return;
      console.log(`[Disconnect] ${currentUserId} — reason: ${reason}`);

      // 1. Get all rooms to close before removing user
      const closedRooms = state.removeUser(currentUserId);

      // 2. Notify all peers
      for (const { roomId, peerId } of closedRooms) {
        const peer = state.getUser(peerId);
        if (peer) {
          const peerSocket = io.sockets.sockets.get(peer.socketId);
          if (peerSocket) {
            peerSocket.emit("cosmos:disconnected", {
              roomId,
              peerId: currentUserId,
            });
          }
        }
      }

      // 3. Tell everyone the user left
      io.emit("cosmos:user_left", { userId: currentUserId });
      io.emit("cosmos:online_count", { count: state.onlineCount() });

      // 4. Persist offline status to MongoDB
      await User.markOffline(currentUserId).catch(() => {});
    });
  });
};

/* ─────────────────────────────────────────
   Helpers
───────────────────────────────────────── */

function sanitize(str, maxLen = 100) {
  if (typeof str !== "string") return "Unknown";
  return str.replace(/[<>"']/g, "").trim().slice(0, maxLen) || "Unknown";
}

function sanitizeColor(color) {
  if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
    return color;
  }
  return "#5b7fff";
}