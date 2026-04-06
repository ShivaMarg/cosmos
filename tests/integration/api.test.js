/**
 * Integration tests for REST API endpoints.
 * Uses supertest — no real DB needed for most checks.
 */

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://localhost:27017/cosmos_test";

const request = require("supertest");
const { app } = require("../../../../../Dropbox/PC/Downloads/Virtual-Cosmos-main/Virtual-Cosmos-main/src/server");
const state = require("../../../../../Dropbox/PC/Downloads/Virtual-Cosmos-main/Virtual-Cosmos-main/src/socket/StateManager");

describe("GET /api/health", () => {
  test("returns 200 with status ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.onlineUsers).toBe("number");
    expect(typeof res.body.uptime).toBe("number");
  });
});

describe("GET /api/users/online", () => {
  beforeAll(() => {
    state.users.clear();
    state.rooms.clear();
  });

  test("returns empty array when no users online", async () => {
    const res = await request(app).get("/api/users/online");
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  test("returns live users from hot state", async () => {
    state.addUser({
      userId: "u1", socketId: "s1", name: "Alice",
      color: "#5b7fff", position: { x: 100, y: 200 }
    });
    const res = await request(app).get("/api/users/online");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.users[0].name).toBe("Alice");
    state.removeUser("u1");
  });
});

describe("GET /api/chat/history", () => {
  test("400 when userA or userB missing", async () => {
    const res = await request(app).get("/api/chat/history?userA=abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });
});

describe("404 handler", () => {
  test("returns 404 for unknown routes", async () => {
    const res = await request(app).get("/api/does-not-exist-xyz");
    expect(res.status).toBe(404);
  });
});