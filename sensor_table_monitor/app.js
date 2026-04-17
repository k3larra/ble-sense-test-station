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
const runningRoot = document.querySelector("#runningRoot");
const metadataPath = document.querySelector("#metadataPath");
const jsonPath = document.querySelector("#jsonPath");
const csvPath = document.querySelector("#csvPath");
const testMetadataPrompt = document.querySelector("#testMetadataPrompt");
const testMetadataSummary = document.querySelector("#testMetadataSummary");
const testMetadataForm = document.querySelector("#testMetadataForm");
const testNameValue = document.querySelector("#testNameValue");
const testResponsibleValue = document.querySelector("#testResponsibleValue");
const testSavedAtValue = document.querySelector("#testSavedAtValue");
const testNotesValue = document.querySelector("#testNotesValue");
const testNameInput = document.querySelector("#testNameInput");
const testResponsibleInput = document.querySelector("#testResponsibleInput");
const testMetadataNotesInput = document.querySelector("#testMetadataNotesInput");
const inventoryIdInput = document.querySelector("#inventoryIdInput");
const inventoryNameInput = document.querySelector("#inventoryNameInput");
const operatorInput = document.querySelector("#operatorInput");
const notesInput = document.querySelector("#notesInput");

const refreshPortsButton = document.querySelector("#refreshPortsButton");
const runFullTestButton = document.querySelector("#runFullTestButton");
const uploadButton = document.querySelector("#uploadButton");
const connectButton = document.querySelector("#connectButton");
const disconnectButton = document.querySelector("#disconnectButton");
const setupButton = document.querySelector("#setupButton");
const installPyserialButton = document.querySelector("#installPyserialButton");
const editTestMetadataButton = document.querySelector("#editTestMetadataButton");
const saveTestMetadataButton = document.querySelector("#saveTestMetadataButton");
const cancelTestMetadataEditButton = document.querySelector("#cancelTestMetadataEditButton");
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
let sessionDirty = false;
let checklistDirty = false;
let usedKitNumbers = new Set();
let kitNumberCheckTimer = null;
let editingInventoryId = "";
let testMetadataDirty = false;
let testMetadataEditing = false;
let lastTestMetadata = null;
let stickyStatus = null;

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

function setStatus(message, tone = "info") {
  statusText.textContent = message;
  statusText.classList.toggle("status-warning", tone === "warning");
  statusText.classList.toggle("status-error", tone === "error");
}

function displayValue(value) {
  const text = `${value || ""}`.trim();
  return text || "-";
}

function renderTestMetadata(metadata = {}) {
  lastTestMetadata = metadata;
  const isSaved = Boolean(metadata.isSaved || (metadata.test_name && metadata.test_responsible));
  const showForm = testMetadataEditing || !isSaved;
  testMetadataSummary.hidden = showForm;
  testMetadataForm.hidden = !showForm;
  cancelTestMetadataEditButton.hidden = !isSaved;
  testMetadataPrompt.textContent = isSaved
    ? "These details are saved for this test."
    : "Save the test details before recording the first kit.";

  testNameValue.textContent = displayValue(metadata.test_name);
  testResponsibleValue.textContent = displayValue(metadata.test_responsible);
  testSavedAtValue.textContent = displayValue(metadata.saved_at);
  testNotesValue.textContent = displayValue(metadata.notes);

  if (!testMetadataDirty) {
    testNameInput.value = metadata.test_name || "";
    testResponsibleInput.value = metadata.test_responsible || "";
    testMetadataNotesInput.value = metadata.notes || "";
  }
}

function hasInventoryIdentity() {
  return Boolean(inventoryIdInput.value.trim());
}

function normalizeKitNumber() {
  const cleanValue = inventoryIdInput.value.replace(/\D/g, "").slice(0, 4);
  if (inventoryIdInput.value !== cleanValue) {
    inventoryIdInput.value = cleanValue;
  }
  return cleanValue;
}

function kitNumberError() {
  const kitNumber = normalizeKitNumber();
  if (!kitNumber) {
    return "Kit number is missing. Enter the kit number in Kit Details, then press Run test and save results again.";
  }
  if (usedKitNumbers.has(kitNumber) && kitNumber !== editingInventoryId) {
    return `Kit number ${kitNumber} has already been saved in this batch. Use a different kit number or update the saved kit instead.`;
  }
  return "";
}

function scheduleKitNumberCheck() {
  if (kitNumberCheckTimer) window.clearTimeout(kitNumberCheckTimer);
  kitNumberCheckTimer = window.setTimeout(async () => {
    const kitNumber = normalizeKitNumber();
    if (!kitNumber) return;
    if (usedKitNumbers.has(kitNumber) && kitNumber !== editingInventoryId) {
      stickyStatus = {
        message: `Kit number ${kitNumber} has already been saved in this batch. Use a different kit number or update the saved kit instead.`,
        tone: "warning"
      };
      setStatus(stickyStatus.message, stickyStatus.tone);
      return;
    }
    try {
      const response = await fetch(`/api/check-kit-number?kit=${encodeURIComponent(kitNumber)}`, { cache: "no-store" });
      const payload = await response.json();
      if (payload.exists && kitNumber !== editingInventoryId) {
        usedKitNumbers.add(kitNumber);
        stickyStatus = {
          message: `Kit number ${kitNumber} has already been saved in this batch. Use a different kit number or update the saved kit instead.`,
          tone: "warning"
        };
        setStatus(stickyStatus.message, stickyStatus.tone);
      }
    } catch (error) {
      // The save action still validates server-side. Keep typing responsive if this check fails.
    }
  }, 250);
}

