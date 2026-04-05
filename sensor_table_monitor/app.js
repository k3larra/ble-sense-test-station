const statusText = document.querySelector("#statusText");
const currentTask = document.querySelector("#currentTask");
const snapshotCount = document.querySelector("#snapshotCount");
const lastDataAt = document.querySelector("#lastDataAt");
const detectedRevision = document.querySelector("#detectedRevision");
const appVersion = document.querySelector("#appVersion");
const sensorRows = document.querySelector("#sensorRows");
const summaryCards = document.querySelector("#summaryCards");
const logLines = document.querySelector("#logLines");
const portSelect = document.querySelector("#portSelect");

const refreshPortsButton = document.querySelector("#refreshPortsButton");
const runFullTestButton = document.querySelector("#runFullTestButton");
const uploadButton = document.querySelector("#uploadButton");
const connectButton = document.querySelector("#connectButton");
const disconnectButton = document.querySelector("#disconnectButton");
const setupButton = document.querySelector("#setupButton");
const installPyserialButton = document.querySelector("#installPyserialButton");

const arduinoCliStatus = document.querySelector("#arduinoCliStatus");
const arduinoCliHelp = document.querySelector("#arduinoCliHelp");
const pyserialStatus = document.querySelector("#pyserialStatus");
const pyserialHelp = document.querySelector("#pyserialHelp");
const sketchStatus = document.querySelector("#sketchStatus");

let pollTimer = null;
let selectedPort = "";

function badgeClass(status) {
  if (status === "ok") return "status-ok";
  if (status === "needs-action") return "status-needs-action";
  if (status === "problem") return "status-problem";
  return "status-waiting";
}

function badgeLabel(status) {
  if (status === "ok") return "Verified";
  if (status === "needs-action") return "Needs action";
  if (status === "problem") return "Problem";
  return "Waiting";
}

function setStatus(message) {
  statusText.textContent = message;
}

