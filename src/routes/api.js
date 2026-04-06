const express = require("express");
const router = express.Router();
const User = require("../models/User");
const ChatMessage = require("../models/ChatMessage");
const state = require("../socket/StateManager");

/* ─────────────────────────────────────────
   GET /api/users/online
   Returns all currently online users with live position from hot state.
───────────────────────────────────────── */
router.get("/users/online", async (req, res) => {
  try {
    const liveUsers = state.getAllUsers();
    res.json({ users: liveUsers, count: liveUsers.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch online users." });
  }
});

/* ─────────────────────────────────────────
   GET /api/users/:userId
   Returns a single user's public profile.
───────────────────────────────────────── */
router.get("/users/:userId", async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId })
      .select("-socketId")
      .lean();
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user." });
  }
});

/* ─────────────────────────────────────────
   GET /api/chat/history
   Query params: userA, userB, limit (default 50)
   Returns paginated message history for a room.
───────────────────────────────────────── */
router.get("/chat/history", async (req, res) => {
  const { userA, userB, limit = 50 } = req.query;

  if (!userA || !userB) {
    return res.status(400).json({ error: "userA and userB are required." });
  }

  const roomId = ChatMessage.buildRoomId(userA, userB);
  const safeLimit = Math.min(Number(limit) || 50, 200);

  try {
    const messages = await ChatMessage.getHistory(roomId, safeLimit);
    res.json({ roomId, messages, count: messages.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch chat history." });
  }
});

/* ─────────────────────────────────────────
   GET /api/chat/rooms/:userId
   Returns all rooms (with last message) for a user.
───────────────────────────────────────── */
router.get("/chat/rooms/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    // Find all unique roomIds that contain this userId
    const rooms = await ChatMessage.aggregate([
      {
        $match: {
          roomId: { $regex: userId },
        },
      },
      {
        $sort: { createdAt: -1 },
      },
      {
        $group: {
          _id: "$roomId",
          lastMessage: { $first: "$$ROOT" },
          messageCount: { $sum: 1 },
        },
      },
      {
        $project: {
          roomId: "$_id",
          lastMessage: 1,
          messageCount: 1,
          _id: 0,
        },
      },
      { $sort: { "lastMessage.createdAt": -1 } },
      { $limit: 20 },
    ]);

    res.json({ rooms });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch rooms." });
  }
});

/* ─────────────────────────────────────────
   GET /api/health
   Simple liveness check for monitoring / load balancers.
───────────────────────────────────────── */
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    onlineUsers: state.onlineCount(),
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;