function bindChecklistInputs() {
  checklistGrid.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
    checklistState[checkbox.dataset.label] = checkbox.checked;
    checkbox.addEventListener("change", (event) => {
      const input = event.currentTarget;
      checklistState[input.dataset.label] = input.checked;
      checklistDirty = true;
    });
  });
}

function updateSaveResultState(isBusy = false) {
  saveResultButton.disabled = isBusy;
  saveResultButton.textContent = editingInventoryId ? "Update saved result" : "Run test and save results";
}

function updateTestMetadataButtonState(isBusy = false) {
  saveTestMetadataButton.disabled = isBusy;
  editTestMetadataButton.disabled = isBusy;
  cancelTestMetadataEditButton.disabled = isBusy;
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
  if (!checklistDirty) {
    checklistState = {};
  }
  checklist.forEach((item) => {
    if (!checklistDirty || item.autoPresent || item.key === "arduino") {
      checklistState[item.label] = Boolean(item.present);
    }
    const isPresent = Boolean(checklistState[item.label]);
    const label = document.createElement("label");
    label.className = "check-item";
    label.innerHTML = `
      <input
        type="checkbox"
        ${isPresent ? "checked" : ""}
        data-label="${item.label}"
        data-check-key="${item.key || ""}"
        data-auto-present="${item.autoPresent ? "true" : ""}">
      <span>
        ${item.label}
        ${item.detail ? `<small>${item.detail}</small>` : ""}
      </span>
    `;
    checklistGrid.append(label);
  });

  bindChecklistInputs();
}

function renderRecentTests(rows) {
  recentTestsRows.innerHTML = "";
  rows.slice().reverse().forEach((row) => {
    const tr = document.createElement("tr");
    const missing = Array.isArray(row.missing_items) ? row.missing_items.join(", ") : "";
    const inventoryId = row.inventory_id || "";
    tr.innerHTML = `
      <td>${row.tested_at || ""}</td>
      <td>${inventoryId}</td>
      <td>${row.inventory_name || ""}</td>
      <td>${row.result || ""}</td>
      <td>${row.revision || ""}</td>
      <td>${missing || "-"}</td>
      <td><button type="button" class="small-action" data-edit-kit="${inventoryId}">Update</button></td>
    `;
    recentTestsRows.append(tr);
  });
}

function renderStatus(status) {
  usedKitNumbers = new Set(status.usedKitNumbers || []);
  editingInventoryId = status.editingInventoryId || "";
  currentTask.textContent = status.currentTask;
  snapshotCount.textContent = `${status.snapshotCount}`;
  lastDataAt.textContent = status.lastDataAt || "None";
  detectedRevision.textContent = status.detectedRevision ? status.detectedRevision.toUpperCase() : "Unknown";
  appVersion.textContent = `v${status.app.version}`;
  appVersion.title = status.app.root || "";
  statusText.classList.toggle("status-live", Boolean(status.busy));

  renderPorts(status.ports, status.connectedPort || selectedPort);
  renderRequirements(status);
  renderSummary(status.summary);
  renderHistorySummary(status.historySummary);
  renderTestMetadata(status.testMetadata || {});
  renderSensors(status.sensors);
  renderLogs(status.logs);
  renderChecklist(status.inventory.checklist);
  renderRecentTests(status.recentTests || []);

  if (!sessionDirty) {
    inventoryIdInput.value = status.inventory.inventoryId || "";
    if (inventoryNameInput) inventoryNameInput.value = status.inventory.inventoryName || "";
    operatorInput.value = status.inventory.operator || "";
    notesInput.value = status.inventory.notes || "";
  }
  if (runningRoot) runningRoot.textContent = status.app.root || "-";
  if (metadataPath) metadataPath.textContent = status.historyFiles.metadata || "-";
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
  updateTestMetadataButtonState(busy);
  updateSaveResultState(busy);
  nextBoardButton.disabled = busy;

  if (stickyStatus) {
    setStatus(stickyStatus.message, stickyStatus.tone);
  } else if (status.serialError) {
    setStatus(status.serialError, "error");
  } else if (status.testMetadata?.required) {
    setStatus("Save test metadata before recording the first kit.", "warning");
  } else if (status.commandResult) {
    setStatus(status.commandResult);
  } else if (!status.requirements.arduinoCliFound) {
    setStatus("Arduino CLI is missing. Install it first, then refresh.", "warning");
  } else if (!status.requirements.pyserialFound) {
    setStatus("pyserial is missing. Install it from this page, then restart the launcher.", "warning");
  } else if (!status.ports.length) {
    setStatus("No serial ports detected. Plug in a board and refresh ports.", "warning");
  } else if (!status.serialConnected) {
    setStatus("Board detected. Run the full test or connect to live data.");
  } else {
    setStatus("Live data is active. Save the result when you are done.");
  }
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const status = await response.json();
    renderStatus(status);
  } catch (error) {
    setStatus("Could not reach the local Python runner. The checklist is still available, but saving needs the launcher running.", "error");
    updateSaveResultState(false);
  }
}

