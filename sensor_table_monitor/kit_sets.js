const kitTemplateSelect = document.querySelector("#kitTemplateSelect");
const kitTemplatesPath = document.querySelector("#kitTemplatesPath");
const newTemplateButton = document.querySelector("#newTemplateButton");
const duplicateTemplateButton = document.querySelector("#duplicateTemplateButton");
const deleteTemplateButton = document.querySelector("#deleteTemplateButton");
const templateNameInput = document.querySelector("#templateNameInput");
const templateDescriptionInput = document.querySelector("#templateDescriptionInput");
const templateItemsEditor = document.querySelector("#templateItemsEditor");
const addTemplateItemButton = document.querySelector("#addTemplateItemButton");
const saveTemplateButton = document.querySelector("#saveTemplateButton");
const deleteTemplateDialog = document.querySelector("#deleteTemplateDialog");
const deleteTemplateMessage = document.querySelector("#deleteTemplateMessage");
const confirmDeleteTemplateButton = document.querySelector("#confirmDeleteTemplateButton");

let currentTemplates = [];
let activeKitTemplateId = "";
let templateEditorDraft = null;
let templateEditorDirty = false;
let pendingDeleteTemplateId = "";

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

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    window.alert(error.message || "Action failed.");
  }
}

function getActiveTemplate() {
  return currentTemplates.find((template) => template.id === activeKitTemplateId) || currentTemplates[0] || null;
}

function buildBlankTemplateDraft() {
  return {
    id: "",
    name: "New Kit Set",
    description: "",
    items: [
      { id: "", label: "Arduino Nano 33 BLE Sense with headers", kind: "controller", severity: "critical" },
      { id: "", label: "Breadboard", kind: "component", severity: "missing" }
    ]
  };
}

function loadTemplateDraft(template, force = false) {
  if (!template) return;
  if (!force && templateEditorDirty) return;
  templateEditorDraft = cloneData(template);
  templateEditorDirty = false;
  renderTemplateEditor();
}

function renderKitTemplateSelect() {
  kitTemplateSelect.innerHTML = "";
  currentTemplates.forEach((template) => {
    const option = createElement("option", { value: template.id, text: template.name });
    if (template.id === activeKitTemplateId) option.selected = true;
    kitTemplateSelect.append(option);
  });
}

function renderTemplateEditor() {
  if (!templateEditorDraft) return;
  templateNameInput.value = templateEditorDraft.name || "";
  templateDescriptionInput.value = templateEditorDraft.description || "";
  templateItemsEditor.innerHTML = "";

  templateEditorDraft.items.forEach((item, index) => {
    const row = createElement("div", { className: "template-item-row" });

    const labelField = createElement("label", { className: "field" });
    labelField.append(createElement("span", { text: "Item label" }));
    const labelInput = createElement("input", { type: "text", value: item.label || "", placeholder: "Item name" });
    labelInput.addEventListener("input", () => {
      templateEditorDraft.items[index].label = labelInput.value;
      templateEditorDirty = true;
    });
    labelField.append(labelInput);

    const kindField = createElement("label", { className: "field" });
    kindField.append(createElement("span", { text: "Kind" }));
    const kindSelect = createElement("select");
    [
      { value: "component", label: "Component" },
      { value: "controller", label: "BLE Sense controller" }
    ].forEach((choice) => {
      const option = createElement("option", { value: choice.value, text: choice.label });
      if (item.kind === choice.value) option.selected = true;
      kindSelect.append(option);
    });
    kindSelect.addEventListener("change", () => {
      if (kindSelect.value === "controller") {
        templateEditorDraft.items.forEach((entry, entryIndex) => {
          entry.kind = entryIndex === index ? "controller" : "component";
        });
      } else {
        templateEditorDraft.items[index].kind = "component";
      }
      templateEditorDirty = true;
      renderTemplateEditor();
    });
    kindField.append(kindSelect);

    const severityField = createElement("label", { className: "field" });
    severityField.append(createElement("span", { text: "Severity" }));
    const severitySelect = createElement("select");
    [
      { value: "critical", label: "Critical" },
      { value: "missing", label: "Missing" },
      { value: "optional", label: "Optional" }
    ].forEach((choice) => {
      const option = createElement("option", { value: choice.value, text: choice.label });
      if (item.severity === choice.value) option.selected = true;
      severitySelect.append(option);
    });
    severitySelect.addEventListener("change", () => {
      templateEditorDraft.items[index].severity = severitySelect.value;
      templateEditorDirty = true;
    });
    severityField.append(severitySelect);

    const actions = createElement("div", { className: "template-item-actions" });
    const removeButton = createElement("button", { type: "button", text: "Remove" });
    removeButton.disabled = templateEditorDraft.items.length <= 2;
    removeButton.addEventListener("click", () => {
      templateEditorDraft.items.splice(index, 1);
      templateEditorDirty = true;
      renderTemplateEditor();
    });
    actions.append(removeButton);

    row.append(labelField, kindField, severityField, actions);
    templateItemsEditor.append(row);
  });
}

