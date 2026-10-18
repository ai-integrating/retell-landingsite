const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../api/calendar-setup");
const { start } = require("../onboarding-status");
const id = "1234567890123";
const phone = "+12025550123";
test("completion page explains password creation without requiring a temporary password", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "../calendar-setup.html"), "utf8");
  assert.match(html, /id="portal-password" class="button">Create Your Password<\/a>/);
  assert.ok(html.includes("Enter the email address you used during signup. We’ll email you a secure link to create your password."));
  assert.ok(html.includes("Already Have a Password? Sign In"));
});
function fixture({ status = "completed", mapped = true, connected = true,
  portal = true, error = false, role = "scheduler" } = {}) {
  const calls = [], writes = [];
  const store = {
    async incr(key) { writes.push(key); return 1; },
    async expire(key) { writes.push(key); },
    async get(key) {
      if (key === `prov:${id}`) return { status, agent_id: "agent_fixture", role };
      if (key === "agent:agent_fixture:phone") return phone;
      if (key === "agent:agent_fixture:client") return mapped ? "fixture-client" : null;
      if (key === "cal:tokens:client:fixture-client") return connected ? { access_token: "mock" } : null;
      throw Error(`unexpected read: ${key}`);
    }
  };
  const handler = createHandler({ store, env: { PORTAL_READINESS_SECRET: "mock" },
    request: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      assert.match(url, /\/api\/internal\/portal-readiness$/);
      if (error) throw Error("mock network error");
      return { ok: true, json: async () => ({ portal_ready: portal,
        ...(portal ? { portal_login_url: "https://aiintegrating-portal.replit.app/login" } : {}) }) };
    }
  });
  return { calls, writes, async run(body = {}) {
    let statusCode, data;
    await handler({ method: "POST", headers: { host: "preview.invalid" },
      body: { submission_id: id, status_only: true, ...body } },
    { setHeader() {}, status(value) { statusCode = value; return this; }, json(value) { data = value; } });
    assert.ok(writes.every(key => key.startsWith("cal:setup:rate:")));
    return { status: statusCode, data };
  } };
}
test("available phone is returned before provisioning completes, with no external call", async () => {
  const f = fixture({ status: "agent_created" });
  const r = await f.run();
  assert.equal(r.status, 202); assert.equal(r.data.phone_number, phone);
  assert.equal(r.data.ready, false); assert.equal(f.calls.length, 0);
});
test("available phone survives a pending workspace mapping", async () => {
  const f = fixture({ mapped: false }); const r = await f.run();
  assert.equal(r.data.phone_number, phone); assert.equal(r.data.status, "finishing_workspace");
  assert.equal(f.calls.length, 0);
});
test("calendar connected is independent from portal pending; readiness uses trusted mapping only", async () => {
  const f = fixture({ portal: false }); const r = await f.run({ client_id: "attacker", agent_id: "attacker" });
  assert.equal(r.data.connected, true); assert.equal(r.data.portal_ready, false);
  assert.equal(r.data.portal_status, "pending");
  assert.deepEqual(f.calls[0].body, { client_id: "fixture-client" });
});
test("repeated status-only checks do not create OAuth states or provision anything", async () => {
  const f = fixture({ connected: false });
  for (let i = 0; i < 3; i++) {
    const r = await f.run(); assert.equal(r.status, 200); assert.equal(r.data.authorizationUrl, undefined);
  }
  assert.equal(f.calls.length, 3);
});
test("readiness failure preserves phone/calendar and reports unavailable, not false success", async () => {
  const r = await fixture({ error: true }).run();
  assert.equal(r.data.phone_number, phone); assert.equal(r.data.connected, true);
  assert.equal(r.data.portal_status, "unavailable"); assert.equal(r.data.portalUrl, undefined);
});
test("ready receptionist needs no calendar connection", async () => {
  const r = await fixture({ role: "receptionist", connected: false }).run();
  assert.equal(r.data.needsCalendar, false); assert.equal(r.data.portal_ready, true);
});

