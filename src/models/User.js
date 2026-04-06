const mongoose = require("mongoose");

/* ─────────────────────────────────────────
   Sub-schemas
───────────────────────────────────────── */

const positionSchema = new mongoose.Schema(
  {
    x: { type: Number, required: true, default: 1000 },
    y: { type: Number, required: true, default: 800 },
  },
  { _id: false }
);

const connectionSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },   // the other user's userId (UUID)
    connectedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/* ─────────────────────────────────────────
   Main User schema
───────────────────────────────────────── */

const userSchema = new mongoose.Schema(
  {
    // Public identity (set on entry)
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 24,
    },
    color: {
      type: String,
      required: true,
      match: /^#[0-9a-fA-F]{6}$/,
      default: "#5b7fff",
    },

    // Live state
    position: { type: positionSchema, default: () => ({ x: 1000, y: 800 }) },
    isOnline: { type: Boolean, default: true, index: true },
    socketId: { type: String, default: null },

    // Active peer connections (bilateral, maintained by socket layer)
    activeConnections: { type: [connectionSchema], default: [] },

    // Soft-delete / expiry — TTL index cleans up stale sessions automatically
    lastSeen: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: true,
    // Strip __v from JSON output
    versionKey: false,
    toJSON: {
      transform(_, ret) {
        delete ret._id;
        return ret;
      },
    },
  }
);

/* TTL index: MongoDB auto-removes documents where
   lastSeen is older than SESSION_TTL seconds (default 24 h).
   You can override SESSION_TTL via env. */
userSchema.index(
  { lastSeen: 1 },
  { expireAfterSeconds: Number(process.env.SESSION_TTL) || 86400 }
);

/* ─────────────────────────────────────────
   Statics
───────────────────────────────────────── */

/**
 * Upsert a user on socket join.
 * Creates the document if absent, updates name/color/socket if it already exists.
 */
userSchema.statics.upsertOnJoin = async function ({
  userId,
  name,
  color,
  socketId,
  position,
}) {
  return this.findOneAndUpdate(
    { userId },
    {
      $set: {
        name,
        color,
        socketId,
        isOnline: true,
        lastSeen: new Date(),
        ...(position && { position }),
      },
      $setOnInsert: { activeConnections: [] },
    },
    { upsert: true, new: true, runValidators: true }
  );
};

/**
 * Mark a user offline on disconnect.
 */
userSchema.statics.markOffline = async function (userId) {
  return this.findOneAndUpdate(
    { userId },
    {
      $set: {
        isOnline: false,
        socketId: null,
        activeConnections: [],
        lastSeen: new Date(),
      },
    },
    { new: true }
  );
};

/**
 * Fetch all currently online users (for new joiner snapshot).
 */
userSchema.statics.getOnlineUsers = async function () {
  return this.find({ isOnline: true }).lean();
};

/* ─────────────────────────────────────────
   Instance methods
───────────────────────────────────────── */

/**
 * Add a bilateral connection entry.
 * Idempotent — won't duplicate.
 */
userSchema.methods.addConnection = async function (peerId) {
  const alreadyConnected = this.activeConnections.some(
    (c) => c.userId === peerId
  );
  if (!alreadyConnected) {
    this.activeConnections.push({ userId: peerId, connectedAt: new Date() });
    await this.save();
  }
  return this;
};

/**
 * Remove a connection entry.
 */
userSchema.methods.removeConnection = async function (peerId) {
  this.activeConnections = this.activeConnections.filter(
    (c) => c.userId !== peerId
  );
  await this.save();
  return this;
};

module.exports = mongoose.model("User", userSchema);