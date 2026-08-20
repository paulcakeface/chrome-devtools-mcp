/*
 * Copyright 2026 Paulcake
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paulcake Edition lifecycle/hosting layer for Chrome DevTools MCP.
 */
'use strict';
const http = require('http');
const net = require('net');
const {spawn} = require('child_process');

const HOST = '0.0.0.0';
const PORT = 8000;
const MAX_BODY = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;
const CHILD_PROTOCOL_VERSION = '2025-11-25';
const IDLE_PARK_MS = Math.max(1000, Number(process.env.BROWSER_IDLE_PARK_MS || 20 * 60 * 1000));
const IDLE_RECYCLE_MS = Math.max(IDLE_PARK_MS + 1000, Number(process.env.BROWSER_IDLE_RECYCLE_MS || 60 * 60 * 1000));
const IDLE_CHECK_MS = Math.max(1000, Number(process.env.BROWSER_IDLE_CHECK_MS || 10 * 1000));
const LEASE_MAX_MS = Math.max(IDLE_RECYCLE_MS, Number(process.env.BROWSER_ACTIVITY_LEASE_MAX_MS || 2 * 60 * 60 * 1000));

let stopping = false;
let ready = false;
let childInitResult = null;
let nextInternalId = 1000;
const pending = new Map();
let activeExternalCalls = 0;
let lastExternalActivity = Date.now();
let parked = true;
let recycledSinceActivity = true;
let maintenancePromise = null;
const activityLeases = new Map();
const intentionalChildren = new WeakSet();

function exitHard(reason) {
  if (stopping) return;
  stopping = true;
  console.error(`[gateway] fatal: ${reason}`);
  try { server?.close(); } catch (_) {}
  try { if (chrome && !chrome.killed) chrome.kill('SIGTERM'); } catch (_) {}
  try { if (proxy && !proxy.killed) proxy.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => process.exit(1), 150);
}

function waitPort(host, port, attempts=50) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tryOnce = () => {
      const s = net.connect({host, port});
      s.setTimeout(500);
      s.once('connect', () => { s.destroy(); resolve(); });
      const fail = () => {
        s.destroy();
        if (++n >= attempts) reject(new Error(`port ${port} not ready`));
        else setTimeout(tryOnce, 100);
      };
      s.once('error', fail);
      s.once('timeout', fail);
    };
    tryOnce();
  });
}

const proxy = spawn(process.execPath, ['/usr/local/lib/browser-egress-proxy.js'], {
  stdio: ['ignore', 'inherit', 'inherit']
});
proxy.on('error', err => exitHard(`egress proxy spawn failed: ${err.message}`));
proxy.on('exit', (code, signal) => {
  if (!stopping) exitHard(`egress proxy exited code=${code} signal=${signal}`);
});

const chromeArgs = [
  '--headless=true',
  '--isolated=true',
  '--redact-network-headers=true',
  '--performance-crux=false',
  '--memory-debugging=true',
  '--experimental-vision=true',
  '--experimental-screencast=true',
  '--experimental-ffmpeg-path=/usr/bin/ffmpeg',
  '--usage-statistics=false',
  '--screenshot-format=webp',
  '--screenshot-max-width=1800',
  '--proxy-server=http://127.0.0.1:8899',
  '--chrome-arg=--proxy-bypass-list=<-loopback>',
  '--chrome-arg=--no-sandbox',
  '--blocked-url-pattern=http://127.0.0.1/*',
  '--blocked-url-pattern=https://127.0.0.1/*',
  '--blocked-url-pattern=http://localhost/*',
  '--blocked-url-pattern=https://localhost/*',
  '--blocked-url-pattern=http://192.168.*/*',
  '--blocked-url-pattern=https://192.168.*/*',
  '--blocked-url-pattern=http://10.*/*',
  '--blocked-url-pattern=https://10.*/*',
  '--blocked-url-pattern=http://169.254.*/*',
  '--blocked-url-pattern=https://169.254.*/*'
];

let chrome = null;
let stdoutBuffer = '';

