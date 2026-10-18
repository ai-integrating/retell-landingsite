const { test } = require("node:test");
const assert = require("node:assert/strict");
const proxyaddr = require("proxy-addr");
const express = require("express");
const lock = require("../package-lock.json");

test("locked Express uses patched proxy trust and route parser dependencies", () => {
  assert.equal(lock.packages["node_modules/express"].version, "5.3.0");
  assert.equal(lock.packages["node_modules/proxy-addr"].version, "2.0.8");
  assert.equal(lock.packages["node_modules/path-to-regexp"].version, "8.4.2");
});

test("short IPv4-mapped IPv6 prefix cannot trust an arbitrary remote client", () => {
  const req = {
    socket: { remoteAddress: "203.0.113.50" },
    headers: { "x-forwarded-for": "10.0.0.1" },
  };
  for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
    assert.equal(proxyaddr(req, proxyaddr.compile(subnet)), "203.0.113.50");
  }
});

test("correctly specified trusted proxy retains forwarded-address behavior", () => {
  const req = {
    socket: { remoteAddress: "10.0.0.2" },
    headers: { "x-forwarded-for": "203.0.113.50" },
  };
  for (const subnet of ["10.0.0.0/8", "::ffff:10.0.0.0/104"]) {
    assert.equal(proxyaddr(req, proxyaddr.compile(subnet)), "203.0.113.50");
  }
});

test("existing standalone Express route and JSON middleware still register", () => {
  const app = express();
  app.use(express.json());
  app.post("/api/retell-create-call", (_req, res) => res.json({ mocked: true }));
  assert.ok(app.router);
});
