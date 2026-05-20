#!/usr/bin/env node
/* eslint-disable */
/**
 * Standalone MCP stdio server. Spawned as a child of `claude` via --mcp-config.
 * Declares the python_run tool and forwards each call to the extension's
 * KernelBridge over localhost HTTP.
 *
 * Configuration via env (set by the parent extension when spawning claude):
 *   KERNEL_BRIDGE_URL    e.g. http://127.0.0.1:54321
 *   KERNEL_BRIDGE_TOKEN  one-time bearer token scoped to this run
 */

'use strict';

const http = require('http');
const readline = require('readline');
const { URL } = require('url');

const BRIDGE_URL = process.env.KERNEL_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.KERNEL_BRIDGE_TOKEN;

const TOOL = {
  name: 'python_run',
  description:
    'Execute Python code in the user\'s notebook kernel and return stdout/stderr. ' +
    'Shares the same namespace as the user\'s Python cells, so variables defined ' +
    'in earlier cells (e.g. df, model) are accessible. Use this whenever you ' +
    'need to inspect data, run a quick check, or compute something whose result ' +
    'you will reason about. Side effects (reassigning variables, deleting ' +
    'state) persist; prefer non-mutating queries unless the user explicitly ' +
    'asks you to change state.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Python source to execute. Last expression is auto-printed (REPL semantics).',
      },
    },
    required: ['code'],
  },
};

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function callBridge(code) {
  return new Promise((resolve, reject) => {
    if (!BRIDGE_URL || !BRIDGE_TOKEN) {
      reject(new Error('Kernel bridge not configured (missing env)'));
      return;
    }
    const u = new URL('/run', BRIDGE_URL);
    const body = JSON.stringify({ code });
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: 'Bearer ' + BRIDGE_TOKEN,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            reject(new Error('Bridge ' + res.statusCode + ': ' + text));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function handle(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'claude-notebook-kernel', version: '0.1.0' },
      capabilities: { tools: {} },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return; // no response for notifications
  }

  if (method === 'tools/list') {
    respond(id, { tools: [TOOL] });
    return;
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name !== TOOL.name) {
      respondError(id, -32601, 'Unknown tool: ' + name);
      return;
    }
    const code = typeof args.code === 'string' ? args.code : '';
    if (!code.trim()) {
      respond(id, {
        content: [{ type: 'text', text: '(empty code)' }],
        isError: true,
      });
      return;
    }
    try {
      const { ok, output } = await callBridge(code);
      respond(id, {
        content: [{ type: 'text', text: output && output.length ? output : '(no output)' }],
        isError: !ok,
      });
    } catch (err) {
      respond(id, {
        content: [{ type: 'text', text: 'Bridge error: ' + (err && err.message ? err.message : String(err)) }],
        isError: true,
      });
    }
    return;
  }

  if (id !== undefined) {
    respondError(id, -32601, 'Method not found: ' + method);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  Promise.resolve(handle(msg)).catch((err) => {
    if (msg && msg.id !== undefined) {
      respondError(msg.id, -32603, String(err));
    }
  });
});

process.stdin.on('end', () => process.exit(0));
