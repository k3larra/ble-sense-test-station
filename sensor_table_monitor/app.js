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
const revisionOverrideSelect = document.querySelector("#revisionOverrideSelect");
const checklistGrid = document.querySelector("#checklistGrid");
const recentTestsRows = document.querySelector("#recentTestsRows");
const runningRoot = document.querySelector("#runningRoot");
const metadataPath = document.querySelector("#metadataPath");
const jsonPath = document.querySelector("#jsonPath");
const csvPath = document.querySelector("#csvPath");
const kitTemplatesPath = document.querySelector("#kitTemplatesPath");
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
const runKitTestButton = document.querySelector("#runKitTestButton");
const runFullTestButton = document.querySelector("#runFullTestButton");
const resetArduinoTestButton = document.querySelector("#resetArduinoTestButton");
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
const kitTemplateSelect = document.querySelector("#kitTemplateSelect");
const editKitSetsButton = document.querySelector("#editKitSetsButton");
const deleteResultDialog = document.querySelector("#deleteResultDialog");
const deleteResultMessage = document.querySelector("#deleteResultMessage");
const confirmDeleteResultButton = document.querySelector("#confirmDeleteResultButton");

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
let currentTemplates = [];
let activeKitTemplateId = "";
let pendingDeleteInventoryId = "";

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);
  if (options.className) element.className = options.className;
  if (options.text) element.textContent = options.text;
  if (options.type) element.type = options.type;
  if (options.value !== undefined) element.value = options.value;
  if (options.placeholder) element.placeholder = options.placeholder;
  return element;
}

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

function severityLabel(severity) {
  if (severity === "critical") return "Critical";
  if (severity === "optional") return "Optional";
  return "Missing";
}

function setStatus(message, tone = "info") {
  const statusMessage = statusText.querySelector("span");
  if (statusMessage) {
    statusMessage.textContent = message;
  } else {
    statusText.textContent = `Status: ${message}`;
  }
  statusText.classList.toggle("status-warning", tone === "warning");
  statusText.classList.toggle("status-error", tone === "error");
}

function displayValue(value) {
  const text = `${value || ""}`.trim();
  return text || "-";
}

function formatSavedResultTime(value) {
  const text = `${value || ""}`.trim();
  if (!text) return { date: "-", time: "" };
  const [datePart, rawTime = ""] = text.split("T");
  const timePart = rawTime.slice(0, 5);
  return {
    date: datePart || text,
    time: timePart
  };
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
    return "Kit number is missing. Enter the kit number in Kit Details, then run the test or save the result again.";
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
    } catch (_error) {
      // Server-side validation still runs during save.
    }
  }, 250);
}

function updateSaveResultState(isBusy = false) {
  saveResultButton.disabled = isBusy;
  saveResultButton.textContent = editingInventoryId ? "Update Saved Result" : "Save Results";
  if (runKitTestButton) {
    runKitTestButton.disabled = isBusy || !portSelect.value;
  }
}

function updateTestMetadataButtonState(isBusy = false) {
  saveTestMetadataButton.disabled = isBusy;
  editTestMetadataButton.disabled = isBusy;
  cancelTestMetadataEditButton.disabled = isBusy;
}

function updateArduinoTestButtonState(isBusy = false) {
  const checkbox = checklistGrid.querySelector("input[data-check-key='arduino']");
  const isSelected = Boolean(checkbox?.checked);
  resetArduinoTestButton.disabled = isBusy || !isSelected;
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
    const option = createElement("option", { value: "", text: "No serial ports found" });
    portSelect.append(option);
    portSelect.disabled = true;
    return;
  }

  ports.forEach((port) => {
    const option = createElement("option", { value: port.address });
    const boardSuffix = port.board_name ? ` (${port.board_name})` : "";
    option.textContent = `${port.label}${boardSuffix}`;
    if (port.address === previous) option.selected = true;
    portSelect.append(option);
  });
  portSelect.disabled = false;
  selectedPort = portSelect.value;
}

function renderSummaryCards(container, cards) {
  container.innerHTML = "";
  cards.forEach((card) => {
    const article = createElement("article", { className: `summary-card ${card.tone}` });
    const value = createElement("strong", { text: `${card.value}` });
    const heading = createElement("h3", { text: card.label });
    const note = createElement("p", { className: "small", text: card.note });
    article.append(value, heading, note);
    container.append(article);
  });
}

