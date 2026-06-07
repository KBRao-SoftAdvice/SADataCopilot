// Long-lived Node sidecar that drives @github/copilot-sdk on behalf of
// server.py. Reads one JSON request per stdin line, writes a stream of
// JSON event lines to stdout, then a final "end" event. server.py
// translates these into SSE for the browser.
//
// Per-request flow mirrors the vscode CopilotBackend:
//   1. fresh sessionId
//   2. seed events.jsonl + sessions row from priorRuns (per-cell history)
//   3. resumeSession (BYOK, custom python_run tool registered)
//   4. run, stream events to stdout
//   5. read events.jsonl back, return new events as result.history
//   6. cleanup session-state dir + sql rows
//
// Protocol:
//   stdin  : {"requestId":"...", "prompt":"...", "model":"gpt-5-mini",
//             "kernelId":"...", "isExcluded":false,
//             "priorRuns":[{kind, included, source?, output?, history?}, ...]}
//   stdout : {"requestId":"...", "type":"event", "event":{...}}
//            ...
//            {"requestId":"...", "type":"end",
//             "result":{usage, cost, duration_ms, history}}
//          | {"requestId":"...", "type":"error", "message":"..."}

import { CopilotClient, RuntimeConnection, approveAll, defineTool } from "@github/copilot-sdk";
import { z } from "zod";  // MUST be v4 — defineTool produces a broken schema with v3 and tools silently fail to register.
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const KERNEL_TOOL_NAME = "python_run";
const COPILOT_VERSION = "1.0.50";
const SQLITE_BIN = "/usr/bin/sqlite3";

const KERNEL_BRIDGE_URL = process.env.KERNEL_BRIDGE_URL
  || "http://127.0.0.1:8787/api/kernel-bridge/run";
const KERNEL_BRIDGE_TOKEN = process.env.KERNEL_BRIDGE_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");

if (!OPENAI_API_KEY) {
  process.stderr.write("[sidecar] OPENAI_API_KEY must be set\n");
  process.exit(2);
}

function copilotHome() {
  return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}
function storeDbPath() {
  return path.join(copilotHome(), "session-store.db");
}
function quote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function resolveCopilotCli() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const local = path.join(here, "node_modules", "@github", "copilot", "index.js");
  if (fs.existsSync(local)) return local;
  throw new Error("@github/copilot not installed locally; run npm install");
}

const CLI_PATH = resolveCopilotCli();

const client = new CopilotClient({
  logLevel: "error",
  connection: RuntimeConnection.forStdio({ path: CLI_PATH }),
});
await client.start();

// Force the SDK to materialize the session-store SQLite schema before our
// first prepareSession() call (which INSERTs into sessions/turns directly).
// On a fresh container the DB file doesn't exist yet; createSession is the
// cheapest way to make the SDK run its migrations.
try {
  const warmupId = crypto.randomUUID();
  const s = await client.createSession({
    sessionId: warmupId,
    model: "gpt-5-mini",
    provider: { type: "openai", baseUrl: OPENAI_BASE_URL, apiKey: OPENAI_API_KEY },
  });
  try { await s.disconnect(); } catch { /* ignore */ }
  try { await client.deleteSession(warmupId); } catch { /* ignore */ }
} catch (e) {
  process.stderr.write(`[sidecar] warmup failed (continuing): ${e.message || e}\n`);
}