async function runAction(action) {
  let actionError = null;
  stickyStatus = null;
  try {
    await action();
  } catch (error) {
    actionError = error;
  } finally {
    await refreshStatus();
    if (actionError) {
      stickyStatus = { message: actionError.message || "Action failed.", tone: "error" };
      setStatus(stickyStatus.message, stickyStatus.tone);
    }
  }
}

function currentSessionPayload() {
  return {
    inventoryId: inventoryIdInput.value.trim(),
    inventoryName: inventoryNameInput?.value.trim() || "",
    operator: operatorInput.value.trim(),
    notes: notesInput.value.trim(),
    checklist: checklistState
  };
}

function currentTestMetadataPayload() {
  return {
    testName: testNameInput.value.trim(),
    testResponsible: testResponsibleInput.value.trim(),
    notes: testMetadataNotesInput.value.trim()
  };
}

async function testArduino() {
  if (!getSelectedPort()) {
    throw new Error("Select a board port before testing the Arduino.");
  }
  await callApi("/api/set-session", currentSessionPayload());
  sessionDirty = false;
  checklistDirty = false;
  setStatus("Preparing, uploading and connecting.");
  const result = await callApi("/api/run-full-test", { port: getSelectedPort() });
  setStatus(result.message);
}

function shouldRunArduinoBeforeSave() {
  const checkbox = checklistGrid.querySelector("input[data-check-key='arduino']");
  return Boolean(checkbox?.checked && !checkbox.dataset.autoPresent);
}

refreshPortsButton.addEventListener("click", refreshStatus);
portSelect.addEventListener("change", () => {
  selectedPort = portSelect.value;
});

[testNameInput, testResponsibleInput, testMetadataNotesInput].forEach((input) => {
  input.addEventListener("input", () => {
    testMetadataDirty = true;
  });
});

editTestMetadataButton.addEventListener("click", () => {
  testMetadataEditing = true;
  testMetadataDirty = false;
  renderTestMetadata(lastTestMetadata || {});
});

cancelTestMetadataEditButton.addEventListener("click", () => {
  testMetadataEditing = false;
  testMetadataDirty = false;
  renderTestMetadata(lastTestMetadata || {});
});

saveTestMetadataButton.addEventListener("click", async () => {
  await runAction(async () => {
    const result = await callApi("/api/set-test-metadata", currentTestMetadataPayload());
    testMetadataEditing = false;
    testMetadataDirty = false;
    renderTestMetadata(result.metadata || {});
    setStatus(result.message);
  });
});

[inventoryIdInput, inventoryNameInput, operatorInput, notesInput].filter(Boolean).forEach((input) => {
  input.addEventListener("input", () => {
    if (input === inventoryIdInput) {
      normalizeKitNumber();
      scheduleKitNumberCheck();
    }
    stickyStatus = null;
    sessionDirty = true;
    updateSaveResultState(false);
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
    await testArduino();
  });
});

saveResultButton.addEventListener("click", async () => {
  await runAction(async () => {
    const validationError = kitNumberError();
    if (validationError) {
      throw new Error(validationError);
    }
    if (shouldRunArduinoBeforeSave()) {
      await testArduino();
    } else {
      setStatus("Saving result for this kit.");
      await callApi("/api/set-session", currentSessionPayload());
    }
    sessionDirty = false;
    checklistDirty = false;
    const result = await callApi("/api/record-result", { update: Boolean(editingInventoryId) });
    setStatus(result.message);
  });
});

recentTestsRows.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-edit-kit]");
  if (!button) return;
  await runAction(async () => {
    const inventoryId = button.dataset.editKit || "";
    setStatus(`Loading kit ${inventoryId} for update.`);
    const result = await callApi("/api/edit-result", { inventoryId });
    sessionDirty = false;
    checklistDirty = false;
    setStatus(result.message);
    document.querySelector("#statusText").scrollIntoView({ behavior: "smooth", block: "center" });
  });
});

nextBoardButton.addEventListener("click", async () => {
  await runAction(async () => {
    const result = await callApi("/api/reset-for-next");
    sessionDirty = false;
    checklistDirty = false;
    setStatus(result.message);
  });
});

async function startPolling() {
  bindChecklistInputs();
  await refreshStatus();
  pollTimer = window.setInterval(refreshStatus, 1500);
}

window.addEventListener("beforeunload", () => {
  if (pollTimer) window.clearInterval(pollTimer);
});

startPolling();
