import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDistDir = path.resolve(__dirname, "../frontend/dist");
const frontendIndexFile = path.join(frontendDistDir, "index.html");

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT || 8080;

app.use(express.json());

if (existsSync(frontendDistDir)) {
  app.use(express.static(frontendDistDir));
}

const users = new Map([
  ["service", { password: "service123", role: "service" }],
  ["admin", { password: "admin123", role: "admin" }],
  ["user", { password: "user123", role: "user" }],
]);
const sessions = new Map();

const deviceState = {
  tag: "MM-FT-101",
  firmware: "1.0.0-demo",
  config: {
    setpointKgHr: 1250,
    dampingSeconds: 3,
    alarmHighKgHr: 1500,
  },
  telemetry: {
    massFlowKgHr: 1200,
    densityKgM3: 998.2,
    temperatureC: 27.1,
    tubeFrequencyHz: 267.4,
    status: "OK",
    updatedAt: new Date().toISOString(),
  },
};

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.user = sessions.get(token);
  return next();
}

function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    return next();
  };
}

function bounded(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

setInterval(() => {
  const drift = () => (Math.random() - 0.5) * 18;

  deviceState.telemetry.massFlowKgHr = bounded(deviceState.telemetry.massFlowKgHr + drift(), 850, 1650);
  deviceState.telemetry.densityKgM3 = bounded(deviceState.telemetry.densityKgM3 + (Math.random() - 0.5) * 0.8, 980, 1020);
  deviceState.telemetry.temperatureC = bounded(deviceState.telemetry.temperatureC + (Math.random() - 0.5) * 0.35, 15, 55);
  deviceState.telemetry.tubeFrequencyHz = bounded(deviceState.telemetry.tubeFrequencyHz + (Math.random() - 0.5) * 0.6, 250, 290);

  deviceState.telemetry.status =
    deviceState.telemetry.massFlowKgHr > deviceState.config.alarmHighKgHr ? "ALARM_HIGH_FLOW" : "OK";
  deviceState.telemetry.updatedAt = new Date().toISOString();
}, 1000);

app.post("/api/login", (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  const userRecord = users.get(username);

  if (!userRecord || userRecord.password !== password) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { username, role: userRecord.role, createdAt: Date.now() });
  console.log(`User ${username} (${userRecord.role}) logged in at ${new Date().toISOString()}, token: ${token}`);

  return res.json({
    token,
    user: { username, role: userRecord.role },
    device: { tag: deviceState.tag, firmware: deviceState.firmware },
  });
});

app.get("/api/users", authMiddleware, requireRole(["service"]), (req, res) => {
  const managedUsers = Array.from(users.entries()).map(([username, record]) => ({
    username,
    role: record.role,
  }));

  return res.json({ users: managedUsers });
});

app.post("/api/users", authMiddleware, requireRole(["service"]), (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const role = String(req.body?.role || "").trim().toLowerCase();

  if (username.length < 3) {
    return res.status(400).json({ error: "username must be at least 3 characters" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "password must be at least 6 characters" });
  }
  if (!["admin", "user"].includes(role)) {
    return res.status(400).json({ error: "role must be admin or user" });
  }
  if (users.has(username)) {
    return res.status(409).json({ error: "username already exists" });
  }

  users.set(username, { password, role });
  return res.status(201).json({ ok: true, user: { username, role } });
});

app.get("/api/device/telemetry", authMiddleware, (req, res) => {
  return res.json({
    ...deviceState.telemetry,
    tag: deviceState.tag,
    firmware: deviceState.firmware,
  });
});

app.get("/api/device/config", authMiddleware, (req, res) => {
  return res.json({
    tag: deviceState.tag,
    ...deviceState.config,
  });
});

app.post("/api/device/config", authMiddleware, requireRole(["service", "admin"]), (req, res) => {
  const setpointKgHr = Number(req.body?.setpointKgHr);
  const dampingSeconds = Number(req.body?.dampingSeconds);
  const alarmHighKgHr = Number(req.body?.alarmHighKgHr);

  if (!Number.isFinite(setpointKgHr) || setpointKgHr < 100 || setpointKgHr > 3000) {
    return res.status(400).json({ error: "setpointKgHr must be between 100 and 3000" });
  }
  if (!Number.isFinite(dampingSeconds) || dampingSeconds < 1 || dampingSeconds > 20) {
    return res.status(400).json({ error: "dampingSeconds must be between 1 and 20" });
  }
  if (!Number.isFinite(alarmHighKgHr) || alarmHighKgHr < 200 || alarmHighKgHr > 3500) {
    return res.status(400).json({ error: "alarmHighKgHr must be between 200 and 3500" });
  }

  deviceState.config = {
    setpointKgHr,
    dampingSeconds,
    alarmHighKgHr,
  };

  return res.json({ ok: true, config: deviceState.config });
});

app.get("/health", (req, res) => {
  return res.json({ status: "up", at: new Date().toISOString() });
});

app.get("/", (req, res, next) => {
  if (!existsSync(frontendIndexFile)) {
    return res.json({
      status: "frontend_not_built",
      message: "Run the Vite dev server or build the frontend before serving it from Express.",
    });
  }

  return res.sendFile(frontendIndexFile, next);
});

if (existsSync(frontendIndexFile)) {
  app.get("*", (req, res) => {
    return res.sendFile(frontendIndexFile);
  });
}

app.listen(PORT, HOST, () => {
  console.log(`Embedded web device demo API running on http://localhost:${PORT}`);
  console.log(`LAN access enabled on http://<your-pc-ip>:${PORT}`);
  console.log("Login credentials -> service/service123, admin/admin123, user/user123");
});