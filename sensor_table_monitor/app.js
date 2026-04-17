const statusText = document.querySelector("#statusText");
const currentTask = document.querySelector("#currentTask");
const snapshotCount = document.querySelector("#snapshotCount");
const lastDataAt = document.querySelector("#lastDataAt");
const detectedRevision = document.querySelector("#detectedRevision");
const appVersion = document.querySelector("#appVersion");
const sensorRows = document.querySelector("#sensorRows");
const summaryCards = document.querySelector("#summaryCards");
const historySummaryCards = document.querySelector("#historySummaryCards");
const logLines = document.querySelector("#logLines");
const portSelect = document.querySelector("#portSelect");
const checklistGrid = document.querySelector("#checklistGrid");
const recentTestsRows = document.querySelector("#recentTestsRows");
const jsonPath = document.querySelector("#jsonPath");
const csvPath = document.querySelector("#csvPath");
const inventoryIdInput = document.querySelector("#inventoryIdInput");
const operatorInput = document.querySelector("#operatorInput");
const notesInput = document.querySelector("#notesInput");

const refreshPortsButton = document.querySelector("#refreshPortsButton");
const runFullTestButton = document.querySelector("#runFullTestButton");
const uploadButton = document.querySelector("#uploadButton");
const connectButton = document.querySelector("#connectButton");
const disconnectButton = document.querySelector("#disconnectButton");
const setupButton = document.querySelector("#setupButton");
const installPyserialButton = document.querySelector("#installPyserialButton");
const saveSessionButton = document.querySelector("#saveSessionButton");
const saveResultButton = document.querySelector("#saveResultButton");
const nextBoardButton = document.querySelector("#nextBoardButton");

const arduinoCliStatus = document.querySelector("#arduinoCliStatus");
const arduinoCliHelp = document.querySelector("#arduinoCliHelp");
const pyserialStatus = document.querySelector("#pyserialStatus");
const pyserialHelp = document.querySelector("#pyserialHelp");
const sketchStatus = document.querySelector("#sketchStatus");

let pollTimer = null;
let selectedPort = "";
let checklistState = {};

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

function renderPorts(ports, connectedPort) {
  const previous = connectedPort || getSelectedPort();
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

function renderHistorySummary(summary) {
  historySummaryCards.innerHTML = "";
  const cards = [
    { label: "Total", value: summary.total || 0, tone: "neutral", note: "Boards saved in this batch." },
    { label: "Pass", value: summary.PASS || 0, tone: "ok", note: "All sensors good, kit complete." },
    { label: "Attention", value: summary.ATTENTION || 0, tone: "attention", note: "Board worked but needs human follow-up." },
    { label: "Fail / Incomplete", value: (summary.FAIL || 0) + (summary["KIT-INCOMPLETE"] || 0), tone: "problem", note: "Sensor problem or missing kit parts." }
  ];

  cards.forEach((card) => {
    const article = document.createElement("article");
    article.className = `summary-card ${card.tone}`;
    article.innerHTML = `<strong>${card.value}</strong><h3>${card.label}</h3><p class="small">${card.note}</p>`;
    historySummaryCards.append(article);
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

function renderChecklist(checklist) {
  checklistGrid.innerHTML = "";
  checklistState = {};
  checklist.forEach((item) => {
    checklistState[item.label] = Boolean(item.present);
    const label = document.createElement("label");
    label.className = "check-item";
    label.innerHTML = `
      <input type="checkbox" ${item.present ? "checked" : ""} data-label="${item.label}">
      <span>${item.label}</span>
    `;
    checklistGrid.append(label);
  });

  checklistGrid.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const input = event.currentTarget;
      checklistState[input.dataset.label] = input.checked;
    });
  });
}

function renderRecentTests(rows) {
  recentTestsRows.innerHTML = "";
  rows.slice().reverse().forEach((row) => {
    const tr = document.createElement("tr");
    const missing = Array.isArray(row.missing_items) ? row.missing_items.join(", ") : "";
    tr.innerHTML = `
      <td>${row.tested_at || ""}</td>
      <td>${row.inventory_id || ""}</td>
      <td>${row.result || ""}</td>
      <td>${row.revision || ""}</td>
      <td>${missing || "-"}</td>
    `;
    recentTestsRows.append(tr);
  });
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
  renderHistorySummary(status.historySummary);
  renderSensors(status.sensors);
  renderLogs(status.logs);
  renderChecklist(status.inventory.checklist);
  renderRecentTests(status.recentTests || []);

  inventoryIdInput.value = status.inventory.inventoryId || "";
  operatorInput.value = status.inventory.operator || "";
  notesInput.value = status.inventory.notes || "";
  jsonPath.textContent = status.historyFiles.json || "-";
  csvPath.textContent = status.historyFiles.csv || "-";

  const busy = Boolean(status.busy);
  refreshPortsButton.disabled = busy;
  runFullTestButton.disabled = busy || !portSelect.value;
  uploadButton.disabled = busy || !portSelect.value;
  connectButton.disabled = busy || !portSelect.value || status.serialConnected;
  disconnectButton.disabled = busy || !status.serialConnected;
  setupButton.disabled = busy;
  installPyserialButton.disabled = busy || status.requirements.pyserialFound;
  saveSessionButton.disabled = busy;
  saveResultButton.disabled = busy || !inventoryIdInput.value.trim();
  nextBoardButton.disabled = busy;

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
    setStatus("Live data is active. Save the result when you are done.");
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

function currentSessionPayload() {
  return {
    inventoryId: inventoryIdInput.value.trim(),
    operator: operatorInput.value.trim(),
    notes: notesInput.value.trim(),
    checklist: checklistState
  };
}

refreshPortsButton.addEventListener("click", refreshStatus);
portSelect.addEventListener("change", () => {
  selectedPort = portSelect.value;
});

saveSessionButton.addEventListener("click", async () => {
  await runAction(async () => {
    const result = await callApi("/api/set-session", currentSessionPayload());
    setStatus(result.message);
  });
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
    await callApi("/api/set-session", currentSessionPayload());
    setStatus("Preparing, uploading and connecting.");
    const result = await callApi("/api/run-full-test", { port: getSelectedPort() });
    setStatus(result.message);
  });
});

saveResultButton.addEventListener("click", async () => {
  await runAction(async () => {
    if (!inventoryIdInput.value.trim()) {
      throw new Error("Enter an inventory number before saving.");
    }
    await callApi("/api/set-session", currentSessionPayload());
    const result = await callApi("/api/record-result");
    setStatus(result.message);
  });
});

nextBoardButton.addEventListener("click", async () => {
  await runAction(async () => {
    const result = await callApi("/api/reset-for-next");
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