function toolResultText(result) {
  return (result?.content || []).filter(x => x?.type === 'text').map(x => x.text || '').join('\n');
}

function pageIdsFromListResult(result) {
  const ids = [];
  for (const match of toolResultText(result).matchAll(/^(\d+):/gm)) ids.push(Number(match[1]));
  return [...new Set(ids)].filter(Number.isFinite).sort((a,b) => a-b);
}

function recordToolSuccess(name, args) {
  const now = Date.now();
  if (name === 'screencast_start') { activityLeases.set('screencast', now); console.error('[gateway] activity lease start name=screencast'); }
  if (name === 'screencast_stop') { activityLeases.delete('screencast'); console.error('[gateway] activity lease stop name=screencast'); }
  if (name === 'performance_start_trace' && args?.autoStop === false) { activityLeases.set('performance_trace', now); console.error('[gateway] activity lease start name=performance_trace'); }
  if (name === 'performance_stop_trace') { activityLeases.delete('performance_trace'); console.error('[gateway] activity lease stop name=performance_trace'); }
}

function expireStaleLeases(now=Date.now()) {
  for (const [name, startedAt] of activityLeases) {
    if (now - startedAt >= LEASE_MAX_MS) {
      console.error(`[gateway] expiring stale activity lease name=${name} age_ms=${now-startedAt}`);
      activityLeases.delete(name);
    }
  }
}

function sanitiseParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const clean = {...params};
  if (clean._meta && typeof clean._meta === 'object') {
    const meta = {};
    for (const [k,v] of Object.entries(clean._meta)) {
      if (!k.startsWith('openai/') && k !== 'io.modelcontextprotocol/clientCapabilities') meta[k] = v;
    }
    if (Object.keys(meta).length) clean._meta = meta;
    else delete clean._meta;
  }
  return clean;
}

