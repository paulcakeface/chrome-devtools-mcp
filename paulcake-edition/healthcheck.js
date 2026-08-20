/*
 * Copyright 2026 Paulcake
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paulcake Edition lifecycle/hosting layer for Chrome DevTools MCP.
 */
'use strict';
const net = require('net');
const timer = setTimeout(() => process.exit(1), 4000);
(async () => {
  const r = await fetch('http://127.0.0.1:8000/healthz');
  if (!r.ok) throw new Error('MCP health failed');
  await new Promise((resolve,reject) => {
    const s = net.connect({host:'127.0.0.1',port:8899});
    s.setTimeout(1500);
    s.on('connect', () => { s.destroy(); resolve(); });
    s.on('error', reject);
    s.on('timeout', () => { s.destroy(); reject(new Error('proxy timeout')); });
  });
  clearTimeout(timer);
  process.exit(0);
})().catch(() => process.exit(1));