function browser(responses) {
  const elements = new Map(), timers = new Map(), calls = [];
  let count = 0;
  function el(name) {
    if (!elements.has(name)) {
      const classes = new Set();
      elements.set(name, { hidden: true, textContent: "", handlers: {},
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
        removeAttribute(key) { delete this[key]; },
        addEventListener(event, fn) { this.handlers[event] = fn; } });
    }
    return elements.get(name);
  }
  const app = start({
    document: { getElementById: el },
    location: { search: `?submission_id=${id}`, href: `https://preview.invalid/onboarding-preview/?submission_id=${id}`,
      assign() { throw Error("unexpected navigation"); } },
    setTimeout(fn, ms) { timers.set(++count, { fn, ms }); return count; },
    clearTimeout(key) { timers.delete(key); },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      const data = responses.shift() || { ok: true, ready: true, connected: true, portal_ready: false };
      return { ok: true, status: data.ready ? 200 : 202, json: async () => data };
    }
  });
  return { el, timers, calls, app, flush: () => new Promise(resolve => setImmediate(resolve)),
    async tick() {
      const entry = [...timers].find(([, value]) => value.ms === 5000);
      assert.ok(entry, "expected scheduled poll"); timers.delete(entry[0]); await entry[1].fn();
      await new Promise(resolve => setImmediate(resolve));
    } };
}
test("browser shows phone on 202 and continues after Cal connects until portal is ready", async () => {
  const b = browser([
    { ok: true, ready: false, phone_number: phone },
    { ok: true, ready: true, connected: true, needsCalendar: true, phone_number: phone, portal_ready: false },
    { ok: true, ready: true, connected: true, needsCalendar: true, portal_ready: true,
      portalUrl: "https://aiintegrating-portal.replit.app/login" }
  ]);
  await b.flush(); assert.equal(b.el("phone-panel").hidden, false);
  assert.equal(b.el("portal").classList.contains("show"), false);
  await b.tick(); assert.match(b.el("status").textContent, /Calendar connected.*still pending/);
  await b.tick(); assert.equal(b.el("portal").classList.contains("show"), true);
  assert.equal(b.timers.size, 0);
  assert.ok(b.calls.every(call => call.url.startsWith("https://preview.invalid/") && call.body.status_only));
});
test("polling is bounded; Check Again reads status without resubmission or duplicate provisioning", async () => {
  const b = browser([]); await b.flush();
  for (let i = 1; i < 60; i++) await b.tick();
  assert.equal(b.calls.length, 60); assert.equal(b.timers.size, 0);
  assert.match(b.el("status").textContent, /do not resubmit/);
  b.el("retry").handlers.click(); await b.flush();
  assert.equal(b.calls.length, 61); assert.ok(b.calls.every(call => call.body.status_only));
});
test("first-password guidance and existing sign-in appear only for a verified ready portal", async () => {
  const b = browser([
    { ok: true, ready: true, connected: true, portal_ready: false },
    { ok: true, ready: true, connected: true, portal_ready: true,
      portalUrl: "https://untrusted.invalid/login" },
    { ok: true, ready: true, connected: true, portal_ready: true,
      portalUrl: "https://aiintegrating-portal.replit.app/login" },
    { ok: true, ready: true, connected: true, portal_ready: false }
  ]);
  await b.flush();
  assert.equal(b.el("portal-setup").hidden, true);
  await b.app.check();
  assert.equal(b.el("portal-password").href, undefined);
  assert.equal(b.el("portal-setup").hidden, true);
  await b.app.check();
  assert.equal(b.el("portal-setup").hidden, false);
  assert.equal(b.el("portal-password").href, "https://aiintegrating-portal.replit.app/forgot-password");
  assert.equal(b.el("portal").href, "https://aiintegrating-portal.replit.app/login");
  await b.app.check();
  assert.equal(b.el("portal-setup").hidden, true);
  assert.equal(b.el("portal-password").href, undefined);
  assert.ok(b.calls.every(call => call.body.status_only));
});
