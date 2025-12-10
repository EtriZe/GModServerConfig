import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { Server as SocketIOServer } from "socket.io";
import http from "http";
import dotenv from "dotenv";
import { spawn } from "child_process";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PANEL_PORT || 3000);
const PASSWORD = process.env.PANEL_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
const GMOD_DIR = process.env.GMOD_DIR || __dirname;
const GMOD_CMD = process.env.GMOD_CMD || "./srcds_run";

if (!PASSWORD) {
  console.error("Erreur: PANEL_PASSWORD manquant dans .env");
  process.exit(1);
}

const CONFIG_PATH = path.join(__dirname, "config.json");

function readConfig() {
  
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const cfg = JSON.parse(raw);

  // Normalisation + garde-fous
  cfg.map = String(cfg.map || "gm_construct");
  cfg.gamemode = String(cfg.gamemode || "sandbox");
  cfg.maxPlayers = Number(cfg.maxPlayers || 16);
  cfg.collectionId = String(cfg.collectionId || "");
  cfg.extraArgs = Array.isArray(cfg.extraArgs) ? cfg.extraArgs.map(String) : [];

  cfg.port = Number(cfg.port || 27015);
  cfg.tickrate = Number(cfg.tickrate || 66);

  if (Number.isNaN(cfg.port) || cfg.port < 1) cfg.port = 27015;
  if (cfg.port > 65535) cfg.port = 27015;

  if (Number.isNaN(cfg.tickrate) || cfg.tickrate < 10) cfg.tickrate = 66;
  if (cfg.tickrate > 128) cfg.tickrate = 128;


  // Clamp simple
  if (Number.isNaN(cfg.maxPlayers) || cfg.maxPlayers < 1) cfg.maxPlayers = 1;
  if (cfg.maxPlayers > 128) cfg.maxPlayers = 128;

  return cfg;
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

// Process handling
let gmodProc = null;
let lastLines = [];
const MAX_LINES = 2000;

function pushLine(line) {
  lastLines.push(line);
  if (lastLines.length > MAX_LINES) {
    lastLines = lastLines.slice(-MAX_LINES);
  }
}

function buildArgs(cfg) {
  const args = [];

  // IMPORTANT : console + usercon pour accepter les commandes stdin
  args.push(
    "-console",
    "-usercon",
    "-game", "garrysmod",
    "-port", String(cfg.port),
    "-tickrate", String(cfg.tickrate),
    "+maxplayers", String(cfg.maxPlayers),
    "+gamemode", cfg.gamemode,
    "+map", cfg.map
  );

  if (cfg.collectionId && cfg.collectionId.trim() !== "") {
    args.push("+host_workshop_collection", cfg.collectionId.trim());
  }

  for (const a of cfg.extraArgs) {
    if (a.includes("\n") || a.includes("\r")) continue;
    args.push(a);
  }

  return args;
}

function isRunning() {
  return !!gmodProc && !gmodProc.killed;
}

function startServer(io) {
  if (isRunning()) return { ok: false, error: "Déjà en cours." };

  // Nettoyage défensif : s'assurer qu'il ne reste pas de vieux srcds_linux
  try {
    spawn("pkill", ["-f", "srcds_linux -game garrysmod"], { cwd: GMOD_DIR });
  } catch {}

  const cfg = readConfig();
  const args = buildArgs(cfg);

  pushLine(`[panel] Starting: ${GMOD_CMD} ${args.join(" ")}`);
  io?.emit("log", `[panel] Starting: ${GMOD_CMD} ${args.join(" ")}`);

  gmodProc = spawn(GMOD_CMD, args, {
  cwd: GMOD_DIR,
  stdio: ["pipe", "pipe", "pipe"]
});

  gmodProc.stdout.on("data", (d) => {
    const text = d.toString("utf-8");
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      pushLine(line);
      io?.emit("log", line);
    }
  });

  gmodProc.stderr.on("data", (d) => {
    const text = d.toString("utf-8");
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const msg = `[stderr] ${line}`;
      pushLine(msg);
      io?.emit("log", msg);
    }
  });

  gmodProc.on("close", (code, signal) => {
    const msg = `[panel] Server exited (code=${code}, signal=${signal})`;
    pushLine(msg);
    io?.emit("log", msg);
    gmodProc = null;
    io?.emit("status", getStatus());
  });

  io?.emit("status", getStatus());
  return { ok: true };
}

