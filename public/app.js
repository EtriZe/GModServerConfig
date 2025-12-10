const $ = (sel) => document.querySelector(sel);

const statusText = $("#statusText");
const pillRun = $("#pillRun");
const pidText = $("#pidText");

const startBtn = $("#startBtn");
const stopBtn = $("#stopBtn");
const restartBtn = $("#restartBtn");
const logoutBtn = $("#logoutBtn");

const configForm = $("#configForm");
const reloadCfgBtn = $("#reloadCfgBtn");
const configMsg = $("#configMsg");

const consoleBox = $("#console");
const clearBtn = $("#clearBtn");
const refreshLogsBtn = $("#refreshLogsBtn");

let running = false;

function setStatus(st) {
  running = !!st.running;

  pillRun.textContent = running ? "RUNNING" : "STOPPED";
  pillRun.classList.toggle("ok", running);
  pillRun.classList.toggle("bad", !running);

  statusText.textContent = running
    ? "Serveur en cours"
    : "Serveur arrêté";

  pidText.textContent = running && st.pid
    ? `PID: ${st.pid}`
    : "";

  startBtn.disabled = running;
  stopBtn.disabled = !running;
  restartBtn.disabled = false;
}

function addLine(line) {
  const el = document.createElement("div");
  el.className = "line";
  el.textContent = line;
  consoleBox.appendChild(el);
  consoleBox.scrollTop = consoleBox.scrollHeight;
}

function setConfigForm(cfg) {
  configForm.map.value = cfg.map ?? "";
  configForm.gamemode.value = cfg.gamemode ?? "";
  configForm.maxPlayers.value = cfg.maxPlayers ?? 16;
  configForm.collectionId.value = cfg.collectionId ?? "";
  configForm.port.value = cfg.port ?? 27015;
configForm.tickrate.value = cfg.tickrate ?? 66;
  configForm.extraArgs.value = Array.isArray(cfg.extraArgs)
    ? cfg.extraArgs.join("\n")
    : "";
}

async function apiGet(url) {
  const r = await fetch(url);
  return r.json();
}
async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}"
  });
  return r.json();
}

// Initial fetch
(async () => {
  const st = await apiGet("api/status");
  if (st.ok) setStatus(st.status);

  const cfg = await apiGet("api/config");
  if (cfg.ok) setConfigForm(cfg.config);

  const logs = await apiGet("api/logs");
  if (logs.ok) {
    consoleBox.innerHTML = "";
    logs.lines.forEach(addLine);
  }
})();

// Socket live logs
const socket = io();

socket.on("status", (st) => setStatus(st));
socket.on("config", (cfg) => setConfigForm(cfg));
socket.on("logs:init", (lines) => {
  consoleBox.innerHTML = "";
  (lines || []).forEach(addLine);
});
socket.on("log", (line) => addLine(line));

// Buttons
startBtn.addEventListener("click", async () => {
  const r = await apiPost("api/start");
  if (!r.ok) addLine(`[panel] ${r.error || "Start error"}`);
});

stopBtn.addEventListener("click", async () => {
  const r = await apiPost("api/stop");
  if (!r.ok) addLine(`[panel] ${r.error || "Stop error"}`);
});

restartBtn.addEventListener("click", async () => {
  const r = await apiPost("api/restart");
  if (!r.ok) addLine(`[panel] ${r.error || "Restart error"}`);
});

logoutBtn.addEventListener("click", async () => {
  await apiPost("api/logout");
  location.reload();
});

clearBtn.addEventListener("click", async () => {
  consoleBox.innerHTML = "";
  await apiPost("api/logs/clear");
});

refreshLogsBtn.addEventListener("click", async () => {
  const logs = await apiGet("api/logs");
  if (logs.ok) {
    consoleBox.innerHTML = "";
    logs.lines.forEach(addLine);
  }
});

// Config save
configForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  configMsg.textContent = "";

  const extraArgsLines = (configForm.extraArgs.value || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const payload = {
    map: configForm.map.value.trim(),
    gamemode: configForm.gamemode.value.trim(),
    maxPlayers: Number(configForm.maxPlayers.value),
    collectionId: configForm.collectionId.value.trim(),
    extraArgs: extraArgsLines
  };

  const r = await apiPost("api/config", payload);
  if (r.ok) {
    configMsg.textContent = "Sauvegardé.";
  } else {
    configMsg.textContent = r.error || "Erreur de sauvegarde.";
  }
});

reloadCfgBtn.addEventListener("click", async () => {
  const cfg = await apiGet("api/config");
  if (cfg.ok) {
    setConfigForm(cfg.config);
    configMsg.textContent = "Rechargé.";
  }
});

const cmdInput = document.getElementById("cmd");
const sendCmd = document.getElementById("sendCmd");

sendCmd.onclick = () => {
  const c = cmdInput.value.trim();
  if (!c) return;
  socket.emit("console:cmd", c);
  cmdInput.value = "";
};

cmdInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();   // évite le submit de formulaire -> pas de reload
    sendCmd.click();
  }
});

