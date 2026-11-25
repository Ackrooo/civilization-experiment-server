const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const allowedOrigin = process.env.CLIENT_ORIGIN || "https://ackrooo.github.io";

const io = new Server(httpServer, {
  cors: {
    origin: [allowedOrigin, "http://localhost:8000", "http://127.0.0.1:8000"],
    methods: ["GET", "POST"]
  }
});

app.get("/", (_req, res) => {
  res.json({ name: "Civilization Experiment Multiplayer Server", status: "online" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, connectedPlayers: io.engine.clientsCount });
});

const rooms = new Map();

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

io.on("connection", (socket) => {
  socket.on("create-room", (callback) => {
    let code;
    do { code = makeCode(); } while (rooms.has(code));
    rooms.set(code, { players: new Map(), createdAt: Date.now() });
    joinRoom(socket, code);
    if (typeof callback === "function") callback({ ok: true, code });
  });

  socket.on("join-room", (rawCode, callback) => {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!rooms.has(code)) {
      if (typeof callback === "function") callback({ ok: false, error: "Room not found." });
      return;
    }
    joinRoom(socket, code);
    if (typeof callback === "function") callback({ ok: true, code });
  });

  socket.on("player-update", (data) => {
    const code = socket.data.roomCode;
    if (!code || !rooms.has(code) || !data || typeof data !== "object") return;
    const safe = {
      x: Number.isFinite(data.x) ? data.x : 0,
      y: Number.isFinite(data.y) ? data.y : 0,
      name: String(data.name || "Player").slice(0, 24)
    };
    rooms.get(code).players.set(socket.id, safe);
    socket.to(code).emit("player-updated", { id: socket.id, ...safe });
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code || !rooms.has(code)) return;
    const room = rooms.get(code);
    room.players.delete(socket.id);
    socket.to(code).emit("player-left", { id: socket.id });
    if (room.players.size === 0) rooms.delete(code);
    else io.to(code).emit("room-players", [...room.players.entries()].map(([id, p]) => ({ id, ...p })));
  });
});

function joinRoom(socket, code) {
  const previous = socket.data.roomCode;
  if (previous && rooms.has(previous)) {
    rooms.get(previous).players.delete(socket.id);
    socket.to(previous).emit("player-left", { id: socket.id });
  }
  socket.join(code);
  socket.data.roomCode = code;
  const room = rooms.get(code);
  room.players.set(socket.id, { x: 0, y: 0, name: "Player" });
  socket.emit("room-players", [...room.players.entries()].map(([id, p]) => ({ id, ...p })));
  socket.to(code).emit("player-joined", { id: socket.id, x: 0, y: 0, name: "Player" });
}

const port = Number(process.env.PORT) || 3000;
httpServer.listen(port, "0.0.0.0", () => {
  console.log("Civilization Experiment server listening on port " + port);
});
