import "dotenv/config";
import express from "express";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initDb } from "./db.js";
import { findByPhone } from "./db.js";
import { startPeriodicSync, syncContacts } from "./sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  tenantId: process.env.TENANT_ID,
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  certKeyPath: process.env.CERT_KEY_PATH || null,
  certThumbprint: process.env.CERT_THUMBPRINT || null,
  mailbox: process.env.MAILBOX_EMAIL,
};

const intervalMinutes = parseInt(process.env.SYNC_INTERVAL_MINUTES || "5", 10);
const port = parseInt(process.env.PORT || "3000", 10);
const nameFormat = process.env.NAME_FORMAT || "firstname";

const trustedHosts = (process.env.TRUSTED_HOSTS || "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const authEnabled = process.env.AUTH === "true";
const authUser = process.env.USERNAME || null;
const authPass = process.env.PASSWORD || null;
const useHttps = process.env.HTTPS === "true";
const httpsOnly = process.env.HTTPS_ONLY === "true";

// Validate required config
if (!config.tenantId || !config.clientId || !config.mailbox) {
  console.error("Missing required env vars: TENANT_ID, CLIENT_ID, MAILBOX_EMAIL");
  process.exit(1);
}
if (!config.certKeyPath && !config.clientSecret) {
  console.error("Either CERT_KEY_PATH + CERT_THUMBPRINT or CLIENT_SECRET must be set");
  process.exit(1);
}

const db = initDb();
const app = express();
app.use(express.json());

// --- Sync state ---
const syncState = {
  lastSync: null,
  contactCount: 0,
  duration: 0,
  syncInProgress: false,
  lastError: null,
};

const serverStartTime = Date.now();

// --- Middleware: HTTPS redirect ---
if (httpsOnly) {
  app.use((req, res, next) => {
    if (req.secure || req.headers["x-forwarded-proto"] === "https") {
      return next();
    }
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  });
}

// --- Dashboard (served before auth middleware) ---
app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// --- Middleware: Trusted hosts + Basic auth ---
app.use((req, res, next) => {
  // Check trusted hosts (IP allowlist)
  if (trustedHosts.length > 0) {
    const raw = req.socket.remoteAddress || "";
    let clientIp = raw.replace(/^::ffff:/, "");
    if (clientIp === "::1") clientIp = "127.0.0.1";

    if (!trustedHosts.includes(clientIp)) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  // Basic auth required if AUTH=true and credentials are configured
  if (authEnabled && authUser && authPass) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      res.set("WWW-Authenticate", 'Basic realm="Contact Lookup"');
      return res.status(401).json({ error: "Authentication required" });
    }

    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const [user, pass] = decoded.split(":");
    if (user !== authUser || pass !== authPass) {
      res.set("WWW-Authenticate", 'Basic realm="Contact Lookup"');
      return res.status(401).json({ error: "Invalid credentials" });
    }
  }

  next();
});

// --- Routes ---
app.post("/lookup", (req, res) => {
  const { sessionId, dstUri } = req.body || {};
  if (!sessionId || !dstUri) {
    return res.status(400).json({ error: "sessionId and dstUri are required" });
  }

  // Strip common URI prefixes like sip:, tel:, etc.
  const cleanPhone = dstUri.replace(/^(sip:|tel:|sips:)/i, "");
  console.log(`[lookup] sessionId=${sessionId} dstUri=${dstUri} cleanPhone=${cleanPhone}`);

  const result = findByPhone(db, cleanPhone, nameFormat);
  console.log(`[lookup] result=${JSON.stringify(result)}`);
  res.json({ sessionId, ...(result || { name: null }) });
});

app.get("/health", (_req, res) => {
  const count = db.prepare("SELECT COUNT(*) as count FROM contacts").get();
  res.json({ status: "ok", contacts: count.count });
});

// --- Dashboard API routes ---
app.get("/api/status", (_req, res) => {
  const count = db.prepare("SELECT COUNT(*) as count FROM contacts").get();
  res.json({
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    port,
    syncInterval: intervalMinutes,
    mailbox: config.mailbox,
    ...syncState,
    contactCount: count.count,
  });
});

app.post("/api/sync", async (_req, res) => {
  if (syncState.syncInProgress) {
    return res.status(409).json({ error: "Sync already in progress" });
  }

  syncState.syncInProgress = true;
  try {
    const result = await syncContacts(db, config);
    syncState.lastSync = new Date().toISOString();
    syncState.contactCount = result.contactCount;
    syncState.duration = result.duration;
    syncState.lastError = null;
    syncState.syncInProgress = false;
    res.json({ success: true, ...result });
  } catch (err) {
    syncState.lastError = err.message;
    syncState.syncInProgress = false;
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/restart", (_req, res) => {
  res.json({ success: true, message: "Server restarting..." });
  setTimeout(() => process.exit(0), 500);
});

// --- Start sync ---
startPeriodicSync(db, config, intervalMinutes, (err, result) => {
  if (err) {
    syncState.lastError = err.message;
    syncState.syncInProgress = false;
  } else {
    syncState.lastSync = new Date().toISOString();
    syncState.contactCount = result.contactCount;
    syncState.duration = result.duration;
    syncState.lastError = null;
    syncState.syncInProgress = false;
  }
});

// --- Start server ---
if (useHttps) {
  const sslKey = fs.readFileSync(process.env.HTTPS_KEY_PATH || "./certs/server.key");
  const sslCert = fs.readFileSync(process.env.HTTPS_CERT_PATH || "./certs/server.crt");
  const sslOpts = { key: sslKey, cert: sslCert };

  // CA / trust store for verifying client certificates or custom CA chain
  const caPath = process.env.HTTPS_CA_PATH || null;
  if (caPath) {
    sslOpts.ca = fs.readFileSync(caPath);
    sslOpts.requestCert = true;
    sslOpts.rejectUnauthorized = true;
    console.log(`[https] Mutual TLS enabled — CA loaded from ${caPath}`);
  }

  https.createServer(sslOpts, app).listen(port, () => {
    console.log(`Server listening on https://localhost:${port}`);
  });
} else {
  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}
