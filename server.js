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
for (let i = 1; i <= 3; i++) rooms.set("PUBLIC-" + i, { players: new Map(), createdAt: Date.now(), ownerId: null, ownerToken: "", isPublic: true });

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

io.on("connection", (socket) => {
  socket.on("join-public", (data, callback) => {
    const serverId = Number(data?.serverId);
    if (![1, 2, 3].includes(serverId)) { if (typeof callback === "function") callback({ ok: false, error: "Invalid public server." }); return; }
    const code = "PUBLIC-" + serverId;
    joinRoom(socket, code, data?.name);
    if (typeof callback === "function") callback({ ok: true, serverId, code, public: true });
  });

  socket.on("create-room", (profile, callback) => {
    if (typeof profile === "function") { callback = profile; profile = {}; }
    let code;
    do { code = makeCode(); } while (rooms.has(code));
    const ownerToken = String(profile?.ownerToken || "");
    if (ownerToken.length < 12) { if (typeof callback === "function") callback({ok:false,error:"Owner session could not be created. Please try again."}); return; }
    rooms.set(code, { players: new Map(), createdAt: Date.now(), ownerId: socket.id, ownerToken });
    joinRoom(socket, code, profile?.name);
    if (typeof callback === "function") callback({ ok: true, code, owner: true });
  });

  socket.on("join-room", (rawCode, profile, callback) => {
    if (typeof profile === "function") { callback = profile; profile = {}; }
    if (typeof rawCode === "object" && rawCode) { profile = rawCode; rawCode = profile.code; }
    const code = String(rawCode || "").trim().toUpperCase();
    if (!rooms.has(code)) { if (typeof callback === "function") callback({ ok: false, error: "Room not found." }); return; }
    const room = rooms.get(code);
    const isOwner = !!profile?.ownerToken && profile.ownerToken === room.ownerToken;
    joinRoom(socket, code, profile?.name, isOwner);
    if (typeof callback === "function") callback({ ok: true, code, owner: isOwner });
  });

  socket.on("owner-command", (data, callback) => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    const authorized = !!room && (room.ownerId === socket.id || (!!data?.ownerToken && data.ownerToken === room.ownerToken));
    if (!authorized) { if (typeof callback === "function") callback({ ok: false, error: "Only the connected private server owner can use commands." }); return; }
    if (room.ownerId !== socket.id) { room.ownerId = socket.id; io.to(code).emit("owner-changed", { id: socket.id }); }
    const commandId = String(data?.commandId || "").slice(0, 100);
    if (!/^[a-z0-9:_-]+$/i.test(commandId)) { if (typeof callback === "function") callback({ ok: false, error: "Invalid command." }); return; }
    if (commandId === "server-reset") {
      const seed = String(Math.floor(Math.random() * 2147483647));
      io.to(code).emit("server-reset", { seed });
      if (typeof callback === "function") callback({ ok: true, reset: true });
      return;
    }
    io.to(code).emit("owner-command", { commandId });
    if (typeof callback === "function") callback({ ok: true });
  });

  socket.on("player-update", (data) => {
    const code = socket.data.roomCode;
    if (!code || !rooms.has(code) || !data || typeof data !== "object") return;
    const room = rooms.get(code);
    const previous = room.players.get(socket.id) || {};
    const safe = {
      x: Number.isFinite(data.x) ? data.x : 0,
      y: Number.isFinite(data.y) ? data.y : 0,
      name: String(data.name || previous.name || "Player").slice(0, 24),
      inCombat: !!data.inCombat,
      onBoat: !!data.onBoat,
      civName: String(data.civName || "").slice(0, 32),
      owner: room.ownerId === socket.id || !!previous.owner
    };
    rooms.get(code).players.set(socket.id, safe);
    socket.to(code).emit("player-updated", { id: socket.id, ...safe });
  });

  socket.on("travel-request", (data, callback) => {
    const code = socket.data.roomCode, target = data?.targetId;
    if (!code || !rooms.has(code) || !target || !rooms.get(code).players.has(target)) {
      if (typeof callback === "function") callback({ ok: false, error: "That player is no longer in this room." });
      return;
    }
    const sender = rooms.get(code).players.get(socket.id);
    io.to(target).emit("travel-request", { id: socket.id, name: sender?.name || "Player" });
    if (typeof callback === "function") callback({ ok: true });
  });

  socket.on("travel-response", (data, callback) => {
    const code = socket.data.roomCode, target = data?.requesterId;
    if (!code || !rooms.has(code) || !target || !rooms.get(code).players.has(target)) {
      if (typeof callback === "function") callback({ ok: false, error: "The requesting player is no longer in this room." });
      return;
    }
    const destination = rooms.get(code).players.get(socket.id);
    // Use the coordinates captured when the destination player accepts.
    // The periodic player-update can be a tick behind the live position.
    const x = Number.isFinite(Number(data?.x)) ? Number(data.x) : (destination?.x ?? 0);
    const y = Number.isFinite(Number(data?.y)) ? Number(data.y) : (destination?.y ?? 0);
    io.to(target).emit("travel-result", {
      accepted: !!data.accepted, x, y,
      inCombat: !!destination?.inCombat || !!data.inCombat,
      onBoat: !!destination?.onBoat || !!data.onBoat,
      name: String(data?.name || destination?.name || "Player").slice(0, 24)
    });
    if (typeof callback === "function") callback({ ok: true });
  });

  socket.on("civ-invite", (data, callback) => {
    const code = socket.data.roomCode, target = data?.targetId;
    if (!code || !rooms.has(code) || !target || !rooms.get(code).players.has(target)) {
      if (typeof callback === "function") callback({ ok: false, error: "That player is no longer in this room." });
      return;
    }
    const sender = rooms.get(code).players.get(socket.id);
    io.to(target).emit("civ-invite", { id: socket.id, name: sender?.name || "Player", civName: String(data.civName || "").slice(0, 32) });
    if (typeof callback === "function") callback({ ok: true });
  });

  socket.on("civ-response", (data, callback) => {
    const code = socket.data.roomCode, target = data?.inviterId;
    if (!code || !rooms.has(code) || !target || !rooms.get(code).players.has(target)) {
      if (typeof callback === "function") callback({ ok: false, error: "The inviting player is no longer in this room." });
      return;
    }
    const responder = rooms.get(code).players.get(socket.id);
    io.to(target).emit("civ-result", { accepted: !!data.accepted, name: responder?.name || "Player", civName: String(data.civName || "").slice(0, 32) });
    if (typeof callback === "function") callback({ ok: true });
  });

  socket.on("disconnect", () => {
    leaveRoom(socket);
  });
});

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.roomCode = null;
  if (!room) return;
  room.players.delete(socket.id);
  socket.to(code).emit("player-left", { id: socket.id });
  if (room.ownerId === socket.id) {
    room.ownerId = room.players.keys().next().value || null;
    for (const player of room.players.values()) player.owner = false;
    const owner = room.ownerId && room.players.get(room.ownerId);
    if (owner) owner.owner = true;
    io.to(code).emit("owner-changed", { id: room.ownerId });
  }
  if (room.players.size === 0 && !room.isPublic) {
    rooms.delete(code);
    return;
  }
  io.to(code).emit("room-players", [...room.players.entries()].map(([id, p]) => ({ id, ...p })));
}

function joinRoom(socket, code, characterName, forceOwner = false) {
  if (socket.data.roomCode && socket.data.roomCode !== code) leaveRoom(socket);
  const room = rooms.get(code);
  if (!room) return;
  socket.join(code);
  socket.data.roomCode = code;
  const player = { x: 0, y: 0, name: String(characterName || "Player").slice(0, 24), inCombat: false, onBoat: false, civName: "", owner: forceOwner || room.ownerId === socket.id };
  if (forceOwner) {
    room.ownerId = socket.id;
    for (const p of room.players.values()) p.owner = false;
    io.to(code).emit("owner-changed", { id: socket.id });
  }
  room.players.set(socket.id, player);
  socket.emit("room-players", [...room.players.entries()].map(([id, p]) => ({ id, ...p })));
  socket.to(code).emit("player-joined", { id: socket.id, ...player });
}

const port = Number(process.env.PORT) || 3000;
httpServer.listen(port, "0.0.0.0", () => {
  console.log("Civilization Experiment server listening on port " + port);
});
