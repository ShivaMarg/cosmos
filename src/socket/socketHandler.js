/**
 * socketHandler — wires all Socket.IO events for one connected client.
 *
 * Events (client → server):
 *   cosmos:join        { userId, name, color, position }
 *   cosmos:move        { x, y }
 *   cosmos:proximity   { entered: string[], exited: string[] }
 *   cosmos:message     { roomId, text }
 *   cosmos:disconnect  (built-in socket event)
 *
 * Events (server → client):
 *   cosmos:welcome     { user, onlineUsers[] }           to the joiner
 *   cosmos:user_joined { user }                          to everyone else
 *   cosmos:user_moved  { userId, x, y }                 to everyone  ← flat x/y now
 *   cosmos:connected   { roomId, peer }                  to both peers
 *   cosmos:disconnected{ roomId, peerId }                to both peers
 *   cosmos:message     { roomId, message }               to room participants
 *   cosmos:history     { roomId, messages[] }            to requester
 *   cosmos:user_left   { userId }                        to everyone
 *   cosmos:online_count{ count }                         to everyone
 */

const User = require("../models/User");
const ChatMessage = require("../models/ChatMessage");
const state = require("./stateManager");

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

        const safeName  = sanitize(name, 24);
        const safeColor = sanitizeColor(color);
        const safePos   = sanitizePosition(position);

        // 1. Upsert in MongoDB
        await User.upsertOnJoin({
          userId,
          name: safeName,
          color: safeColor,
          socketId: socket.id,
          position: safePos,
        });

        // 2. Register in hot state — store x/y flat for easy access
        state.addUser({
          userId,
          socketId: socket.id,
          name: safeName,
          color: safeColor,
          x: safePos.x,
          y: safePos.y,
        });

        const me = state.getUser(userId);

        // 3. Tell the joiner about every other online user
        //    Send position as both flat (x,y) and nested for compatibility
        socket.emit("cosmos:welcome", {
          user: me,
          onlineUsers: state.getAllUsers()
            .filter((u) => u.userId !== userId)
            .map(flatUser),
        });

        // 4. Tell everyone else about the new joiner
        socket.broadcast.emit("cosmos:user_joined", { user: flatUser(me) });

        // 5. Broadcast updated count
        io.emit("cosmos:online_count", { count: state.onlineCount() });

        console.log(`[Join] ${safeName} (${userId})`);
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

      const clampedX = Math.max(0, Math.min(2000, Number(x) || 0));
      const clampedY = Math.max(0, Math.min(1600, Number(y) || 0));

      // Update hot state with flat x/y
      state.updatePosition(currentUserId, { x: clampedX, y: clampedY });

      // Broadcast flat x/y so client can do:  otherUsers[id].x = x; otherUsers[id].y = y;
      socket.broadcast.emit("cosmos:user_moved", {
        userId: currentUserId,
        x: clampedX,
        y: clampedY,
      });
    });

    /* ─────────────────────────────────────────
       PROXIMITY  (client reports who entered / exited)
    ───────────────────────────────────────── */
    socket.on("cosmos:proximity", async ({ entered = [], exited = [] }) => {
      if (!currentUserId) return;

      // ── ENTERED proximity ──
      for (const peerId of entered) {
        if (!state.getUser(peerId)) continue;
        if (state.roomExists(currentUserId, peerId)) continue;

        const { roomId, created } = state.openRoom(currentUserId, peerId);
        if (!created) continue;

        const me   = state.getUser(currentUserId);
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

        // Mark session ended on persisted messages
        await ChatMessage.updateMany(
          { roomId, sessionEnded: false },
          { $set: { sessionEnded: true } }
        ).catch(() => {});

        console.log(`[Proximity] Disconnected: ${currentUserId} ↔ ${peerId}`);
      }

      // Persist updated position + connections to DB
      const user = state.getUser(currentUserId);
      if (user) {
        User.findOneAndUpdate(
          { userId: currentUserId },
          {
            $set: {
              position: { x: user.x, y: user.y },
              lastSeen: new Date(),
              activeConnections: Array.from(user.connections || []).map((id) => ({
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

      // Validate room — sender must be a participant and room must be active
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
      const peer   = state.getUser(peerId);
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

      // 1. Close all rooms and get the list
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

      // 4. Persist offline status
      await User.markOffline(currentUserId).catch(() => {});
    });
  });
};

/* ─────────────────────────────────────────
   Helpers
───────────────────────────────────────── */

/** Return a plain user object with flat x/y AND nested position for compatibility */
function flatUser(u) {
  return {
    userId:   u.userId,
    name:     u.name,
    color:    u.color,
    x:        u.x ?? u.position?.x ?? 1000,
    y:        u.y ?? u.position?.y ?? 800,
    position: { x: u.x ?? u.position?.x ?? 1000, y: u.y ?? u.position?.y ?? 800 },
  };
}

function sanitize(str, maxLen = 100) {
  if (typeof str !== "string") return "Unknown";
  return str.replace(/[<>"']/g, "").trim().slice(0, maxLen) || "Unknown";
}

function sanitizeColor(color) {
  if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) return color;
  return "#5b7fff";
}

function sanitizePosition(pos) {
  const x = Math.max(0, Math.min(2000, Number(pos?.x) || 1000));
  const y = Math.max(0, Math.min(1600, Number(pos?.y) || 800));
  return { x, y };
}