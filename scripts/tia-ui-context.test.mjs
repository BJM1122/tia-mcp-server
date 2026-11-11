import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  matchProjectIdentity,
  parseTiaBlockLabel,
  parseTiaUiContextJson,
  resolveBlockMatch,
  selectCurrentBlock
} from "../dist/tia-ui-context.js";

function contextFixture(overrides = {}) {
  return {
    schemaVersion: "1.0",
    observedAt: "2026-07-25T12:00:00.000Z",
    status: "selected",
    selectedProcessId: 42,
    foregroundProcessId: 42,
    foregroundWindowHandle: 1001,
    processes: [{
      processId: 42,
      projectName: "通用装配线",
      projectPath: "E:\\Projects\\Assembly\\通用装配线.ap20",
      mainWindowHandle: 1001,
      windowTitle: "Siemens - 通用装配线",
      isMinimized: false
    }],
    selectedObject: {
      status: "resolved",
      text: "ConveyorControl [FB42]",
      source: "project_navigator_msaa",
      candidates: []
    },
    activeEditor: {
      status: "resolved",
      breadcrumb: "Project\\CPU\\Program blocks\\ConveyorControl [FB42]",
      editorState: "Offline",
      source: "editor_frame_msaa",
      candidates: []
    },
    networkOrSection: {
      status: "resolved",
      label: "Network 3",
      number: "3",
      source: "network_container_msaa",
      candidates: []
    },
    limitations: ["Mouse hover is not observed."],
    ...overrides
  };
}

test("parses UTF-8 BOM, CRLF, and Unicode into a bounded canonical context", () => {
  const text = `\uFEFF${JSON.stringify(contextFixture(), null, 2)}\r\n`;
  const parsed = parseTiaUiContextJson(text, { maxBytes: 100_000 });
  assert.equal(parsed.status, "selected");
  assert.equal(parsed.processes[0].projectName, "通用装配线");
  assert.equal(parsed.networkOrSection.number, "3");
  assert.equal(parsed.foregroundProcessId, 42);
  assert.equal(parsed.processes[0].isMinimized, false);
});

test("rejects empty, malformed, and oversized companion output", () => {
  assert.throws(() => parseTiaUiContextJson(""), /empty/);
  assert.throws(() => parseTiaUiContextJson("{"), /invalid/);
  assert.throws(() => parseTiaUiContextJson(JSON.stringify(contextFixture()), { maxBytes: 10 }), /exceeds/);
});

test("parses generic block labels without a CPU or project assumption", () => {
  assert.deepEqual(parseTiaBlockLabel("ConveyorControl [FB0042]"), {
    name: "ConveyorControl",
    kind: "FB",
    number: "42",
    label: "ConveyorControl [FB42]"
  });
  assert.equal(parseTiaBlockLabel("Program blocks"), null);
});

test("selection wins over editor and disagreement is explicit", () => {
  const parsed = parseTiaUiContextJson(JSON.stringify(contextFixture({
    activeEditor: {
      status: "resolved",
      breadcrumb: "Project\\CPU\\Program blocks\\Sequence [FC7]",
      source: "editor_frame_msaa"
    }
  })));
  const selected = selectCurrentBlock(parsed);
  assert.equal(selected.status, "resolved");
  assert.equal(selected.source, "selectedObject");
  assert.equal(selected.block?.label, "ConveyorControl [FB42]");
  assert.equal(selected.activeEditor?.label, "Sequence [FC7]");
  assert.equal(selected.conflict, true);
});

test("visible editor is used only when no selected block identity is exposed", () => {
  const parsed = parseTiaUiContextJson(JSON.stringify(contextFixture({
    selectedObject: {
      status: "unavailable",
      text: "Program blocks",
      source: "project_navigator_msaa"
    }
  })));
  const selected = selectCurrentBlock(parsed);
  assert.equal(selected.source, "activeEditor");
  assert.equal(selected.block?.label, "ConveyorControl [FB42]");
  assert.equal(selected.conflict, false);
});

test("ambiguous navigator selection is explicit and does not silently fall back to the editor", () => {
  const parsed = parseTiaUiContextJson(JSON.stringify(contextFixture({
    selectedObject: {
      status: "ambiguous",
      source: "project_navigator_msaa",
      candidates: [
        { label: "ConveyorControl [FB42]" },
        { label: "Sequence [FC7]" }
      ]
    }
  })));
  const selected = selectCurrentBlock(parsed);
  assert.equal(selected.status, "ambiguous");
  assert.equal(selected.source, "selectedObject");
  assert.equal(selected.block, null);
  assert.equal(selected.candidates.length, 2);
});

test("project matching requires one exact canonical Windows ap20 path", () => {
  const candidates = [
    {
      exportDir: "E:\\Exports\\current",
      projectPaths: ["e:/projects/assembly/通用装配线.ap20"],
      projectNames: ["通用装配线"]
    },
    {
      exportDir: "E:\\Exports\\same-name-old",
      projectPaths: ["E:\\Archive\\通用装配线.ap20"],
      projectNames: ["通用装配线"]
    }
  ];
  const matched = matchProjectIdentity({
    projectPath: "E:\\Projects\\Assembly\\通用装配线.ap20",
    projectName: "通用装配线"
  }, candidates);
  assert.equal(matched.status, "matched");
  assert.equal(matched.match?.exportDir, "E:\\Exports\\current");
  assert.equal(matched.nameOnlyCandidates.length, 1);
});

