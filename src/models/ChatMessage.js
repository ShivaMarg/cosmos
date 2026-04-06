const mongoose = require("mongoose");

/**
 * ChatMessage — one message exchanged between two users while in proximity.
 *
 * roomId is a deterministic string built from the two sorted userIds so both
 * participants share the same conversation thread regardless of who initiated.
 *   e.g. "user_abc:::user_xyz"
 */
const chatMessageSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      index: true,
    },
    senderId: {
      type: String,
      required: true,
    },
    senderName: {
      type: String,
      required: true,
    },
    text: {
      type: String,
      required: true,
      maxlength: 1000,
      trim: true,
    },
    // Soft marker — set to true when users drift apart after this message
    sessionEnded: { type: Boolean, default: false },
  },
  {
    timestamps: true,   // createdAt, updatedAt
    versionKey: false,
    toJSON: {
      transform(_, ret) {
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
  }
);

/* Compound index for fast room history look-ups, newest first */
chatMessageSchema.index({ roomId: 1, createdAt: -1 });

/* TTL — keep messages for 7 days */
chatMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

/* ─────────────────────────────────────────
   Statics
───────────────────────────────────────── */

/**
 * Build a stable, order-independent room ID from two userIds.
 */
chatMessageSchema.statics.buildRoomId = function (idA, idB) {
  return [idA, idB].sort().join(":::");
};

/**
 * Fetch the last N messages for a room.
 */
chatMessageSchema.statics.getHistory = async function (roomId, limit = 50) {
  return this.find({ roomId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
    .then((msgs) => msgs.reverse()); // oldest first for display
};

module.exports = mongoose.model("ChatMessage", chatMessageSchema);