async function callApi(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

function getSelectedPort() {
  return selectedPort || portSelect.value;
}

function renderPorts(ports, selectedPort) {
  const previous = selectedPort || getSelectedPort();
  portSelect.innerHTML = "";

  if (!ports.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No serial ports found";
    portSelect.append(option);
    portSelect.disabled = true;
    return;
  }

  ports.forEach((port) => {
    const option = document.createElement("option");
    option.value = port.address;
    const boardSuffix = port.board_name ? ` (${port.board_name})` : "";
    option.textContent = `${port.label}${boardSuffix}`;
    if (port.address === previous) option.selected = true;
    portSelect.append(option);
  });
  portSelect.disabled = false;
  selectedPort = portSelect.value;
}

function renderSummary(summary) {
  summaryCards.innerHTML = "";
  const cards = [
    { label: "Verified", value: summary.ok || 0, tone: "ok", note: "Sensors returning data or verified activity." },
    { label: "Needs Action", value: summary["needs-action"] || 0, tone: "attention", note: "Usually gesture or microphone needs interaction." },
    { label: "Problems", value: summary.problem || 0, tone: "problem", note: "No reading where one is expected." },
    { label: "Waiting", value: summary.waiting || 0, tone: "neutral", note: "No board data yet." }
  ];

  cards.forEach((card) => {
    const article = document.createElement("article");
    article.className = `summary-card ${card.tone}`;
    article.innerHTML = `<strong>${card.value}</strong><h3>${card.label}</h3><p class="small">${card.note}</p>`;
    summaryCards.append(article);
  });
}

function renderSensors(sensors) {
  sensorRows.innerHTML = "";
  sensors.forEach((sensor) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${sensor.label}</td>
      <td>${sensor.model}</td>
      <td><span class="status-badge ${badgeClass(sensor.status)}">${badgeLabel(sensor.status)}</span></td>
      <td class="value-cell">${sensor.value}</td>
      <td>${sensor.statusNote}</td>
    `;
    sensorRows.append(row);
  });
}

function renderLogs(logs) {
  logLines.innerHTML = "";
  logs.slice(-40).reverse().forEach((line) => {
    const wrapper = document.createElement("div");
    wrapper.className = "log-line";
    wrapper.innerHTML = `
      <time>${line.time}</time>
      <span class="level">${line.level}</span>
      <span>${line.message}</span>
    `;
    logLines.append(wrapper);
  });
}

function renderRequirements(status) {
  arduinoCliStatus.textContent = status.requirements.arduinoCliFound ? "Found." : "Missing.";
  arduinoCliHelp.textContent = status.requirements.arduinoCliFound
    ? status.installHelp.arduino_cli_url
    : status.installHelp.arduino_cli;

  pyserialStatus.textContent = status.requirements.pyserialFound ? "Found." : "Missing.";
  pyserialHelp.textContent = status.installHelp.pyserial;
  sketchStatus.textContent = status.requirements.sketchFound ? "Found." : "Missing sketch folder.";
}

function renderStatus(status) {
  currentTask.textContent = status.currentTask;
  snapshotCount.textContent = `${status.snapshotCount}`;
  lastDataAt.textContent = status.lastDataAt || "None";
  detectedRevision.textContent = status.detectedRevision ? status.detectedRevision.toUpperCase() : "Unknown";
  appVersion.textContent = `v${status.app.version}`;
  statusText.classList.toggle("status-live", Boolean(status.busy));

  renderPorts(status.ports, status.connectedPort || selectedPort);
  renderRequirements(status);
  renderSummary(status.summary);
  renderSensors(status.sensors);
  renderLogs(status.logs);

  const busy = Boolean(status.busy);
  refreshPortsButton.disabled = busy;
  runFullTestButton.disabled = busy || !portSelect.value;
  uploadButton.disabled = busy || !portSelect.value;
  connectButton.disabled = busy || !portSelect.value || status.serialConnected;
  disconnectButton.disabled = busy || !status.serialConnected;
  setupButton.disabled = busy;
  installPyserialButton.disabled = busy || status.requirements.pyserialFound;

  if (status.serialError) {
    setStatus(status.serialError);
  } else if (status.commandResult) {
    setStatus(status.commandResult);
  } else if (!status.requirements.arduinoCliFound) {
    setStatus("Arduino CLI is missing. Install it first, then refresh.");
  } else if (!status.requirements.pyserialFound) {
    setStatus("pyserial is missing. Install it from this page, then restart the launcher.");
  } else if (!status.ports.length) {
    setStatus("No serial ports detected. Plug in a board and refresh ports.");
  } else if (!status.serialConnected) {
    setStatus("Board detected. Run the full test or connect to live data.");
  } else {
    setStatus("Live data is active.");
  }
}

async function refreshStatus() {
  const response = await fetch("/api/status", { cache: "no-store" });
  const status = await response.json();
  renderStatus(status);
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    setStatus(error.message || "Action failed.");
  } finally {
    await refreshStatus();
  }
}

refreshPortsButton.addEventListener("click", refreshStatus);
portSelect.addEventListener("change", () => {
  selectedPort = portSelect.value;
});

setupButton.addEventListener("click", async () => {
  await runAction(async () => {
    setStatus("Preparing Arduino tools.");
    const result = await callApi("/api/setup");
    setStatus(result.message);
  });
});

installPyserialButton.addEventListener("click", async () => {
  await runAction(async () => {
    setStatus("Installing pyserial.");
    const result = await callApi("/api/install-pyserial");
    setStatus(result.message);
  });
});

uploadButton.addEventListener("click", async () => {
  await runAction(async () => {
    setStatus("Uploading test sketch.");
    const result = await callApi("/api/upload", { port: getSelectedPort() });
    setStatus(result.message);
  });
});

connectButton.addEventListener("click", async () => {
  await runAction(async () => {
    setStatus("Connecting to serial data.");
    const result = await callApi("/api/connect", { port: getSelectedPort() });
    setStatus(result.message);
  });
});

disconnectButton.addEventListener("click", async () => {
  await runAction(async () => {
    const result = await callApi("/api/disconnect");
    setStatus(result.message);
  });
});

runFullTestButton.addEventListener("click", async () => {
  await runAction(async () => {
    setStatus("Preparing, uploading and connecting.");
    const result = await callApi("/api/run-full-test", { port: getSelectedPort() });
    setStatus(result.message);
  });
});

async function startPolling() {
  await refreshStatus();
  pollTimer = window.setInterval(refreshStatus, 1500);
}

window.addEventListener("beforeunload", () => {
  if (pollTimer) window.clearInterval(pollTimer);
});

startPolling();
