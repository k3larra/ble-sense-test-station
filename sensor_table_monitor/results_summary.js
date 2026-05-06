const summaryStatusText = document.querySelector("#summaryStatusText");
const refreshSummaryButton = document.querySelector("#refreshSummaryButton");
const printSummaryButton = document.querySelector("#printSummaryButton");
const resultSummaryCards = document.querySelector("#resultSummaryCards");
const summaryTestName = document.querySelector("#summaryTestName");
const summaryResponsible = document.querySelector("#summaryResponsible");
const summaryGeneratedAt = document.querySelector("#summaryGeneratedAt");
const summaryNotes = document.querySelector("#summaryNotes");
const summaryJsonPath = document.querySelector("#summaryJsonPath");
const summaryCsvPath = document.querySelector("#summaryCsvPath");
const boardCountText = document.querySelector("#boardCountText");
const boardRows = document.querySelector("#boardRows");
const missingCountText = document.querySelector("#missingCountText");
const missingRows = document.querySelector("#missingRows");

let refreshTimer = null;

function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.type) element.type = options.type;
  return element;
}

function displayValue(value) {
  const text = `${value || ""}`.trim();
  return text || "-";
}

function severityLabel(severity) {
  if (severity === "critical") return "Critical";
  if (severity === "optional") return "Optional";
  return "Missing";
}

function missingItemsForRecord(record) {
  return [
    ...(Array.isArray(record.missing_critical_items) ? record.missing_critical_items.map((label) => ({ label, severity: "critical" })) : []),
    ...(Array.isArray(record.missing_standard_items) ? record.missing_standard_items.map((label) => ({ label, severity: "missing" })) : []),
    ...(Array.isArray(record.missing_optional_items) ? record.missing_optional_items.map((label) => ({ label, severity: "optional" })) : [])
  ];
}

function kitLabel(record) {
  return displayValue(record.inventory_id || record.inventory_name || record.board_uid);
}

function renderSummaryCards(summary = {}) {
  resultSummaryCards.innerHTML = "";
  [
    { label: "Total", value: summary.total || 0, tone: "neutral", note: "Saved boards in this batch." },
    { label: "Pass", value: summary.PASS || 0, tone: "ok", note: "Board tested and kit complete." },
    { label: "Attention", value: summary.ATTENTION || 0, tone: "attention", note: "Needs human follow-up." },
    { label: "Fail / Incomplete", value: (summary.FAIL || 0) + (summary["KIT-INCOMPLETE"] || 0), tone: "problem", note: "Critical issue or missing required parts." }
  ].forEach((card) => {
    const article = createElement("article", { className: `summary-card ${card.tone}` });
    article.append(
      createElement("strong", { text: `${card.value}` }),
      createElement("h3", { text: card.label }),
      createElement("p", { className: "small", text: card.note })
    );
    resultSummaryCards.append(article);
  });
}

function renderBoards(records) {
  boardRows.innerHTML = "";
  boardCountText.textContent = records.length
    ? `${records.length} saved board${records.length === 1 ? "" : "s"}.`
    : "No saved boards yet.";

  records.slice().reverse().forEach((record) => {
    const missingItems = missingItemsForRecord(record);
    const missingText = missingItems.length
      ? missingItems.map((item) => `${severityLabel(item.severity)}: ${item.label}`).join(" | ")
      : "-";
    const tr = document.createElement("tr");
    [
      kitLabel(record),
      record.inventory_name || "",
      record.result || "",
      record.revision || "",
      missingText,
      record.tested_at || ""
    ].forEach((value) => tr.append(createElement("td", { text: value })));
    boardRows.append(tr);
  });
}

function aggregateMissingItems(records) {
  const totals = new Map();
  records.forEach((record) => {
    const kit = kitLabel(record);
    missingItemsForRecord(record).forEach((item) => {
      const key = `${item.severity}::${item.label}`;
      const existing = totals.get(key) || { label: item.label, severity: item.severity, count: 0, kits: [] };
      existing.count += 1;
      existing.kits.push(kit);
      totals.set(key, existing);
    });
  });
  return [...totals.values()].sort((a, b) => {
    const severityOrder = { critical: 0, missing: 1, optional: 2 };
    return (severityOrder[a.severity] - severityOrder[b.severity]) || b.count - a.count || a.label.localeCompare(b.label);
  });
}

function renderMissingItems(records) {
  const totals = aggregateMissingItems(records);
  missingRows.innerHTML = "";
  missingCountText.textContent = totals.length
    ? `${totals.reduce((sum, item) => sum + item.count, 0)} missing item${totals.length === 1 ? "" : "s"} across ${totals.length} line${totals.length === 1 ? "" : "s"}.`
    : "No missing items recorded.";

  totals.forEach((item) => {
    const tr = document.createElement("tr");
    tr.append(
      createElement("td", { text: item.label }),
      createElement("td", { text: `${item.count}` }),
      createElement("td", { text: severityLabel(item.severity) }),
      createElement("td", { text: item.kits.join(", ") })
    );
    missingRows.append(tr);
  });
}

function renderPayload(payload) {
  const metadata = payload.testMetadata || {};
  const records = Array.isArray(payload.records) ? payload.records : [];
  summaryTestName.textContent = displayValue(metadata.test_name);
  summaryResponsible.textContent = displayValue(metadata.test_responsible);
  summaryGeneratedAt.textContent = displayValue(payload.generatedAt);
  summaryNotes.textContent = displayValue(metadata.notes);
  summaryJsonPath.textContent = payload.historyFiles?.json || "-";
  summaryCsvPath.textContent = payload.historyFiles?.csv || "-";
  renderSummaryCards(payload.historySummary || {});
  renderBoards(records);
  renderMissingItems(records);
  summaryStatusText.textContent = "Showing saved results. This page refreshes while the test station is open.";
}

async function refreshSummary() {
  refreshSummaryButton.disabled = true;
  try {
    const response = await fetch("/api/results-summary", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load saved results.");
    renderPayload(await response.json());
  } catch (error) {
    summaryStatusText.textContent = error.message || "Could not load saved results.";
  } finally {
    refreshSummaryButton.disabled = false;
  }
}

refreshSummaryButton.addEventListener("click", refreshSummary);
printSummaryButton.addEventListener("click", () => {
  window.print();
});

window.addEventListener("beforeunload", () => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});

window.addEventListener("beforeprint", () => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});

window.addEventListener("afterprint", () => {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(refreshSummary, 5000);
});

refreshSummary();
refreshTimer = window.setInterval(refreshSummary, 5000);