process.stderr.write("[sidecar] ready\n");

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function runPythonInKernel(kernelId, code) {
  const res = await fetch(KERNEL_BRIDGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + KERNEL_BRIDGE_TOKEN,
    },
    body: JSON.stringify({ kernelId, code }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`kernel bridge HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.output || "";
}

function shapeEvent(event, toolNameById) {
  switch (event.type) {
    case "assistant.message": {
      const text = event.data?.content || "";
      if (!text) return null;
      return [{ kind: "assistant_text", text }];
    }
    case "tool.execution_start": {
      const name = event.data?.toolName || "unknown";
      const id = event.data?.toolCallId || "";
      const input = event.data?.arguments || {};
      if (id) toolNameById.set(id, name);
      return [{ kind: "tool_use", id, name, input }];
    }
    case "tool.execution_complete": {
      const id = event.data?.toolCallId || "";
      const name = id ? (toolNameById.get(id) || "") : "";
      const text = extractToolResultText(event.data?.result);
      const out = [{ kind: "tool_result", id, name, text }];
      if (event.data?.error) {
        out.push({
          kind: "assistant_text",
          text: `[error] ${event.data.error.message || event.data.error}`,
        });
      }
      return out;
    }
    default:
      return null;
  }
}

function extractToolResultText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
      .join("\n")
      .trim();
  }
  if (typeof result === "object") {
    if (typeof result.text === "string") return result.text;
    if (typeof result.textResultForLlm === "string") return result.textResultForLlm;
    if (Array.isArray(result.content)) {
      const parts = [];
      for (const item of result.content) {
        if (item && typeof item === "object" && typeof item.text === "string") parts.push(item.text);
      }
      if (parts.length) return parts.join("\n");
    }
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

// ----- session seeding (vscode parity) -----

function synthesizePythonNarration(index, source, output) {
  return (
    `Python cell ${index + 1} (executed in this notebook):\n` +
    "```python\n" + source + "\n```\n" +
    "Output:\n```\n" + (output || "(no output)") + "\n```"
  );
}

function appendSyntheticTurn(seeded, startParentId, userText, assistantText, model) {
  const now = () => new Date().toISOString();
  const interactionId = crypto.randomUUID();

  const userId = crypto.randomUUID();
  seeded.push({
    type: "user.message",
    data: {
      content: userText,
      attachments: [],
      supportedNativeDocumentMimeTypes: [],
      interactionId,
    },
    id: userId,
    timestamp: now(),
    parentId: startParentId,
  });

  const turnStartId = crypto.randomUUID();
  seeded.push({
    type: "assistant.turn_start",
    data: { turnId: "0", interactionId },
    id: turnStartId,
    timestamp: now(),
    parentId: userId,
  });

  const assistantMessageId = crypto.randomUUID();
  seeded.push({
    type: "assistant.message",
    data: {
      messageId: assistantMessageId,
      model,
      content: assistantText,
      toolRequests: [],
      interactionId,
      turnId: "0",
      outputTokens: 8,
    },
    id: assistantMessageId,
    timestamp: now(),
    parentId: turnStartId,
  });

  const turnEndId = crypto.randomUUID();
  seeded.push({
    type: "assistant.turn_end",
    data: { turnId: "0" },
    id: turnEndId,
    timestamp: now(),
    parentId: assistantMessageId,
  });

  return turnEndId;
}

// Build events.jsonl + insert SQLite rows for the new sessionId. Returns
// the set of event IDs we wrote so we can later distinguish them from
// events the agent appended during the actual run.
function prepareSession(sessionId, model, cwd, isExcluded, priorRuns) {
  const sessionDir = path.join(copilotHome(), "session-state", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const seeded = [];
  let lastId = null;
  const now = () => new Date().toISOString();

  const startId = crypto.randomUUID();
  seeded.push({
    type: "session.start",
    data: {
      sessionId,
      version: 1,
      producer: "copilot-agent",
      copilotVersion: COPILOT_VERSION,
      startTime: now(),
      selectedModel: model,
      context: { cwd, gitRoot: cwd, hostType: "github" },
      alreadyInUse: false,
      remoteSteerable: false,
    },
    id: startId,
    timestamp: now(),
    parentId: null,
  });
  lastId = startId;

  const systemId = crypto.randomUUID();
  seeded.push({
    type: "system.message",
    data: {
      role: "system",
      content:
        "You are a helpful assistant inside a notebook. Answer the user " +
        "concisely and use tools when appropriate.",
    },
    id: systemId,
    timestamp: now(),
    parentId: lastId,
  });
  lastId = systemId;

  const turnsRows = [];

  if (!isExcluded && Array.isArray(priorRuns)) {
    for (let i = 0; i < priorRuns.length; i++) {
      const record = priorRuns[i];
      if (!record || record.included === false) continue;
      if (record.kind === "python") {
        if (!record.source || !String(record.source).trim()) continue;
        const userText = synthesizePythonNarration(i, record.source, record.output || "");
        const assistantText = "(noted — Python state recorded)";
        lastId = appendSyntheticTurn(seeded, lastId, userText, assistantText, model);
        turnsRows.push({ user: userText, assistant: assistantText });
      } else if (record.kind === "prompt") {
        const history = record.history;
        const events = history && Array.isArray(history.events) ? history.events : null;
        if (!events || !events.length) continue;
        for (let j = 0; j < events.length; j++) {
          const ev = events[j];
          const cloned = {
            type: ev.type,
            data: ev.data,
            id: ev.id,
            timestamp: ev.timestamp,
            parentId: j === 0 ? lastId : ev.parentId,
          };
          seeded.push(cloned);
          lastId = ev.id;
        }
        turnsRows.push({
          user: history.userMessage || "",
          assistant: history.assistantMessage || "",
        });
      }
    }
  }

  fs.writeFileSync(
    path.join(sessionDir, "events.jsonl"),
    seeded.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );

  const sql = [];
  sql.push(
    `INSERT OR REPLACE INTO sessions (id, cwd, host_type, created_at, updated_at) ` +
    `VALUES (${quote(sessionId)}, ${quote(cwd)}, 'github', datetime('now'), datetime('now'));`,
  );
  for (let i = 0; i < turnsRows.length; i++) {
    const r = turnsRows[i];
    sql.push(
      `INSERT INTO turns (session_id, turn_index, user_message, assistant_response) ` +
      `VALUES (${quote(sessionId)}, ${i}, ${quote(r.user)}, ${quote(r.assistant)});`,
    );
  }
  try {
    execFileSync(SQLITE_BIN, [storeDbPath()], { input: sql.join("\n"), stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    throw new Error(`Failed to seed Copilot session metadata: ${err.message || err}`);
  }

  return new Set(seeded.map((e) => e.id));
}

async function cleanupSession(sessionId) {
  try { await client.deleteSession(sessionId); } catch { /* ignore */ }
  try {
    const dir = path.join(copilotHome(), "session-state", sessionId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
  try {
    const sql =
      `DELETE FROM turns WHERE session_id = ${quote(sessionId)};\n` +
      `DELETE FROM session_files WHERE session_id = ${quote(sessionId)};\n` +
      `DELETE FROM session_refs WHERE session_id = ${quote(sessionId)};\n` +
      `DELETE FROM checkpoints WHERE session_id = ${quote(sessionId)};\n` +
      `DELETE FROM sessions WHERE id = ${quote(sessionId)};`;
    execFileSync(SQLITE_BIN, [storeDbPath()], { input: sql, stdio: ["pipe", "pipe", "pipe"] });
  } catch { /* ignore */ }
}

// Read events.jsonl after the run, return events whose IDs are NOT in the
// pre-seeded set — i.e. those produced by this turn.
function readNewEvents(sessionId, seededIds) {
  const eventsPath = path.join(copilotHome(), "session-state", sessionId, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return [];
  const raw = fs.readFileSync(eventsPath, "utf-8");
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t);
      if (!ev || typeof ev !== "object") continue;
      if (!ev.id || seededIds.has(ev.id)) continue;
      // session.shutdown is lifecycle metadata, not turn content.
      if (ev.type === "session.shutdown") continue;
      out.push(ev);
    } catch {
      // skip malformed
    }
  }
  return out;
}

const PROMPT_PREAMBLE =
  "You are answering inside a notebook prompt cell. To work with Python, " +
  "use the python_run tool: it executes code in the live notebook kernel " +
  "and returns stdout/stderr to you. The kernel shares the same namespace " +
  "as the user's Python cells, so variables like `df` defined earlier are " +
  "available. Use python_run whenever you need to inspect data, check " +
  "shapes/values, or compute something to reason about. Side effects " +
  "persist — prefer non-mutating queries unless the user explicitly asks " +
  "you to change state.";

async function handleRequest(req) {
  const { requestId, prompt, model, kernelId, isExcluded, priorRuns, workspace } = req;
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let cost = 0;

  const pythonRunTool = defineTool(KERNEL_TOOL_NAME, {
    description:
      "Run Python code in the notebook kernel and return stdout/stderr. " +
      "Variables defined in user cells are visible; side effects persist.",
    parameters: z.object({
      code: z.string().describe("Python source to execute in the kernel"),
    }),
    handler: async ({ code }) => {
      try {
        return await runPythonInKernel(kernelId, code);
      } catch (err) {
        return `[kernel error] ${err.message || err}`;
      }
    },
    skipPermission: true,
  });

  const modelId = model || "gpt-5-mini";
  const sessionId = crypto.randomUUID();
  // Per-kernel workspace: apply_patch / file tools land in the notebook's
  // sandbox directory (visible in the FILES sidebar) and Python cells share
  // the same dir as their cwd.
  if (!workspace || !fs.existsSync(workspace)) {
    emit({ requestId, type: "error", message: "workspace dir missing or unreadable" });
    return;
  }
  const cwd = workspace;
  let answerText = "";
  let seededIds;

  try {
    seededIds = prepareSession(sessionId, modelId, cwd, !!isExcluded, priorRuns || []);
  } catch (err) {
    emit({ requestId, type: "error", message: `prepareSession failed: ${err.message || err}` });
    return;
  }

  let session;
  try {
    session = await client.resumeSession(sessionId, {
      model: modelId,
      provider: {
        type: "openai",
        baseUrl: OPENAI_BASE_URL,
        apiKey: OPENAI_API_KEY,
      },
      tools: [pythonRunTool],
      onPermissionRequest: approveAll,
      workingDirectory: cwd,
      streaming: true,
    });
  } catch (err) {
    emit({ requestId, type: "error", message: `resumeSession failed: ${err.message || err}` });
    await cleanupSession(sessionId);
    return;
  }

  const toolNameById = new Map();
  const unsubscribe = session.on((event) => {
    try {
      if (event.type === "assistant.usage" && event.data) {
        const d = event.data;
        usage.input_tokens += d.inputTokens || 0;
        usage.output_tokens += d.outputTokens || 0;
        usage.cache_read_input_tokens += d.cacheReadTokens || 0;
        usage.cache_creation_input_tokens += d.cacheWriteTokens || 0;
        if (typeof d.cost === "number") cost += d.cost;
      }
      if (event.type === "assistant.message" && event.data?.content) {
        answerText += event.data.content;
      }
      const shaped = shapeEvent(event, toolNameById);
      if (shaped) {
        for (const ev of shaped) emit({ requestId, type: "event", event: ev });
      }
    } catch (e) {
      process.stderr.write(`[sidecar] handler error: ${e}\n`);
    }
  });

  const startedAt = Date.now();
  const promptText = isExcluded ? prompt : (PROMPT_PREAMBLE + "\n\n" + prompt);
  try {
    await session.sendAndWait({ prompt: promptText }, 600_000);
  } catch (err) {
    emit({ requestId, type: "error", message: String(err.message || err) });
  } finally {
    unsubscribe();
    try { await session.disconnect(); } catch { /* ignore */ }
  }

  // Capture this turn's new events for replay on the next cell.
  let history;
  try {
    const newEvents = readNewEvents(sessionId, seededIds);
    history = {
      events: newEvents,
      userMessage: prompt,
      assistantMessage: answerText,
    };
  } catch {
    history = { events: [], userMessage: prompt, assistantMessage: answerText };
  }

  await cleanupSession(sessionId);

  emit({
    requestId,
    type: "end",
    result: {
      usage,
      cost,
      duration_ms: Date.now() - startedAt,
      history,
    },
  });
}

let queue = Promise.resolve();
function enqueue(req) {
  queue = queue.then(() => handleRequest(req)).catch((e) => {
    process.stderr.write(`[sidecar] queue error: ${e}\n`);
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch (e) {
      process.stderr.write(`[sidecar] bad json: ${e}\n`);
      continue;
    }
    enqueue(req);
  }
});

process.stdin.on("end", async () => {
  await queue;
  try { await client.stop(); } catch { /* ignore */ }
  process.exit(0);
});
