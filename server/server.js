import crypto from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDistDir = path.resolve(__dirname, "../frontend/dist");
const frontendIndexFile = path.join(frontendDistDir, "index.html");
const dataDir = path.resolve(__dirname, "data");
const databasePath = path.join(dataDir, "device.db");

mkdirSync(dataDir, { recursive: true });

const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS device_config (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    setpointKgHr REAL NOT NULL,
    dampingSeconds REAL NOT NULL,
    alarmHighKgHr REAL NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config_audit_trail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    changedAt TEXT NOT NULL,
    changedByUsername TEXT NOT NULL,
    changedByRole TEXT NOT NULL,
    setpointKgHr REAL NOT NULL,
    dampingSeconds REAL NOT NULL,
    alarmHighKgHr REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eventType TEXT NOT NULL,
    occurredAt TEXT NOT NULL,
    actorUsername TEXT NOT NULL,
    actorRole TEXT NOT NULL,
    targetUsername TEXT,
    payloadJson TEXT
  );

  CREATE TABLE IF NOT EXISTS app_users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('service', 'admin', 'user')),
    createdAt TEXT NOT NULL
  );
`);

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT || 8080;
const allowedCorsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function corsMiddleware(req, res, next) {
  const requestOrigin = req.headers.origin;

  if (requestOrigin && (allowedCorsOrigins.length === 0 || allowedCorsOrigins.includes(requestOrigin))) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
}

app.use(express.json());
app.use(corsMiddleware);

if (existsSync(frontendDistDir)) {
  app.use(express.static(frontendDistDir));
}

const defaultUsers = [
  { username: "service", password: "service123", role: "service" },
  { username: "admin", password: "admin123", role: "admin" },
  { username: "user", password: "user123", role: "user" },
];
const users = new Map();
const sessions = new Map();

const defaultDeviceConfig = {
  setpointKgHr: 1250,
  dampingSeconds: 3,
  alarmHighKgHr: 1500,
};

const selectConfigStatement = db.prepare(
  "SELECT setpointKgHr, dampingSeconds, alarmHighKgHr, updatedAt FROM device_config WHERE id = 1",
);
const upsertConfigStatement = db.prepare(`
  INSERT INTO device_config (id, setpointKgHr, dampingSeconds, alarmHighKgHr, updatedAt)
  VALUES (1, @setpointKgHr, @dampingSeconds, @alarmHighKgHr, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    setpointKgHr = excluded.setpointKgHr,
    dampingSeconds = excluded.dampingSeconds,
    alarmHighKgHr = excluded.alarmHighKgHr,
    updatedAt = excluded.updatedAt
`);
const insertAuditStatement = db.prepare(`
  INSERT INTO config_audit_trail (
    changedAt,
    changedByUsername,
    changedByRole,
    setpointKgHr,
    dampingSeconds,
    alarmHighKgHr
  ) VALUES (
    @changedAt,
    @changedByUsername,
    @changedByRole,
    @setpointKgHr,
    @dampingSeconds,
    @alarmHighKgHr
  )
`);
const insertAuditEventStatement = db.prepare(`
  INSERT INTO audit_events (
    eventType,
    occurredAt,
    actorUsername,
    actorRole,
    targetUsername,
    payloadJson
  ) VALUES (
    @eventType,
    @occurredAt,
    @actorUsername,
    @actorRole,
    @targetUsername,
    @payloadJson
  )
`);
const countUsersStatement = db.prepare("SELECT COUNT(*) AS total FROM app_users");
const selectAllUsersStatement = db.prepare("SELECT username, password, role FROM app_users ORDER BY username ASC");
const insertUserStatement = db.prepare(`
  INSERT INTO app_users (username, password, role, createdAt)
  VALUES (@username, @password, @role, @createdAt)
`);
const deleteUserStatement = db.prepare("DELETE FROM app_users WHERE username = ?");

function recordAuditEvent(event) {
  insertAuditEventStatement.run({
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    actorUsername: event.actorUsername,
    actorRole: event.actorRole,
    targetUsername: event.targetUsername || null,
    payloadJson: event.payloadJson || null,
  });
}

function getConfigSnapshotFromAuditPayload(eventType, payload) {
  if (!payload || (eventType !== "CONFIG_UPDATED" && eventType !== "CONFIG_SEEDED")) {
    return null;
  }

  const setpointKgHr = Number(payload.setpointKgHr);
  const dampingSeconds = Number(payload.dampingSeconds);
  const alarmHighKgHr = Number(payload.alarmHighKgHr);

  if (!Number.isFinite(setpointKgHr) || !Number.isFinite(dampingSeconds) || !Number.isFinite(alarmHighKgHr)) {
    return null;
  }

  return {
    setpointKgHr,
    dampingSeconds,
    alarmHighKgHr,
  };
}

function getTargetRoleFromAuditPayload(eventType, payload) {
  if (!payload || (eventType !== "USER_CREATED" && eventType !== "USER_DELETED")) {
    return null;
  }

  const role = String(payload.role || "").trim().toLowerCase();
  if (!role) {
    return null;
  }

  return role;
}

function ensureSeededDeviceConfig() {
  const existingConfig = selectConfigStatement.get();
  if (existingConfig) {
    return;
  }

  const seededAt = new Date().toISOString();
  upsertConfigStatement.run({
    ...defaultDeviceConfig,
    updatedAt: seededAt,
  });
  insertAuditStatement.run({
    ...defaultDeviceConfig,
    changedAt: seededAt,
    changedByUsername: "system",
    changedByRole: "system",
  });
  recordAuditEvent({
    eventType: "CONFIG_SEEDED",
    occurredAt: seededAt,
    actorUsername: "system",
    actorRole: "system",
    payloadJson: JSON.stringify(defaultDeviceConfig),
  });
}

function syncUsersCacheFromDb() {
  const storedUsers = selectAllUsersStatement.all();
  users.clear();

  for (const storedUser of storedUsers) {
    users.set(storedUser.username, {
      password: String(storedUser.password),
      role: String(storedUser.role),
    });
  }
}

const ensureSeededUsers = db.transaction(() => {
  const row = countUsersStatement.get();
  const totalUsers = Number(row?.total || 0);

  if (totalUsers > 0) {
    return;
  }

  const createdAt = new Date().toISOString();
  for (const user of defaultUsers) {
    insertUserStatement.run({
      username: user.username,
      password: user.password,
      role: user.role,
      createdAt,
    });
  }
});

function loadDeviceConfigFromDb() {
  const storedConfig = selectConfigStatement.get();
  if (!storedConfig) {
    return { ...defaultDeviceConfig };
  }

  return {
    setpointKgHr: Number(storedConfig.setpointKgHr),
    dampingSeconds: Number(storedConfig.dampingSeconds),
    alarmHighKgHr: Number(storedConfig.alarmHighKgHr),
  };
}

const saveDeviceConfigAndAudit = db.transaction((nextConfig, actor) => {
  const changedAt = new Date().toISOString();

  upsertConfigStatement.run({
    ...nextConfig,
    updatedAt: changedAt,
  });

  insertAuditStatement.run({
    ...nextConfig,
    changedAt,
    changedByUsername: actor.username,
    changedByRole: actor.role,
  });

  recordAuditEvent({
    eventType: "CONFIG_UPDATED",
    occurredAt: changedAt,
    actorUsername: actor.username,
    actorRole: actor.role,
    payloadJson: JSON.stringify(nextConfig),
  });
});

ensureSeededDeviceConfig();
ensureSeededUsers();
syncUsersCacheFromDb();

const deviceState = {
  tag: "MM-FT-101",
  firmware: "1.0.0-demo",
  config: loadDeviceConfigFromDb(),
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
  const loggedAt = new Date().toISOString();
  console.log(`User ${username} (${userRecord.role}) logged in at ${loggedAt}`);
  recordAuditEvent({
    eventType: "USER_LOGIN",
    occurredAt: loggedAt,
    actorUsername: username,
    actorRole: userRecord.role,
  });

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

  insertUserStatement.run({
    username,
    password,
    role,
    createdAt: new Date().toISOString(),
  });
  users.set(username, { password, role });
  recordAuditEvent({
    eventType: "USER_CREATED",
    occurredAt: new Date().toISOString(),
    actorUsername: req.user.username,
    actorRole: req.user.role,
    targetUsername: username,
    payloadJson: JSON.stringify({ role }),
  });
  return res.status(201).json({ ok: true, user: { username, role } });
});

app.delete("/api/users/:username", authMiddleware, requireRole(["service"]), (req, res) => {
  const targetUsername = String(req.params?.username || "").trim();

  if (!targetUsername) {
    return res.status(400).json({ error: "username is required" });
  }
  if (targetUsername === "service") {
    return res.status(403).json({ error: "service account cannot be deleted" });
  }
  if (targetUsername === req.user.username) {
    return res.status(403).json({ error: "you cannot delete your own active login" });
  }

  const targetUserRecord = users.get(targetUsername);
  if (!targetUserRecord) {
    return res.status(404).json({ error: "user not found" });
  }

  deleteUserStatement.run(targetUsername);
  users.delete(targetUsername);
  for (const [sessionToken, sessionUser] of sessions.entries()) {
    if (sessionUser.username === targetUsername) {
      sessions.delete(sessionToken);
    }
  }

  recordAuditEvent({
    eventType: "USER_DELETED",
    occurredAt: new Date().toISOString(),
    actorUsername: req.user.username,
    actorRole: req.user.role,
    targetUsername,
    payloadJson: JSON.stringify({ role: targetUserRecord.role }),
  });

  return res.json({
    ok: true,
    deletedUser: { username: targetUsername, role: targetUserRecord.role },
  });
});

app.get("/api/device/telemetry", authMiddleware, (req, res) => {
  return res.json({
    ...deviceState.telemetry,
    tag: deviceState.tag,
    firmware: deviceState.firmware,
  });
});

app.get("/api/device/config", authMiddleware, (req, res) => {
  deviceState.config = loadDeviceConfigFromDb();

  return res.json({
    tag: deviceState.tag,
    ...deviceState.config,
  });
});

app.get("/api/device/config/audit", authMiddleware, requireRole(["service", "admin"]), (req, res) => {
  const requestedLimit = Number(req.query?.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(200, Math.trunc(requestedLimit)))
    : 50;

  const auditRows = db
    .prepare(
      `
      SELECT
        id,
        eventType,
        occurredAt,
        actorUsername,
        actorRole,
        targetUsername,
        payloadJson
      FROM audit_events
      ORDER BY id DESC
      LIMIT ?
      `,
    )
    .all(limit);

  return res.json({
    entries: auditRows.map((row) => {
      let payload = null;

      if (row.payloadJson) {
        try {
          payload = JSON.parse(row.payloadJson);
        } catch {
          payload = null;
        }
      }

      return {
        id: Number(row.id),
        eventType: row.eventType,
        changedAt: row.occurredAt,
        changedBy: {
          username: row.actorUsername,
          role: row.actorRole,
        },
        targetUsername: row.targetUsername || null,
        targetRole: getTargetRoleFromAuditPayload(row.eventType, payload),
        config: getConfigSnapshotFromAuditPayload(row.eventType, payload),
      };
    }),
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

  saveDeviceConfigAndAudit(deviceState.config, {
    username: req.user.username,
    role: req.user.role,
  });

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
  if (allowedCorsOrigins.length > 0) {
    console.log(`CORS restricted to: ${allowedCorsOrigins.join(", ")}`);
  } else {
    console.log("CORS enabled for any requesting origin (development default)");
  }
  console.log("Login credentials -> service/service123, admin/admin123, user/user123");
  console.log(`SQLite persistence enabled at ${databasePath}`);
});

process.on("exit", () => {
  db.close();
});