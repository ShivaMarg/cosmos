const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/cosmos";

  const options = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  };

  try {
    await mongoose.connect(uri, options);
    console.log(`[DB] Connected → ${mongoose.connection.host}`);
  } catch (err) {
    console.error("[DB] Connection failed:", err.message);
    // Retry after 5 s in non-test environments
    if (process.env.NODE_ENV !== "test") {
      console.log("[DB] Retrying in 5 s…");
      await new Promise((r) => setTimeout(r, 5000));
      return connectDB();
    }
    throw err;
  }

  mongoose.connection.on("disconnected", () => {
    console.warn("[DB] Disconnected — attempting reconnect…");
  });
  mongoose.connection.on("error", (err) => {
    console.error("[DB] Error:", err.message);
  });
}

module.exports = connectDB;