function renderSummary(summary) {
  renderSummaryCards(summaryCards, [
    { label: "Verified", value: summary.ok || 0, tone: "ok", note: "Sensors returning data or verified activity." },
    { label: "Needs Action", value: summary["needs-action"] || 0, tone: "attention", note: "Usually gesture or microphone needs interaction." },
    { label: "Problems", value: summary.problem || 0, tone: "problem", note: "No reading where one is expected." },
    { label: "Waiting", value: summary.waiting || 0, tone: "neutral", note: "No board data yet." }
  ]);
}

function renderHistorySummary(summary) {
  renderSummaryCards(historySummaryCards, [
    { label: "Total", value: summary.total || 0, tone: "neutral", note: "Boards saved in this batch." },
    { label: "Pass", value: summary.PASS || 0, tone: "ok", note: "Board tested and kit complete." },
    { label: "Attention", value: summary.ATTENTION || 0, tone: "attention", note: "Board worked but needs human follow-up." },
    { label: "Fail / Incomplete", value: (summary.FAIL || 0) + (summary["KIT-INCOMPLETE"] || 0), tone: "problem", note: "Critical issue or missing required parts." }
  ]);
}

function renderSensors(sensors) {
  sensorRows.innerHTML = "";
  sensors.forEach((sensor) => {
    const row = document.createElement("tr");
    const labelCell = createElement("td", { text: sensor.label });
    const modelCell = createElement("td", { text: sensor.model });
    const statusCell = document.createElement("td");
    const statusBadge = createElement("span", { className: `status-badge ${badgeClass(sensor.status)}`, text: badgeLabel(sensor.status) });
    statusCell.append(statusBadge);
    const valueCell = createElement("td", { className: "value-cell", text: sensor.value });
    const noteCell = createElement("td", { text: sensor.statusNote });
    row.append(labelCell, modelCell, statusCell, valueCell, noteCell);
    sensorRows.append(row);
  });
}

