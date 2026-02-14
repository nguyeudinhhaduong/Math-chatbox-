const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// JSON FILE DATABASE
// =====================================================
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "database.json");

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(path.join(__dirname, "public")))
  fs.mkdirSync(path.join(__dirname, "public"), { recursive: true });

const DEFAULT_DB = {
  servers: [],
  conversations: [],
  messages: [],
  settings: {},
  _meta: { version: 1, created_at: new Date().toISOString() },
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Error loading database:", e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("Error saving database:", e.message);
  }
}

let db = loadDB();

function now() {
  return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

function nextId(arr) {
  if (!arr || arr.length === 0) return 1;
  return Math.max(...arr.map((i) => i.id || 0)) + 1;
}

// =====================================================
// MIDDLEWARE
// =====================================================
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    const ts = new Date().toLocaleTimeString("vi-VN");
    console.log(`  [${ts}] ${req.method} ${req.path}`);
  }
  next();
});

// =====================================================
// API - SERVERS
// =====================================================

app.get("/api/servers", (req, res) => {
  res.json({ servers: db.servers || [] });
});

app.post("/api/servers", (req, res) => {
  const { name, url, model, description, is_default } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: "Ten va URL la bat buoc" });
  }

  if (is_default) {
    db.servers.forEach((s) => (s.is_default = false));
  }

  const server = {
    id: nextId(db.servers),
    name,
    url: url.replace(/\/$/, ""),
    model: model || "",
    description: description || "",
    is_active: false,
    is_default: !!is_default,
    last_connected_at: null,
    created_at: now(),
    updated_at: now(),
  };

  db.servers.push(server);
  saveDB(db);
  res.json({ server, message: "Da them server thanh cong" });
});

app.put("/api/servers/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const server = db.servers.find((s) => s.id === id);
  if (!server) return res.status(404).json({ error: "Server khong ton tai" });

  const { name, url, model, description } = req.body;
  if (name !== undefined) server.name = name;
  if (url !== undefined) server.url = url.replace(/\/$/, "");
  if (model !== undefined) server.model = model;
  if (description !== undefined) server.description = description;
  server.updated_at = now();

  saveDB(db);
  res.json({ server, message: "Da cap nhat server" });
});

app.delete("/api/servers/:id", (req, res) => {
  const id = parseInt(req.params.id);
  db.servers = db.servers.filter((s) => s.id !== id);
  saveDB(db);
  res.json({ message: "Da xoa server" });
});

app.post("/api/servers/:id/connect", async (req, res) => {
  const id = parseInt(req.params.id);
  const server = db.servers.find((s) => s.id === id);
  if (!server) return res.status(404).json({ error: "Server khong ton tai" });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${server.url}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();

      db.servers.forEach((s) => (s.is_active = false));
      server.is_active = true;
      server.last_connected_at = now();
      server.updated_at = now();
      if (data.model) server.model = data.model;

      saveDB(db);
      res.json({
        connected: true,
        server,
        remote: data,
        message: "Ket noi thanh cong",
      });
    } else {
      res.json({ connected: false, error: "Server tra ve loi" });
    }
  } catch (e) {
    server.is_active = false;
    saveDB(db);
    res.json({ connected: false, error: "Khong the ket noi den server" });
  }
});

app.post("/api/servers/:id/default", (req, res) => {
  const id = parseInt(req.params.id);
  db.servers.forEach((s) => (s.is_default = s.id === id));
  saveDB(db);
  const server = db.servers.find((s) => s.id === id);
  res.json({ server, message: "Da dat lam server mac dinh" });
});

app.get("/api/servers/active", (req, res) => {
  const server = db.servers.find((s) => s.is_active) || null;
  res.json({ server });
});

// =====================================================
// API - PROXY CHAT (forward to Kaggle)
// =====================================================

app.post("/api/chat", async (req, res) => {
  const { message, history, conversation_id, server_id } = req.body;
  if (!message) return res.status(400).json({ error: "Message la bat buoc" });

  let server;
  if (server_id) {
    server = db.servers.find((s) => s.id === server_id);
  } else {
    server = db.servers.find((s) => s.is_active);
  }

  if (!server) {
    return res.status(400).json({ error: "Chua co server nao duoc ket noi" });
  }

  // Create or reuse conversation
  let convId = conversation_id;
  let conv = convId ? db.conversations.find((c) => c.id === convId) : null;

  if (!conv) {
    convId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    conv = {
      id: convId,
      title: message.substring(0, 60),
      server_id: server.id,
      server_name: server.name,
      created_at: now(),
      updated_at: now(),
    };
    db.conversations.unshift(conv);
  }

  // Save user message
  db.messages.push({
    id: nextId(db.messages),
    conversation_id: convId,
    role: "user",
    content: message,
    model: "",
    created_at: now(),
  });
  conv.updated_at = now();
  saveDB(db);

  // Forward to Kaggle server
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);

    const response = await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history: history || [] }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();

      db.messages.push({
        id: nextId(db.messages),
        conversation_id: convId,
        role: "assistant",
        content: data.response,
        model: data.model || server.model || "",
        created_at: now(),
      });
      conv.updated_at = now();
      saveDB(db);

      res.json({
        response: data.response,
        model: data.model || server.model,
        conversation_id: convId,
        server_name: server.name,
      });
    } else {
      const errData = await response.json().catch(() => ({}));
      res.status(response.status).json({
        error: errData.error || "Loi tu AI server",
        conversation_id: convId,
      });
    }
  } catch (e) {
    const errMsg =
      e.name === "AbortError"
        ? "Request timeout (3 phut)"
        : "Khong the ket noi den AI server";

    db.messages.push({
      id: nextId(db.messages),
      conversation_id: convId,
      role: "assistant",
      content: `❌ ${errMsg}`,
      model: "",
      created_at: now(),
    });
    saveDB(db);

    res.status(502).json({ error: errMsg, conversation_id: convId });
  }
});

