/**
 * Tests for StateManager — the in-memory state layer.
 */

// Reset the singleton between tests by clearing its maps
const state = require("../../../../../Dropbox/PC/Downloads/Virtual-Cosmos-main/Virtual-Cosmos-main/src/socket/StateManager");

const USER_A = { userId: "user_a", socketId: "sock_a", name: "Alpha", color: "#5b7fff", position: { x: 100, y: 100 } };
const USER_B = { userId: "user_b", socketId: "sock_b", name: "Beta",  color: "#3dff9a", position: { x: 150, y: 100 } };
const USER_C = { userId: "user_c", socketId: "sock_c", name: "Gamma", color: "#ff5ba8", position: { x: 900, y: 900 } };

function freshState() {
  state.users.clear();
  state.rooms.clear();
}

describe("StateManager — user lifecycle", () => {
  beforeEach(freshState);

  test("addUser stores a user", () => {
    state.addUser(USER_A);
    expect(state.getUser("user_a")).toMatchObject({ userId: "user_a", name: "Alpha" });
  });

  test("removeUser cleans up the map", () => {
    state.addUser(USER_A);
    state.removeUser("user_a");
    expect(state.getUser("user_a")).toBeNull();
  });

  test("updatePosition mutates position in place", () => {
    state.addUser(USER_A);
    state.updatePosition("user_a", { x: 500, y: 600 });
    expect(state.getUser("user_a").position).toEqual({ x: 500, y: 600 });
  });

  test("getAllUsers excludes sensitive fields", () => {
    state.addUser(USER_A);
    const users = state.getAllUsers();
    expect(users[0]).not.toHaveProperty("socketId");
    expect(users[0]).not.toHaveProperty("connections");
  });

  test("onlineCount tracks active users", () => {
    expect(state.onlineCount()).toBe(0);
    state.addUser(USER_A);
    state.addUser(USER_B);
    expect(state.onlineCount()).toBe(2);
    state.removeUser("user_a");
    expect(state.onlineCount()).toBe(1);
  });
});

describe("StateManager — proximity", () => {
  beforeEach(() => {
    freshState();
    state.addUser(USER_A); // x:100, y:100
    state.addUser(USER_B); // x:150, y:100  → distance ≈ 50  (within 160)
    state.addUser(USER_C); // x:900, y:900  → far away
  });

  test("getNearbyUsers returns users within PROXIMITY_RADIUS", () => {
    const nearby = state.getNearbyUsers("user_a");
    const ids = nearby.map((u) => u.userId);
    expect(ids).toContain("user_b");
    expect(ids).not.toContain("user_c");
  });

  test("nearby entry marks connected=false before room opens", () => {
    const nearby = state.getNearbyUsers("user_a");
    const b = nearby.find((u) => u.userId === "user_b");
    expect(b.connected).toBe(false);
  });

  test("nearby entry marks connected=true after room opens", () => {
    state.openRoom("user_a", "user_b");
    const nearby = state.getNearbyUsers("user_a");
    const b = nearby.find((u) => u.userId === "user_b");
    expect(b.connected).toBe(true);
  });
});

describe("StateManager — room management", () => {
  beforeEach(() => {
    freshState();
    state.addUser(USER_A);
    state.addUser(USER_B);
  });

  test("openRoom creates a room and bi-directional connections", () => {
    const { roomId, created } = state.openRoom("user_a", "user_b");
    expect(created).toBe(true);
    expect(roomId).toBeTruthy();
    expect(state.getUser("user_a").connections.has("user_b")).toBe(true);
    expect(state.getUser("user_b").connections.has("user_a")).toBe(true);
  });

  test("openRoom is idempotent", () => {
    state.openRoom("user_a", "user_b");
    const { created } = state.openRoom("user_a", "user_b");
    expect(created).toBe(false);
  });

  test("roomId is order-independent", () => {
    const { roomId: r1 } = state.openRoom("user_a", "user_b");
    freshState();
    state.addUser(USER_A);
    state.addUser(USER_B);
    const { roomId: r2 } = state.openRoom("user_b", "user_a");
    expect(r1).toBe(r2);
  });

  test("closeRoom removes room and connections", () => {
    state.openRoom("user_a", "user_b");
    const { closed } = state.closeRoom("user_a", "user_b");
    expect(closed).toBe(true);
    expect(state.roomExists("user_a", "user_b")).toBe(false);
    expect(state.getUser("user_a").connections.has("user_b")).toBe(false);
    expect(state.getUser("user_b").connections.has("user_a")).toBe(false);
  });

  test("closeRoom on non-existent room returns closed=false", () => {
    const { closed } = state.closeRoom("user_a", "user_b");
    expect(closed).toBe(false);
  });

  test("removeUser closes all their rooms", () => {
    state.addUser(USER_C);
    state.openRoom("user_a", "user_b");
    state.openRoom("user_a", "user_c");
    const closedRooms = state.removeUser("user_a");
    expect(closedRooms.length).toBe(2);
    expect(state.getUser("user_b").connections.has("user_a")).toBe(false);
    expect(state.getUser("user_c").connections.has("user_a")).toBe(false);
  });
});