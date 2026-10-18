(function (root) {
  "use strict";
  function start({ document, location, fetch, setTimeout, clearTimeout }) {
    const id = new URLSearchParams(location.search).get("submission_id") || "";
    const el = (name) => document.getElementById(name);
    const status = el("status"), connect = el("connect"), portal = el("portal");
    let attempts = 0, timer, busy = false, latest = {};
    const validPhone = (value) => /^\+[1-9]\d{7,14}$/.test(value || "");
    const terminal = (data) => data.ready === true && data.portal_ready === true &&
      (data.needsCalendar === false || data.connected === true);

    function render(data) {
      if (validPhone(data.phone_number)) {
        el("phone-number").textContent = data.phone_number;
        el("phone-panel").hidden = false;
      }
      portal.classList.remove("show");
      portal.removeAttribute("href");
      el("portal-setup").hidden = true;
      el("portal-password").classList.remove("show");
      el("portal-password").removeAttribute("href");
      // Never show credentials or a guessed portal link.
      if (data.portal_ready === true &&
          data.portalUrl === "https://aiintegrating-portal.replit.app/login") {
        portal.href = data.portalUrl;
        portal.classList.add("show");
        el("portal-password").href = new URL("./forgot-password", data.portalUrl).href;
        el("portal-password").classList.add("show");
        el("portal-setup").hidden = false;
      }
      connect.classList.remove("show");
      connect.removeAttribute("href");
      if (data.ready && data.needsCalendar && !data.connected) {
        connect.href = "#connect-calendar";
        connect.classList.add("show");
      }
      const phone = validPhone(data.phone_number) ? "Your phone number is ready." :
        "Your phone number is still being prepared.";
      const calendar = data.connected ? "Calendar connected." :
        data.needsCalendar ? "Connect your calendar when ready." : "";
      const account = data.portal_ready ? "Your portal is ready." :
        data.portal_status === "unavailable" ? "Portal status is temporarily unavailable. We will check again." :
        "Portal account creation is still pending. We will check again.";
      status.textContent = [phone, calendar, account].filter(Boolean).join(" ");
    }
    function schedule() {
      if (attempts < 60) timer = setTimeout(() => check(), 5000);
      else {
        status.textContent += " Automatic checking paused. Use Check Again or contact support; do not resubmit your form.";
        el("retry").classList.add("show");
      }
    }
    async function check(createLink = false) {
      if (busy) return;
      clearTimeout(timer);
      if (!/^\d{10,25}$/.test(id)) {
        status.textContent = "This setup link is incomplete. Use your existing setup link; do not resubmit onboarding.";
        return;
      }
      busy = true;
      attempts++;
      el("retry").classList.remove("show");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let shouldPoll = true;
      try {
        // Same-origin: a development preview must never silently call production.
        const response = await fetch(new URL("./api/calendar-setup", location.href).href, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ submission_id: id, status_only: !createLink }),
          signal: controller.signal, cache: "no-store"
        });
        const data = await response.json();
        latest = { ...latest, portal_ready: false, portalUrl: undefined, ...data };
        render(latest);
        if (!response.ok || data.ok === false) {
          if ([400, 403, 409].includes(response.status)) shouldPoll = false;
          throw Error(data.error || "Setup status is temporarily unavailable.");
        }
        if (createLink && data.authorizationUrl) {
          const url = new URL(data.authorizationUrl);
          if (url.protocol !== "https:") throw Error("Invalid calendar connection link.");
          location.assign(url.href);
        }
        shouldPoll = !terminal(data);
      } catch (error) {
        status.textContent += " " + (error.name === "AbortError" ?
          "Status check timed out; your setup has not been restarted." : error.message);
        el("retry").classList.add("show");
      } finally {
        clearTimeout(timeout);
        busy = false;
        if (shouldPoll) schedule();
      }
    }
    el("retry").addEventListener("click", () => { attempts = 0; check(); });
    connect.addEventListener("click", (event) => { event.preventDefault(); check(true); });
    check();
    return { check };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { start };
  else start(root);
})(typeof window === "undefined" ? globalThis : window);