function currentTemplatePayload() {
  return {
    templateId: templateEditorDraft?.id || "",
    template: {
      id: templateEditorDraft?.id || "",
      name: templateNameInput.value.trim(),
      description: templateDescriptionInput.value.trim(),
      items: (templateEditorDraft?.items || []).map((item) => ({
        id: item.id || "",
        label: item.label?.trim() || "",
        kind: item.kind || "component",
        severity: item.severity || "missing"
      }))
    }
  };
}

async function refreshStatus() {
  const response = await fetch("/api/status", { cache: "no-store" });
  const status = await response.json();
  currentTemplates = cloneData(status.kitTemplates || []);
  activeKitTemplateId = status.activeKitTemplateId || "";
  renderKitTemplateSelect();
  loadTemplateDraft(getActiveTemplate());
  kitTemplatesPath.textContent = status.historyFiles.kitTemplates || "-";
  duplicateTemplateButton.disabled = !getActiveTemplate();
  deleteTemplateButton.disabled = currentTemplates.length <= 1;
}

kitTemplateSelect.addEventListener("change", async () => {
  await runAction(async () => {
    const result = await callApi("/api/templates/select", { templateId: kitTemplateSelect.value });
    activeKitTemplateId = result.template.id;
    templateEditorDirty = false;
    await refreshStatus();
  });
});

newTemplateButton.addEventListener("click", () => {
  templateEditorDraft = buildBlankTemplateDraft();
  templateEditorDirty = true;
  renderTemplateEditor();
});

duplicateTemplateButton.addEventListener("click", () => {
  const template = getActiveTemplate();
  if (!template) return;
  templateEditorDraft = cloneData(template);
  templateEditorDraft.id = "";
  templateEditorDraft.name = `${template.name} Copy`;
  templateEditorDirty = true;
  renderTemplateEditor();
});

deleteTemplateButton.addEventListener("click", () => {
  const template = getActiveTemplate();
  if (!template) return;
  pendingDeleteTemplateId = template.id;
  deleteTemplateMessage.textContent = `Do you really want to delete the kit set '${template.name}'?`;
  deleteTemplateDialog.showModal();
});

confirmDeleteTemplateButton.addEventListener("click", async () => {
  await runAction(async () => {
    const templateId = pendingDeleteTemplateId;
    deleteTemplateDialog.close();
    if (!templateId) return;
    await callApi("/api/templates/delete", { templateId });
    pendingDeleteTemplateId = "";
    templateEditorDirty = false;
    await refreshStatus();
  });
});

templateNameInput.addEventListener("input", () => {
  if (!templateEditorDraft) return;
  templateEditorDraft.name = templateNameInput.value;
  templateEditorDirty = true;
});

templateDescriptionInput.addEventListener("input", () => {
  if (!templateEditorDraft) return;
  templateEditorDraft.description = templateDescriptionInput.value;
  templateEditorDirty = true;
});

addTemplateItemButton.addEventListener("click", () => {
  if (!templateEditorDraft) {
    templateEditorDraft = buildBlankTemplateDraft();
  }
  templateEditorDraft.items.push({
    id: "",
    label: "",
    kind: "component",
    severity: "missing"
  });
  templateEditorDirty = true;
  renderTemplateEditor();
});

saveTemplateButton.addEventListener("click", async () => {
  await runAction(async () => {
    const result = await callApi("/api/templates/save", currentTemplatePayload());
    activeKitTemplateId = result.template.id;
    templateEditorDirty = false;
    await refreshStatus();
  });
});
deleteTemplateDialog.addEventListener("close", () => {
  pendingDeleteTemplateId = "";
});

runAction(refreshStatus);
