/**
 * StateManager — in-memory store for the socket layer.
 *
 * Why in-memory instead of round-tripping MongoDB on every position update?
 * Position updates fire ~60 times/second per user. Writing to MongoDB at that
 * rate is unnecessary and expensive. We keep a hot map in RAM and only persist
 * to MongoDB for events that matter long-term: joins, disconnects, messages.
 *
 * Structure:
 *   users   Map<userId, UserState>
 *   rooms   Map<roomId, RoomState>
 */

const PROXIMITY_RADIUS = Number(process.env.PROXIMITY_RADIUS) || 160;

class StateManager {
  constructor() {
    /** @type {Map<string, UserState>} */
    this.users = new Map();

    /** @type {Map<string, RoomState>} */
    this.rooms = new Map();
  }

  /* ───────────────────────────── USER OPS ─────────────────────────────── */

  /**
   * Register or refresh a user in the hot map.
   * @param {object} data  { userId, socketId, name, color, position }
   */
  addUser({ userId, socketId, name, color, position }) {
    this.users.set(userId, {
      userId,
      socketId,
      name,
      color,
      position: position || { x: 1000, y: 800 },
      connections: new Set(),   // Set<peerId>
      joinedAt: Date.now(),
    });
  }

  /**
   * Remove a user and clean up all their rooms.
   * Returns the list of roomIds that were closed.
   */
  removeUser(userId) {
    const user = this.users.get(userId);
    if (!user) return [];

    const closedRooms = [];
    for (const peerId of user.connections) {
      const roomId = this._roomId(userId, peerId);
      this.rooms.delete(roomId);
      closedRooms.push({ roomId, peerId });

      // Remove the back-pointer on the peer
      const peer = this.users.get(peerId);
      if (peer) peer.connections.delete(userId);
    }

    this.users.delete(userId);
    return closedRooms;
  }

  updatePosition(userId, { x, y }) {
    const user = this.users.get(userId);
    if (user) {
      user.position = { x, y };
    }
  }

  getUser(userId) {
    return this.users.get(userId) || null;
  }

  getAllUsers() {
    return Array.from(this.users.values()).map((u) => this._publicView(u));
  }

  onlineCount() {
    return this.users.size;
  }

  /* ───────────────────────────── PROXIMITY ────────────────────────────── */

  /**
   * Given a userId, return all other users whose position is within
   * PROXIMITY_RADIUS, along with whether a room already exists for that pair.
   */
  getNearbyUsers(userId) {
    const me = this.users.get(userId);
    if (!me) return [];

    const nearby = [];
    for (const [id, other] of this.users) {
      if (id === userId) continue;
      const d = this._distance(me.position, other.position);
      if (d < PROXIMITY_RADIUS) {
        nearby.push({
          userId: other.userId,
          name: other.name,
          color: other.color,
          distance: Math.round(d),
          connected: me.connections.has(id),
        });
      }
    }
    return nearby;
  }

  /* ───────────────────────────── ROOM OPS ─────────────────────────────── */

  /**
   * Open a proximity room between two users.
   * Idempotent — returns existing room if already open.
   */
  openRoom(userIdA, userIdB) {
    const roomId = this._roomId(userIdA, userIdB);
    if (this.rooms.has(roomId)) return { roomId, created: false };

    this.rooms.set(roomId, {
      roomId,
      participants: new Set([userIdA, userIdB]),
      openedAt: Date.now(),
    });

    const a = this.users.get(userIdA);
    const b = this.users.get(userIdB);
    if (a) a.connections.add(userIdB);
    if (b) b.connections.add(userIdA);

    return { roomId, created: true };
  }

  /**
   * Close a proximity room between two users.
   * Returns { roomId, closed: bool }.
   */
  closeRoom(userIdA, userIdB) {
    const roomId = this._roomId(userIdA, userIdB);
    if (!this.rooms.has(roomId)) return { roomId, closed: false };

    this.rooms.delete(roomId);

    const a = this.users.get(userIdA);
    const b = this.users.get(userIdB);
    if (a) a.connections.delete(userIdB);
    if (b) b.connections.delete(userIdA);

    return { roomId, closed: true };
  }

  roomExists(userIdA, userIdB) {
    return this.rooms.has(this._roomId(userIdA, userIdB));
  }

  /* ───────────────────────────── HELPERS ─────────────────────────────── */

  _roomId(a, b) {
    return [a, b].sort().join(":::");
  }

  _distance(posA, posB) {
    const dx = posA.x - posB.x;
    const dy = posA.y - posB.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _publicView(u) {
    return {
      userId: u.userId,
      name: u.name,
      color: u.color,
      position: u.position,
      connectionCount: u.connections.size,
    };
  }
}

// Export a singleton — shared across all socket handlers in the process
module.exports = new StateManager();