test("name-only project candidates and duplicate exact snapshots are never auto-selected", () => {
  const nameOnly = matchProjectIdentity({
    projectPath: "E:\\Projects\\Live\\Line.ap20",
    projectName: "Line"
  }, [{
    exportDir: "E:\\Exports\\old",
    projectPaths: ["E:\\Archive\\Line.ap20"],
    projectNames: ["Line"]
  }]);
  assert.equal(nameOnly.status, "name_only");
  assert.equal(nameOnly.match, null);

  const duplicate = matchProjectIdentity({
    projectPath: "E:\\Projects\\Live\\Line.ap20",
    projectName: "Line"
  }, [
    { exportDir: "E:\\Exports\\a", projectPaths: ["E:\\Projects\\Live\\Line.ap20"] },
    { exportDir: "E:\\Exports\\b", projectPaths: ["e:/projects/live/line.ap20"] }
  ]);
  assert.equal(duplicate.status, "ambiguous");
  assert.equal(duplicate.match, null);
  assert.equal(duplicate.matches.length, 2);
});

test("a different recorded project path is an explicit not-found refusal", () => {
  const result = matchProjectIdentity({
    projectPath: "E:\\Projects\\Live\\Line.ap20",
    projectName: "LiveLine"
  }, [{
    exportDir: "E:\\Exports\\other",
    projectPaths: ["E:\\Projects\\Other\\Other.ap20"],
    projectNames: ["Other"]
  }]);
  assert.equal(result.status, "not_found");
  assert.equal(result.match, null);
  assert.deepEqual(result.matches, []);
});

test("window title or project name is not accepted as a project path", () => {
  const result = matchProjectIdentity({
    projectPath: "Siemens - E:\\Projects\\Live\\Line",
    projectName: "Line"
  }, [{ exportDir: "E:\\Exports\\a", projectNames: ["Line"] }]);
  assert.equal(result.status, "invalid_live_path");
  assert.equal(result.match, null);
});

test("block resolution uses name, kind, and number and refuses duplicates", () => {
  const identity = parseTiaBlockLabel("ConveyorControl [FB42]");
  const resolved = resolveBlockMatch(identity, [
    { name: "ConveyorControl", kind: "FB", number: "42", relativePath: "CPU_A/FB42.xml" },
    { name: "ConveyorControl", kind: "FC", number: "42", relativePath: "CPU_A/FC42.xml" }
  ]);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.item?.relativePath, "CPU_A/FB42.xml");

  const ambiguous = resolveBlockMatch(identity, [
    { name: "ConveyorControl", kind: "FB", number: "42", relativePath: "CPU_A/FB42.xml" },
    { name: "ConveyorControl", kind: "FB", number: "42", relativePath: "CPU_B/FB42.xml" }
  ]);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.item, null);
  assert.equal(ambiguous.matches.length, 2);
});

test("DB block resolution accepts GlobalDB and InstanceDB export kinds", () => {
  const globalIdentity = parseTiaBlockLabel("RecipeData [DB42]");
  const globalResolved = resolveBlockMatch(globalIdentity, [
    { name: "RecipeData", kind: "GlobalDB", number: "42", relativePath: "CPU_A/DB42.xml" }
  ]);
  assert.equal(globalResolved.status, "resolved");
  assert.equal(globalResolved.item?.relativePath, "CPU_A/DB42.xml");

  const instanceIdentity = parseTiaBlockLabel("MotorInstance [DB84]");
  const instanceResolved = resolveBlockMatch(instanceIdentity, [
    { name: "MotorInstance", kind: "InstanceDB", number: "84", relativePath: "CPU_A/DB84.xml" }
  ]);
  assert.equal(instanceResolved.status, "resolved");
  assert.equal(instanceResolved.item?.relativePath, "CPU_A/DB84.xml");

  const ambiguous = resolveBlockMatch(globalIdentity, [
    { name: "RecipeData", kind: "GlobalDB", number: "42", relativePath: "CPU_A/DB42.xml" },
    { name: "RecipeData", kind: "InstanceDB", number: "42", relativePath: "CPU_B/DB42.xml" }
  ]);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.item, null);
  assert.equal(ambiguous.matches.length, 2);
});

test("PowerShell companion contains no attach, UI invocation, capture, or TIA mutation calls", async () => {
  const source = await readFile(new URL("../tools/Get-TiaPortalUiContext.ps1", import.meta.url), "utf8");
  const forbidden = [
    /\.Attach\s*\(/i,
    /\.Open\s*\(/i,
    /\.Save\s*\(/i,
    /\.Compile\s*\(/i,
    /\.Download\s*\(/i,
    /\.GoOnline\s*\(/i,
    /accSelect\s*\(/i,
    /accDoDefaultAction\s*\(/i,
    /SetForegroundWindow\s*\(/i,
    /SetFocus\s*\(/i,
    /SendInput\s*\(/i,
    /mouse_event\s*\(/i,
    /keybd_event\s*\(/i,
    /BitBlt\s*\(/i,
    /CopyFromScreen\s*\(/i,
    /ShowInEditor\s*\(/i,
    /InvokePattern/i,
    /SetValue\s*\(/i
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern);
  }
  assert.match(source, /TiaPortal\]::GetProcesses\(\)/);
  assert.match(source, /AccessibleObjectFromWindow/);
});
