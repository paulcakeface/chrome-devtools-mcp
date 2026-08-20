/*
 * Copyright 2026 Paulcake
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paulcake Edition lifecycle/hosting layer for Chrome DevTools MCP.
 */
'use strict';
const http = require('http');
const net = require('net');
const dns = require('dns').promises;

const noop = () => {};

function isBlockedIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a,b] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function isBlockedIP(address) {
  if (address.startsWith('::ffff:')) return isBlockedIPv4(address.slice(7));
  if (net.isIPv4(address)) return isBlockedIPv4(address);
  if (net.isIPv6(address)) {
    const x = address.toLowerCase();
    return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') ||
      /^fe[89ab]/.test(x);
  }
  return true;
}

function blockedHostname(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
    h.endsWith('.internal') || h === 'metadata.google.internal';
}

async function resolvePublic(host) {
  if (blockedHostname(host)) throw new Error('private hostname blocked');
  if (net.isIP(host)) {
    if (isBlockedIP(host)) throw new Error('private IP blocked');
    return host;
  }
  const answers = await dns.lookup(host, {all: true, verbatim: true});
  if (!answers.length) throw new Error('DNS returned no addresses');
  if (answers.some(a => isBlockedIP(a.address))) throw new Error('hostname resolves to blocked IP');
  return answers[0].address;
}

function safeEnd(socket, data) {
  if (!socket || socket.destroyed || !socket.writable) return;
  try { socket.end(data); } catch (_) {}
}

function deny(socketOrRes, message='Blocked by browser egress policy') {
  if (socketOrRes instanceof net.Socket) {
    safeEnd(socketOrRes, 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  } else {
    if (socketOrRes.destroyed || socketOrRes.writableEnded) return;
    try {
      socketOrRes.writeHead(403, {'content-type':'text/plain','connection':'close'});
      socketOrRes.end(message);
    } catch (_) {}
  }
}

const server = http.createServer(async (req, res) => {
  req.on('error', noop);
  res.on('error', noop);
  try {
    const u = new URL(req.url);
    if (u.protocol !== 'http:') return deny(res);
    const address = await resolvePublic(u.hostname);
    if (req.destroyed || res.destroyed || res.writableEnded) return;
    const headers = {...req.headers, host: u.host};
    const upstream = http.request({host: address, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers}, r => {
      r.on('error', noop);
      if (res.destroyed || res.writableEnded) {
        r.destroy();
        return;
      }
      try { res.writeHead(r.statusCode || 502, r.headers); } catch (_) { r.destroy(); return; }
      r.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.destroyed && !res.writableEnded) {
        try { if (!res.headersSent) res.writeHead(502); res.end(); } catch (_) {}
      }
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
    req.pipe(upstream);
  } catch (_) { deny(res); }
});

server.on('connect', async (req, client, head) => {
  client.on('error', noop);
  try {
    const idx = req.url.lastIndexOf(':');
    if (idx < 1) return deny(client);
    const host = req.url.slice(0, idx).replace(/^\[|\]$/g, '');
    const port = Number(req.url.slice(idx + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return deny(client);
    const address = await resolvePublic(host);
    if (client.destroyed || !client.writable) return;

    const upstream = net.connect(port, address);
    upstream.on('error', () => {
      if (!client.destroyed) client.destroy();
    });
    client.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
    upstream.on('close', () => { if (!client.destroyed) client.destroy(); });

    upstream.once('connect', () => {
      if (client.destroyed || !client.writable) {
        upstream.destroy();
        return;
      }
      try { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); }
      catch (_) { upstream.destroy(); client.destroy(); return; }
      if (head && head.length && !upstream.destroyed && upstream.writable) {
        try { upstream.write(head); } catch (_) { upstream.destroy(); client.destroy(); return; }
      }
      upstream.pipe(client);
      client.pipe(upstream);
    });
  } catch (_) { deny(client); }
});

server.on('clientError', (_, socket) => {
  socket.on('error', noop);
  socket.destroy();
});
server.on('error', err => {
  console.error('[egress-proxy] server error:', err.message);
  process.exit(1);
});
server.listen(8899, '127.0.0.1', () => console.error('[egress-proxy] listening on 127.0.0.1:8899'));