function childRequest(method, params, timeoutMs=REQUEST_TIMEOUT_MS) {
  if (!chrome || chrome.killed || !chrome.stdin.writable) return Promise.reject(new Error('Chrome MCP child unavailable'));
  const id = nextInternalId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`child request timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, {resolve, reject, timer});
    try {
      chrome.stdin.write(JSON.stringify({jsonrpc:'2.0', id, method, params: sanitiseParams(params)}) + '\n');
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
}

function childNotify(method, params) {
  if (!chrome || chrome.killed || !chrome.stdin.writable) return;
  try { chrome.stdin.write(JSON.stringify({jsonrpc:'2.0', method, params: sanitiseParams(params)}) + '\n'); }
  catch (_) {}
}

function onChildLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (_) { console.error(`[chrome-mcp stdout non-json] ${line}`); return; }
  if (Object.prototype.hasOwnProperty.call(msg, 'id') && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'MCP child error'), {rpcError: msg.error}));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method) console.error(`[chrome-mcp notification] ${msg.method}`);
}

async function startChrome() {
  await waitPort('127.0.0.1', 8899);
  stdoutBuffer = '';
  const proc = spawn('chrome-devtools-mcp', chromeArgs, {stdio:['pipe','pipe','pipe']});
  chrome = proc;
  proc.on('error', err => exitHard(`chrome-devtools-mcp spawn failed: ${err.message}`));
  proc.on('exit', (code, signal) => {
    for (const [,p] of pending) { clearTimeout(p.timer); p.reject(new Error('Chrome MCP child exited')); }
    pending.clear();
    if (chrome === proc) chrome = null;
    if (!stopping && !intentionalChildren.has(proc)) exitHard(`chrome-devtools-mcp exited code=${code} signal=${signal}`);
  });
  proc.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) onChildLine(line);
  });
  proc.stderr.on('data', chunk => process.stderr.write(`[chrome-mcp] ${chunk.toString('utf8')}`));

  childInitResult = await childRequest('initialize', {
    protocolVersion: CHILD_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {name:'paulcake-persistent-browser-gateway', version:'1.1.0-lifecycle'}
  }, 30000);
  childNotify('notifications/initialized', {});
  ready = true;
  parked = true;
  console.error(`[gateway] persistent Chrome DevTools MCP ready version=${childInitResult?.serverInfo?.version || 'unknown'} lifecycle=1.1.0`);
}

async function stopChromeChild(reason) {
  const proc = chrome;
  if (!proc || proc.killed) return;
  intentionalChildren.add(proc);
  console.error(`[gateway] stopping Chrome MCP child reason=${reason}`);
  await new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(killTimer); resolve(); };
    const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 3000);
    proc.once('exit', finish);
    try { proc.kill('SIGTERM'); } catch (_) { finish(); }
  });
  if (chrome === proc) chrome = null;
}

async function parkBrowser() {
  if (!ready || !chrome || chrome.killed) return;
  const listed = await childRequest('tools/call', {name:'list_pages', arguments:{}}, 30000);
  const ids = pageIdsFromListResult(listed);
  if (!ids.length) throw new Error('idle park could not resolve any page ids');
  const keep = ids[0];
  await childRequest('tools/call', {name:'select_page', arguments:{pageId:keep, bringToFront:false}}, 30000);
  for (const id of ids.slice(1).sort((a,b) => b-a)) {
    try { await childRequest('tools/call', {name:'close_page', arguments:{pageId:id}}, 30000); }
    catch (err) { console.error(`[gateway] idle park close_page id=${id} failed: ${err.message}`); }
  }
  await childRequest('tools/call', {name:'navigate_page', arguments:{type:'url', url:'about:blank'}}, 30000);
  parked = true;
  console.error(`[gateway] idle park complete closed_pages=${Math.max(0, ids.length-1)}`);
}

async function recycleChrome() {
  ready = false;
  activityLeases.clear();
  await stopChromeChild('idle_recycle');
  childInitResult = null;
  await startChrome();
  recycledSinceActivity = true;
  lastExternalActivity = Date.now();
  console.error('[gateway] idle recycle complete');
}

function beginMaintenance(action, fn) {
  if (maintenancePromise) return maintenancePromise;
  maintenancePromise = (async () => {
    if (activeExternalCalls > 0) return;
    expireStaleLeases();
    if (activityLeases.size) return;
    console.error(`[gateway] idle maintenance action=${action} idle_ms=${Date.now()-lastExternalActivity}`);
    await fn();
  })().catch(err => console.error(`[gateway] idle maintenance action=${action} failed: ${err.stack || err.message}`))
    .finally(() => { maintenancePromise = null; });
  return maintenancePromise;
}

function maybeIdleMaintenance() {
  if (stopping || maintenancePromise || !ready || activeExternalCalls > 0) return;
  const now = Date.now();
  expireStaleLeases(now);
  if (activityLeases.size) return;
  const idleMs = now - lastExternalActivity;
  if (idleMs >= IDLE_RECYCLE_MS && !recycledSinceActivity) { beginMaintenance('recycle', recycleChrome); return; }
  if (idleMs >= IDLE_PARK_MS && !parked) beginMaintenance('park', parkBrowser);
}

function json(res, status, body, extraHeaders={}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type':'application/json',
    'content-length':String(data.length),
    'cache-control':'no-store',
    ...extraHeaders
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), {status:413})); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleRpc(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return {status:400, body:{jsonrpc:'2.0', id:msg?.id ?? null, error:{code:-32600,message:'Invalid Request'}}};
  }
  const id = Object.prototype.hasOwnProperty.call(msg,'id') ? msg.id : undefined;

  if (msg.method === 'initialize') {
    if (maintenancePromise) await maintenancePromise;
    if (!childInitResult) return {status:503, body:{jsonrpc:'2.0', id:id ?? null, error:{code:-32000,message:'Browser MCP not ready'}}};
    const result = {
      ...(childInitResult || {}),
      protocolVersion: childInitResult?.protocolVersion || CHILD_PROTOCOL_VERSION
    };
    return {status:200, body:{jsonrpc:'2.0', id:id ?? null, result}};
  }

  if (id === undefined) {
    if (msg.method !== 'notifications/initialized') childNotify(msg.method, msg.params || {});
    return {status:202, body:null};
  }

  if (maintenancePromise) await maintenancePromise;
  if (!ready || !chrome || chrome.killed) {
    return {status:503, body:{jsonrpc:'2.0', id, error:{code:-32000,message:'Browser MCP not ready'}}};
  }

  const isToolCall = msg.method === 'tools/call';
  const toolName = isToolCall ? msg.params?.name : null;
  const toolArgs = isToolCall ? (msg.params?.arguments || {}) : null;
  if (isToolCall) {
    activeExternalCalls += 1;
    lastExternalActivity = Date.now();
    parked = false;
    recycledSinceActivity = false;
  }
  try {
    const result = await childRequest(msg.method, msg.params || {});
    if (isToolCall && toolName) recordToolSuccess(toolName, toolArgs);
    return {status:200, body:{jsonrpc:'2.0', id, result}};
  } catch (err) {
    const rpc = err.rpcError || {code:-32603, message:err.message || 'Internal error'};
    return {status:200, body:{jsonrpc:'2.0', id, error:rpc}};
  } finally {
    if (isToolCall) {
      activeExternalCalls = Math.max(0, activeExternalCalls - 1);
      lastExternalActivity = Date.now();
    }
  }
}

const server = http.createServer(async (req, res) => {
  res.on('error', () => {});
  if (req.method === 'GET' && req.url === '/statusz') {
    json(res, 200, {
      ready,
      parked,
      recycled_since_activity: recycledSinceActivity,
      active_external_calls: activeExternalCalls,
      idle_ms: Date.now() - lastExternalActivity,
      activity_leases: [...activityLeases.keys()],
      maintenance_active: Boolean(maintenancePromise),
      child_pid: chrome?.pid || null
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    const ok = ready && chrome && !chrome.killed && proxy && !proxy.killed;
    res.writeHead(ok ? 200 : 503, {'content-type':'text/plain','cache-control':'no-store'});
    res.end(ok ? 'ok' : 'not ready');
    return;
  }
  if (req.url !== '/mcp') {
    res.writeHead(404, {'cache-control':'no-store'}); res.end(); return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, {'allow':'POST','cache-control':'no-store'}); res.end(); return;
  }
  if (!ready && !maintenancePromise) {
    json(res, 503, {jsonrpc:'2.0', id:null, error:{code:-32000,message:'Browser MCP not ready'}}); return;
  }
  try {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw || '{}');
    if (Array.isArray(parsed)) {
      const replies = [];
      let status = 200;
      for (const msg of parsed) {
        const r = await handleRpc(msg);
        status = Math.max(status, r.status);
        if (r.body) replies.push(r.body);
      }
      if (!replies.length) { res.writeHead(202, {'cache-control':'no-store'}); res.end(); }
      else json(res, status, replies);
      return;
    }
    const out = await handleRpc(parsed);
    if (out.body === null) { res.writeHead(out.status, {'cache-control':'no-store'}); res.end(); }
    else json(res, out.status, out.body);
  } catch (err) {
    const status = err.status || 400;
    json(res, status, {jsonrpc:'2.0', id:null, error:{code:-32700,message:status===413?'Request too large':'Parse error'}});
  }
});

for (const sig of ['SIGTERM','SIGINT']) process.on(sig, () => {
  if (stopping) return;
  stopping = true;
  ready = false;
  try { server.close(); } catch (_) {}
  try { if (chrome && !chrome.killed) chrome.kill('SIGTERM'); } catch (_) {}
  try { if (proxy && !proxy.killed) proxy.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => process.exit(0), 250);
});

startChrome().then(() => {
  setInterval(maybeIdleMaintenance, IDLE_CHECK_MS).unref();
  server.listen(PORT, HOST, () => console.error(`[gateway] listening on ${HOST}:${PORT} idle_park_ms=${IDLE_PARK_MS} idle_recycle_ms=${IDLE_RECYCLE_MS}`));
}).catch(err => exitHard(err.stack || err.message));