function stopServer(io) {
  pushLine("[panel] Stopping server (gmodProc + anciens srcds_linux)...");
  io?.emit("log", "[panel] Stopping server (gmodProc + anciens srcds_linux)...");

  // 1) On tue proprement le process suivi par le panel
  if (isRunning()) {
    try {
      gmodProc.kill("SIGTERM");
    } catch (e) {
      pushLine("[panel] Erreur SIGTERM sur gmodProc.");
      io?.emit("log", "[panel] Erreur SIGTERM sur gmodProc.");
    }
  }

  // 2) On nettoie tous les srcds_linux garrysmod qui traînent encore
  //    (démarrés à la main ou par une version précédente du panel)
  try {
    const killer = spawn("pkill", [
      "-f",
      "srcds_linux -game garrysmod"
    ], {
      cwd: GMOD_DIR
    });

    killer.on("close", (code) => {
      const msg = `[panel] pkill srcds_linux terminé (code=${code}).`;
      pushLine(msg);
      io?.emit("log", msg);
      gmodProc = null;
      io?.emit("status", getStatus());
    });
  } catch (e) {
    const msg = "[panel] Impossible d'exécuter pkill srcds_linux.";
    pushLine(msg);
    io?.emit("log", msg);
    gmodProc = null;
    io?.emit("status", getStatus());
  }

  return { ok: true };
}


function restartServer(io) {
  if (!isRunning()) {
    const r = startServer(io);
    return r.ok ? { ok: true } : r;
  }

  const stopRes = stopServer(io);
  if (!stopRes.ok) return stopRes;

  // Redémarrage après courte fenêtre
  // (sans async "plus tard" côté assistant: ici c'est du runtime serveur)
  setTimeout(() => {
    startServer(io);
  }, 1200);

  return { ok: true };
}

function getStatus() {
  return {
    running: isRunning(),
    pid: isRunning() ? gmodProc.pid : null
  };
}

// Express app
const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new SocketIOServer(server);

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax"
    // secure: true // active si tu es en HTTPS
  }
}));

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session?.authed) return next();
  res.status(401).json({ ok: false, error: "Unauthorized" });
}

// Static
app.use("/public", express.static(path.join(__dirname, "public")));