// =====================================================
// API - CONVERSATIONS
// =====================================================

app.get("/api/conversations", (req, res) => {
  const convs = (db.conversations || [])
    .sort(
      (a, b) =>
        new Date(b.updated_at || 0).getTime() -
        new Date(a.updated_at || 0).getTime(),
    )
    .slice(0, 100)
    .map((c) => ({
      ...c,
      message_count: db.messages.filter((m) => m.conversation_id === c.id)
        .length,
    }));
  res.json({ conversations: convs });
});

app.get("/api/conversations/:id", (req, res) => {
  const conv = db.conversations.find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: "Khong tim thay" });

  const messages = db.messages
    .filter((m) => m.conversation_id === req.params.id)
    .sort((a, b) => a.id - b.id);

  res.json({ conversation: conv, messages });
});

app.delete("/api/conversations/:id", (req, res) => {
  db.messages = db.messages.filter((m) => m.conversation_id !== req.params.id);
  db.conversations = db.conversations.filter((c) => c.id !== req.params.id);
  saveDB(db);
  res.json({ message: "Da xoa cuoc tro chuyen" });
});

app.put("/api/conversations/:id", (req, res) => {
  const conv = db.conversations.find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: "Khong tim thay" });
  if (req.body.title) conv.title = req.body.title;
  conv.updated_at = now();
  saveDB(db);
  res.json({ message: "Da cap nhat" });
});

// =====================================================
// API - REMOTE STATS (proxy to Kaggle)
// =====================================================

app.get("/api/remote/stats", async (req, res) => {
  const server = db.servers.find((s) => s.is_active);
  if (!server) {
    return res.json({
      active_users: 0,
      total_batches: 0,
      total_requests: 0,
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${server.url}/api/stats`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      res.json(await response.json());
    } else {
      res.json({
        active_users: 0,
        total_batches: 0,
        total_requests: 0,
        error: "offline",
      });
    }
  } catch {
    server.is_active = false;
    saveDB(db);
    res.json({
      active_users: 0,
      total_batches: 0,
      total_requests: 0,
      error: "disconnected",
    });
  }
});

app.get("/api/remote/models", async (req, res) => {
  const server = db.servers.find((s) => s.is_active);
  if (!server) return res.json({ models: [], current: "" });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${server.url}/api/models`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.ok) res.json(await response.json());
    else res.json({ models: [], current: "" });
  } catch {
    res.json({ models: [], current: "" });
  }
});

// =====================================================
// API - SETTINGS
// =====================================================

app.get("/api/settings", (req, res) => {
  res.json({ settings: db.settings || {} });
});

app.put("/api/settings", (req, res) => {
  Object.assign(db.settings, req.body.settings || {});
  saveDB(db);
  res.json({ message: "Da luu cai dat" });
});

// =====================================================
// HEALTH
// =====================================================

app.get("/api/health", (req, res) => {
  const activeServer = db.servers.find((s) => s.is_active);
  res.json({
    status: "ok",
    backend: "running",
    active_server: activeServer
      ? {
          id: activeServer.id,
          name: activeServer.name,
          url: activeServer.url,
          model: activeServer.model,
        }
      : null,
    total_servers: db.servers.length,
    total_conversations: db.conversations.length,
    timestamp: new Date().toISOString(),
  });
});

// =====================================================
// SERVE FRONTEND
// =====================================================

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, () => {
  console.log("");
  console.log("  " + "=".repeat(50));
  console.log("  🧮  Math AI Chatbox Backend");
  console.log("  " + "=".repeat(50));
  console.log(`  🌐 Server:         http://localhost:${PORT}`);
  console.log(`  📁 Database:       ./data/database.json`);
  console.log(`  📂 Frontend:       ./public/`);
  console.log(`  🖥️  Saved servers:  ${db.servers.length}`);
  console.log(`  💬 Conversations:  ${db.conversations.length}`);
  console.log("  " + "=".repeat(50));
  console.log(`  👉 Mo trinh duyet: http://localhost:${PORT}`);
  console.log("  " + "=".repeat(50));
  console.log("");
});

process.on("SIGINT", () => {
  console.log("\n  Dang dong server...");
  saveDB(db);
  process.exit(0);
});

process.on("SIGTERM", () => {
  saveDB(db);
  process.exit(0);
});