function renderLogs(logs) {
  logLines.innerHTML = "";
  logs.slice(-40).reverse().forEach((line) => {
    const wrapper = createElement("div", { className: "log-line" });
    wrapper.append(
      createElement("time", { text: line.time }),
      createElement("span", { className: "level", text: line.level }),
      createElement("span", { text: line.message })
    );
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

function bindChecklistInputs() {
  checklistGrid.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
    checklistState[checkbox.dataset.itemId] = checkbox.checked;
    checkbox.addEventListener("change", (event) => {
      const input = event.currentTarget;
      if (input.dataset.checkKey === "arduino") {
        handleArduinoCheckboxChange(input);
        return;
      }
      checklistState[input.dataset.itemId] = input.checked;
      checklistDirty = true;
    });
  });
}

function renderChecklist(checklist) {
  checklistGrid.innerHTML = "";
  if (!checklistDirty) {
    checklistState = {};
  }

  checklist.forEach((item) => {
    if (!checklistDirty || item.autoPresent || item.key === "arduino") {
      checklistState[item.id] = Boolean(item.present);
    }

    const row = createElement("label", { className: "check-item" });
    const checkbox = createElement("input", { type: "checkbox" });
    checkbox.checked = Boolean(checklistState[item.id]);
    checkbox.dataset.itemId = item.id;
    checkbox.dataset.checkKey = item.key || "";
    checkbox.dataset.testCompleted = item.testCompleted ? "true" : "";
    row.append(checkbox);

    const content = createElement("span");
    const labelRow = createElement("span", { className: "check-item-main" });
    labelRow.append(createElement("strong", { text: item.label }));
    labelRow.append(createElement("span", { className: `severity-badge severity-${item.severity}`, text: severityLabel(item.severity) }));
    if (item.kind === "controller") {
      labelRow.append(createElement("span", { className: "kind-badge", text: "BLE Sense Test" }));
    }
    content.append(labelRow);
    if (item.detail) {
      content.append(createElement("small", { text: item.detail }));
    }
    row.append(content);
    checklistGrid.append(row);
  });

  bindChecklistInputs();
}

function renderRecentTests(rows) {
  recentTestsRows.innerHTML = "";
  rows.slice().reverse().forEach((row) => {
    const tr = document.createElement("tr");
    const inventoryId = row.inventory_id || "";
    const testedAt = formatSavedResultTime(row.tested_at);
    const testedAtCell = createElement("td");
    testedAtCell.append(createElement("span", { className: "table-date", text: testedAt.date }));
    if (testedAt.time) {
      testedAtCell.append(createElement("span", { className: "table-time", text: testedAt.time }));
    }
    tr.append(testedAtCell);
    [
      inventoryId,
      row.inventory_name || "",
      row.result || "",
      row.revision || ""
    ].forEach((value) => tr.append(createElement("td", { text: value })));
    const actionCell = document.createElement("td");
    const actions = createElement("div", { className: "table-actions" });
    const updateButton = createElement("button", { className: "small-action", type: "button", text: "Update" });
    updateButton.dataset.editKit = inventoryId;
    const deleteButton = createElement("button", { className: "small-action danger-action", type: "button", text: "Delete" });
    deleteButton.dataset.deleteKit = inventoryId;
    actions.append(updateButton, deleteButton);
    actionCell.append(actions);
    tr.append(actionCell);
    recentTestsRows.append(tr);
  });
}

function renderKitTemplateSelect(templates, selectedId) {
  kitTemplateSelect.innerHTML = "";
  templates.forEach((template) => {
    const option = createElement("option", { value: template.id, text: template.name });
    if (template.id === selectedId) option.selected = true;
    kitTemplateSelect.append(option);
  });
}

function currentSessionPayload() {
  return {
    inventoryId: inventoryIdInput.value.trim(),
    inventoryName: inventoryNameInput?.value.trim() || "",
    operator: operatorInput.value.trim(),
    notes: notesInput.value.trim(),
    revisionOverride: revisionOverrideSelect?.value || "auto",
    checklist: checklistState,
    kitTemplateId: activeKitTemplateId
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
  await callApi("/api/request-arduino-test");
  await callApi("/api/set-session", currentSessionPayload());
  sessionDirty = false;
  checklistDirty = false;
  setStatus("Preparing, uploading and connecting.");
  const result = await callApi("/api/run-full-test", {
    port: getSelectedPort(),
    revisionOverride: revisionOverrideSelect?.value || "auto"
  });
  setStatus(result.message);
}

function shouldRunArduinoBeforeSave() {
  const checkbox = checklistGrid.querySelector("input[data-check-key='arduino']");
  return Boolean(checkbox?.checked && checkbox.dataset.testCompleted !== "true");
}

function handleArduinoCheckboxChange(input) {
  if (input.checked) {
    checklistState[input.dataset.itemId] = true;
    checklistDirty = true;
    runAction(async () => {
      const result = await callApi("/api/request-arduino-test");
      setStatus(result.message);
    });
    return;
  }
  input.checked = true;
  checklistState[input.dataset.itemId] = true;
  stickyStatus = {
    message: "Use Reset Arduino Test if you want to clear the BLE Sense test flag and run the test again.",
    tone: "warning"
  };
  setStatus(stickyStatus.message, stickyStatus.tone);
}

function renderStatus(status) {
  usedKitNumbers = new Set(status.usedKitNumbers || []);
  editingInventoryId = status.editingInventoryId || "";
  currentTemplates = cloneData(status.kitTemplates || []);
  activeKitTemplateId = status.activeKitTemplateId || "";

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
  renderKitTemplateSelect(currentTemplates, activeKitTemplateId);

  if (!sessionDirty) {
    inventoryIdInput.value = status.inventory.inventoryId || "";
    if (inventoryNameInput) inventoryNameInput.value = status.inventory.inventoryName || "";
    operatorInput.value = status.inventory.operator || "";
    notesInput.value = status.inventory.notes || "";
    if (revisionOverrideSelect) revisionOverrideSelect.value = status.revisionOverride || "auto";
  }

  if (runningRoot) runningRoot.textContent = status.app.root || "-";
  if (metadataPath) metadataPath.textContent = status.historyFiles.metadata || "-";
  if (jsonPath) jsonPath.textContent = status.historyFiles.json || "-";
  if (csvPath) csvPath.textContent = status.historyFiles.csv || "-";
  if (kitTemplatesPath) kitTemplatesPath.textContent = status.historyFiles.kitTemplates || "-";

  const busy = Boolean(status.busy);
  refreshPortsButton.disabled = busy;
  revisionOverrideSelect.disabled = busy;
  runFullTestButton.disabled = busy || !portSelect.value;
  uploadButton.disabled = busy || !portSelect.value;
  connectButton.disabled = busy || !portSelect.value || status.serialConnected;
  disconnectButton.disabled = busy || !status.serialConnected;
  setupButton.disabled = busy;
  installPyserialButton.disabled = busy || status.requirements.pyserialFound;
  nextBoardButton.disabled = busy;
  updateTestMetadataButtonState(busy);
  updateSaveResultState(busy);
  updateArduinoTestButtonState(busy);
  kitTemplateSelect.disabled = busy;
  if (editKitSetsButton) editKitSetsButton.disabled = busy;

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
    setStatus("Board detected. Run the BLE Sense test or connect to live data.");
  } else {
    setStatus("Live data is active. Save the result when you are done.");
  }
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const status = await response.json();
    renderStatus(status);
  } catch (_error) {
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

revisionOverrideSelect?.addEventListener("change", () => {
  stickyStatus = null;
  sessionDirty = true;
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

kitTemplateSelect.addEventListener("change", async () => {
  await runAction(async () => {
    const result = await callApi("/api/templates/select", { templateId: kitTemplateSelect.value });
    sessionDirty = false;
    checklistDirty = false;
    setStatus(result.message);
  });
});

if (editKitSetsButton) {
  editKitSetsButton.addEventListener("click", () => {
    window.location.href = "./kit_sets.html";
  });
}

setupButton.addEventListener("click", async () => {
  await runAction(async () => {
    await callApi("/api/set-session", currentSessionPayload());
    sessionDirty = false;
    checklistDirty = false;
    setStatus("Preparing Arduino tools.");
    const result = await callApi("/api/setup", { revisionOverride: revisionOverrideSelect?.value || "auto" });
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
    await callApi("/api/set-session", currentSessionPayload());
    sessionDirty = false;
    checklistDirty = false;
    setStatus("Uploading test sketch.");
    const result = await callApi("/api/upload", {
      port: getSelectedPort(),
      revisionOverride: revisionOverrideSelect?.value || "auto"
    });
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

if (runKitTestButton) {
  runKitTestButton.addEventListener("click", async () => {
    await runAction(async () => {
      await testArduino();
    });
  });
}

resetArduinoTestButton.addEventListener("click", async () => {
  await runAction(async () => {
    const result = await callApi("/api/reset-arduino-test");
    checklistDirty = false;
    setStatus(result.message);
  });
});

saveResultButton.addEventListener("click", async () => {
  await runAction(async () => {
    const validationError = kitNumberError();
    if (validationError) {
      throw new Error(validationError);
    }
    if (shouldRunArduinoBeforeSave()) {
      throw new Error("Run the BLE Sense test before saving this kit.");
    }
    setStatus("Saving result for this kit.");
    await callApi("/api/set-session", currentSessionPayload());
    sessionDirty = false;
    checklistDirty = false;
    const result = await callApi("/api/record-result", { update: Boolean(editingInventoryId) });
    setStatus(result.message);
  });
});

recentTestsRows.addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-kit]");
  if (editButton) {
    await runAction(async () => {
      const inventoryId = editButton.dataset.editKit || "";
      setStatus(`Loading kit ${inventoryId} for update.`);
      const result = await callApi("/api/edit-result", { inventoryId });
      sessionDirty = false;
      checklistDirty = false;
      setStatus(result.message);
      document.querySelector("#statusText").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return;
  }
  const deleteButton = event.target.closest("[data-delete-kit]");
  if (!deleteButton || !deleteResultDialog) return;
  pendingDeleteInventoryId = deleteButton.dataset.deleteKit || "";
  deleteResultMessage.textContent = `Do you really want to delete the saved result for kit ${pendingDeleteInventoryId}?`;
  deleteResultDialog.showModal();
});

if (confirmDeleteResultButton && deleteResultDialog) {
  confirmDeleteResultButton.addEventListener("click", async () => {
    const inventoryId = pendingDeleteInventoryId;
    deleteResultDialog.close();
    if (!inventoryId) return;
    await runAction(async () => {
      const result = await callApi("/api/delete-result", { inventoryId });
      sessionDirty = false;
      checklistDirty = false;
      pendingDeleteInventoryId = "";
      setStatus(result.message);
    });
  });
  deleteResultDialog.addEventListener("close", () => {
    pendingDeleteInventoryId = "";
  });
}

nextBoardButton.addEventListener("click", async () => {
  await runAction(async () => {
    const result = await callApi("/api/reset-for-next");
    sessionDirty = false;
    checklistDirty = false;
    setStatus(result.message);
  });
});

portSelect.addEventListener("change", () => {
  selectedPort = portSelect.value;
});

async function startPolling() {
  await refreshStatus();
  pollTimer = window.setInterval(refreshStatus, 1500);
}

window.addEventListener("beforeunload", () => {
  if (pollTimer) window.clearInterval(pollTimer);
});

startPolling();