// Page principale
app.get("/", (req, res) => {
  // On sert un mini HTML de login si non authed
  if (!req.session?.authed) {
    return res.type("html").send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title>GMOD Panel - Login</title>
        <style>
          body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#0b0f14;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
          .card{width:min(420px,92vw);background:#111823;border:1px solid #1f2a3a;border-radius:14px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
          h1{font-size:20px;margin:0 0 12px}
          input{width:100%;padding:12px 10px;border-radius:10px;border:1px solid #2a3a52;background:#0b1220;color:#e6edf3}
          button{margin-top:12px;width:100%;padding:12px;border-radius:10px;border:1px solid #2a3a52;background:#1b2a44;color:#e6edf3;cursor:pointer}
          .err{color:#ff7b7b;margin-top:10px;font-size:13px;min-height:18px}
        </style>
      </head>
      <body>
        <div class="card">
          <h1>GMOD Control Panel</h1>
          <form id="f">
            <input type="password" name="password" placeholder="Mot de passe" autocomplete="current-password" />
            <button type="submit">Entrer</button>
          </form>
          <div class="err" id="err"></div>
        </div>
        <script>
          const f = document.getElementById('f');
          const err = document.getElementById('err');
          f.addEventListener('submit', async (e) => {
            e.preventDefault();
            err.textContent = '';
            const fd = new FormData(f);
            const password = fd.get('password') || '';
            const r = await fetch('api/login', {
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ password })
            });
            const j = await r.json().catch(()=>({ok:false,error:'JSON error'}));
            if(j.ok){ location.reload(); }
            else{ err.textContent = j.error || 'Login failed'; }
          });
        </script>
      </body>
      </html>
    `);
  }

  // Si authed, on sert l'app front
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// API auth
app.post("/api/login", loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== "string") {
    return res.status(400).json({ ok: false, error: "Bad request" });
  }
  if (password === PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "Mot de passe incorrect" });
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.session.authed = false;
  res.json({ ok: true });
});

// Config endpoints
app.get("/api/config", requireAuth, (req, res) => {
  try {
    const cfg = readConfig();
    res.json({ ok: true, config: cfg });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Impossible de lire config.json" });
  }
});

app.post("/api/config", requireAuth, (req, res) => {
  try {
    const body = req.body || {};
    const current = readConfig();

    const next = {
      map: typeof body.map === "string" ? body.map : current.map,
      gamemode: typeof body.gamemode === "string" ? body.gamemode : current.gamemode,
      maxPlayers: body.maxPlayers != null ? Number(body.maxPlayers) : current.maxPlayers,
      collectionId: typeof body.collectionId === "string" ? body.collectionId : current.collectionId,
      extraArgs: Array.isArray(body.extraArgs) ? body.extraArgs.map(String) : current.extraArgs
    };

    // garde-fous
    if (!next.map) next.map = "gm_construct";
    if (!next.gamemode) next.gamemode = "sandbox";
    if (Number.isNaN(next.maxPlayers) || next.maxPlayers < 1) next.maxPlayers = 1;
    if (next.maxPlayers > 128) next.maxPlayers = 128;

    // Filtre basic args
    next.extraArgs = next.extraArgs.filter(a => a && !a.includes("\n") && !a.includes("\r"));

    writeConfig(next);
    res.json({ ok: true, config: next });
    io.emit("config", next);
  } catch (e) {
    res.status(500).json({ ok: false, error: "Impossible d'écrire config.json" });
  }
});

// Status + logs
app.get("/api/status", requireAuth, (req, res) => {
  res.json({ ok: true, status: getStatus() });
});

app.get("/api/logs", requireAuth, (req, res) => {
  res.json({ ok: true, lines: lastLines });
});

// Control
app.post("/api/start", requireAuth, (req, res) => {
  const r = startServer(io);
  res.status(r.ok ? 200 : 400).json(r);
});

app.post("/api/stop", requireAuth, (req, res) => {
  const r = stopServer(io);
  res.status(r.ok ? 200 : 400).json(r);
});

app.post("/api/restart", requireAuth, (req, res) => {
  const r = restartServer(io);
  res.status(r.ok ? 200 : 400).json(r);
});

// Socket auth simple via cookie de session déjà en place
io.on("connection", (socket) => {
  socket.emit("status", getStatus());
  socket.emit("logs:init", lastLines);
  try {
    socket.emit("config", readConfig());
  } catch {}

  socket.on("console:cmd", (cmd) => {
    console.log("[SOCKET] console:cmd ->", cmd);
    if (!gmodProc || gmodProc.killed || !gmodProc.stdin) {
      const msg = "[panel] Serveur non lancé ; commande ignorée.";
      pushLine(msg);
      socket.emit("log", msg);
      return;
    }

    if (typeof cmd !== "string") return;
    cmd = cmd.trim();
    if (!cmd) return;
    if (cmd.length > 200) return;

    try {
      const logLine = `[console] ${cmd}`;
      pushLine(logLine);
      io?.emit("log", logLine);
      gmodProc.stdin.write(cmd + "\n");
    } catch (e) {
      console.error("Erreur en envoyant la commande :", e);
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`GMOD panel up on 127.0.0.1:${PORT}`);
});
