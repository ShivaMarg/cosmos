require("dotenv").config();

const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const connectDB = require("./config/db");
const apiRoutes = require("./routes/api");
const registerSocketHandlers = require("./socket/socketHandler");
const { rateLimiter } = require("../ratelimiter");

/* ─────────────────────────────────────────
   App setup
───────────────────────────────────────── */
const app = express();
const httpServer = http.createServer(app);

/* ─────────────────────────────────────────
   CORS config
   Reads from ALLOWED_ORIGINS env — comma-separated.
   Example: http://localhost:5173,https://cosmos.yourdomain.com
───────────────────────────────────────── */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());

const corsOptions = {
  origin(origin, callback) {
    // Allow requests with no origin (e.g. mobile apps, curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked for origin: ${origin}`));
    }
  },
  methods: ["GET", "POST"],
  credentials: true,
};

/* ─────────────────────────────────────────
   Socket.IO
───────────────────────────────────────── */
const io = new Server(httpServer, {
  cors: corsOptions,
  // Tune transports — prefer WebSocket, fall back to polling
  transports: ["websocket", "polling"],
  // Ping the client every 25 s; disconnect after 60 s of silence
  pingInterval: 25_000,
  pingTimeout: 60_000,
  // Max payload size (bytes) — prevent oversized payloads
  maxHttpBufferSize: 1e5,
});

/* ─────────────────────────────────────────
   Express middleware
───────────────────────────────────────── */
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: "10kb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Rate limit REST API only (socket events are handled separately)
app.use("/api", rateLimiter({ windowMs: 60_000, max: 120 }));

/* ─────────────────────────────────────────
   REST routes
───────────────────────────────────────── */
app.use("/api", apiRoutes);

// 404 catch-all for unmatched routes
app.use((req, res) => {
  res.status(404).json({ error: "Route not found." });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error("[Express]", err.message);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Internal server error." });
});

/* ─────────────────────────────────────────
   Socket event handlers
───────────────────────────────────────── */
registerSocketHandlers(io);

/* ─────────────────────────────────────────
   Start
───────────────────────────────────────── */
async function start() {
  if (process.env.NODE_ENV !== "test") {
    await connectDB();
  }

  const PORT = Number(process.env.PORT) || 3001;
  httpServer.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════╗
║       COSMOS backend running         ║
║  http://localhost:${PORT}               ║
╚══════════════════════════════════════╝
    `);
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM received — shutting down…");
  httpServer.close(() => process.exit(0));
});

module.exports = { app, httpServer, io }; // export for tests