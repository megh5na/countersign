"use strict";
// Countersign merchant console. No build step, no dependencies.
// SECURITY: buyer messages, model drafts and rule text are untrusted. They are only ever added as text nodes through h();
// nothing here uses innerHTML, and admin.html's CSP only allows scripts from this origin.

const app = document.getElementById("app");
const tabsEl = document.getElementById("tabs");
const signoutBtn = document.getElementById("signout");
const badge = document.getElementById("badge");
const TOKEN_KEY = "cs_admin_token";

// ---------- helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const fmt = (minor) => (minor == null ? "—" : "$" + Math.trunc(minor / 100).toLocaleString("en-US") + "." + String(minor % 100).padStart(2, "0"));
const plainDollars = (minor) => Math.trunc(minor / 100) + "." + String(minor % 100).padStart(2, "0");
function parseDollars(text) {
  const m = /^\$?(\d+)(?:\.(\d{1,2}))?$/.exec(String(text).trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}
function relTime(iso, future) {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000) * (future ? 1 : -1);
  if (s < 0) return future ? "expired" : "just now";
  if (s < 60) return future ? "in under a minute" : "just now";
  const units = [["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [name, secs] of units) if (s >= secs) { const n = Math.floor(s / secs); return future ? `in ${n} ${name}${n > 1 ? "s" : ""}` : `${n} ${name}${n > 1 ? "s" : ""} ago`; }
  return "";
}

const ERRORS = {
  hash_mismatch: "This request changed since you opened it. Refresh and review it again.",
  exceeds_refundable: "That is more than what is left to refund on this order.",
  expired: "This approval request has expired.",
  not_pending: "This request was already decided.",
  amount_required: "Enter the amount to refund.",
  order_not_ready: "This order has no captured payment.",
  not_found: "Not found.",
  not_resolvable: "This case is no longer waiting for you.",
  not_declinable: "This case is no longer waiting for you.",
  no_agent_run: "This case never reached the agent, so it cannot be resolved here.",
  no_policy: "No policy is active.",
  invalid_body: "Check the values and try again.",
  admin_not_configured: "Admin access is not configured on this server.",
  invalid_prose: "Write between 20 and 8000 characters.",
  compile_failed: "The AI compiler could not be reached. Try again in a moment.",
  compile_invalid: "The compiled policy was not valid, so nothing was saved. Try rewording it.",
  compiler_not_configured: "The AI compiler is not configured on this server.",
  not_a_draft: "Only a draft version can be activated.",
  not_activatable: "The generated tests disagree with the rules, so this version cannot be activated. Reword the policy and compile again.",
  confirmation_required: "Confirmation is required.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  read_only: "This is read-only access. Only the merchant can do that.",
  reset_disabled: "Demo reset is switched off on this server.",
  payments_in_flight: "A refund is still being processed. Wait a moment and try again.",
};
const STATUS = {
  open: ["Received", ""], processing: ["Reviewing", ""], needs_approval: ["Needs approval", "warn"], resolved: ["Resolved", "ok"],
  denied: ["Denied", "bad"], NEEDS_HUMAN: ["Needs you", "warn"], error: ["Error", "bad"],
};
const chip = (text, kind) => h("span", { class: "chip " + (kind || "") }, text);
const statusChip = (s) => { const [t, k] = STATUS[s] || [s, ""]; return chip(t, k); };
const decisionChip = (d) => chip({ ALLOW: "Auto-approved", REQUIRE_APPROVAL: "Needs approval", DENY: "Refused" }[d] || d, { ALLOW: "ok", REQUIRE_APPROVAL: "warn", DENY: "bad" }[d]);
const REMEDY = { full_refund: "Full refund", partial_tier_a: "Partial refund (tier A)", partial_tier_b: "Partial refund (tier B)", replacement_offer: "Replacement offer", explain_no_refund: "Explain, no refund", escalate: "Escalate to merchant" };
const CLAIM = { damaged: "Damaged", not_received: "Not received", not_as_described: "Not as described", changed_mind: "Changed mind", other: "Other" };

// ---------- session and API ----------
const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } };
const setToken = (t) => { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: the session just will not persist */ } };
class AuthError extends Error {}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", authorization: "Bearer " + (getToken() || "") },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { signOut("That token was not accepted."); throw new AuthError(); }
  let body = null;
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }
  return { status: res.status, ok: res.ok, body };
}

// A message area that survives list reloads.
const flashEl = h("div", { role: "status", "aria-live": "polite" });
function flash(text, kind) {
  flashEl.replaceChildren(text ? h("div", { class: "banner " + (kind || "okmsg") }, text) : "");
}
const errText = (r) => ERRORS[r.body && r.body.error] || `Something went wrong (${r.status}).`;

// Two-step button: the first click arms it, the second confirms. Prevents accidental refunds.
function twoStep(label, cls, action) {
  let armed = null;
  const btn = h("button", { class: "btn " + cls, type: "button" }, label);
  btn.addEventListener("click", async () => {
    if (!armed) {
      btn.textContent = "Confirm: " + label;
      btn.classList.add("confirm");
      armed = setTimeout(() => { armed = null; btn.textContent = label; btn.classList.remove("confirm"); }, 5000);
      return;
    }
    clearTimeout(armed); armed = null;
    btn.disabled = true;
    try { await action(); } finally { btn.disabled = false; btn.textContent = label; btn.classList.remove("confirm"); }
  });
  return btn;
}

// ---------- login ----------
function signOut(message) {
  setToken(null);
  role = "admin"; resetEnabled = false; // the next sign-in asks the server who it is
  clearInterval(timer);
  tabsEl.hidden = true; signoutBtn.hidden = true; badge.hidden = true;
  renderLogin(message);
}
signoutBtn.addEventListener("click", () => signOut());

function renderLogin(message) {
  const input = h("input", { type: "password", placeholder: "Access token", autocomplete: "off", "aria-label": "Access token", style: "width:100%" });
  const note = h("div", { class: "banner err", hidden: !message }, message || "");
  const go = async () => {
    setToken(input.value.trim());
    try {
      const r = await api("/api/admin/approvals?status=pending");
      if (r.ok) return start();
      setToken(null);
      note.hidden = false; note.textContent = errText(r);
    } catch (e) { if (!(e instanceof AuthError)) { note.hidden = false; note.textContent = "Could not reach the server."; } }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  app.replaceChildren(h("div", { class: "card login" },
    h("h2", null, "Merchant sign-in"),
    h("p", { class: "muted" }, "Paste the admin token, or the read-only judge token from the README. It is kept only for this browser session."),
    note, input, h("div", { style: "margin-top:12px" }, h("button", { class: "btn primary", type: "button", onclick: go }, "Sign in"))));
  input.focus();
}

// ---------- shell and tabs ----------
let currentTab = "approvals";
let timer = null;
let role = "admin"; // "judge" is read-only: the server refuses every write, and the console hides the buttons
let resetEnabled = false;
async function start() {
  tabsEl.hidden = false; signoutBtn.hidden = false;
  try {
    const w = await api("/api/admin/whoami");
    if (w.ok) { role = w.body.role === "judge" ? "judge" : "admin"; resetEnabled = Boolean(w.body.resetEnabled); }
  } catch (e) { if (e instanceof AuthError) return; }
  show(currentTab);
  clearInterval(timer);
  timer = setInterval(() => { if (document.visibilityState === "visible" && getToken()) updateBadge(); }, 15000);
}
tabsEl.addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) show(b.dataset.tab); });

function show(tab) {
  currentTab = tab;
  for (const b of tabsEl.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  flash("");
  app.replaceChildren(
    role === "judge" ? h("div", { class: "banner okmsg" }, "Read-only access. You can look at everything, but only the merchant can approve, refund, resolve cases or change the policy.") : null,
    flashEl, h("div", { id: "view" }, h("p", { class: "muted" }, "Loading…")));
  const view = document.getElementById("view");
  const run = { approvals: approvalsView, cases: casesView, policy: policyView }[tab];
  run(view).catch((e) => { if (!(e instanceof AuthError)) view.replaceChildren(h("div", { class: "banner err" }, "Could not load this view. Is the server reachable?")); });
  updateBadge();
}

async function updateBadge() {
  try {
    const r = await api("/api/admin/approvals?status=pending");
    const n = r.ok ? r.body.approvals.length : 0;
    badge.hidden = n === 0; badge.textContent = String(n);
  } catch { /* ignore: the badge is a convenience */ }
}

// ---------- approvals ----------
async function approvalsView(view) {
  let status = "pending";
  const list = h("div");
  const select = h("select", { "aria-label": "Filter by status" }, ["pending", "approved", "used", "rejected", "expired"].map((s) => h("option", { value: s }, s[0].toUpperCase() + s.slice(1))));
  select.addEventListener("change", () => { status = select.value; load(); });
  const refresh = h("button", { class: "btn", type: "button", onclick: () => load() }, "Refresh");
  view.replaceChildren(h("div", { class: "row", style: "margin-bottom:12px" }, h("h2", { style: "margin:0" }, "Approvals"), h("div", { class: "spacer" }), select, refresh), list);

  async function load() {
    const r = await api("/api/admin/approvals?status=" + encodeURIComponent(status));
    if (!r.ok) return list.replaceChildren(h("div", { class: "banner err" }, errText(r)));
    const items = r.body.approvals;
    updateBadge();
    if (items.length === 0) return list.replaceChildren(h("div", { class: "empty" }, status === "pending" ? "Nothing is waiting for your approval." : "No " + status + " approvals."));
    list.replaceChildren(...items.map((a) => approvalCard(a, load)));
  }
  await load();
}

function approvalCard(a, reload) {
  const pending = a.status === "pending";
  const amount = h("input", { class: "money", type: "text", inputmode: "decimal", "aria-label": "Refund amount in dollars", placeholder: "0.00", value: a.suggestedAmountMinor != null ? plainDollars(a.suggestedAmountMinor) : "" });
  const reasons = Array.isArray(a.reasons) ? a.reasons : [];
  const approve = twoStep("Approve and refund", "primary", async () => {
    const typed = parseDollars(amount.value);
    if (typed == null) return flash("Enter a valid amount, like 19.00.", "err");
    const body = { paramsHash: a.paramsHash };
    if (typed !== a.suggestedAmountMinor) body.amountMinor = typed;
    const r = await api("/api/admin/approvals/" + encodeURIComponent(a.id) + "/approve", { method: "POST", body });
    if (r.ok) flash(`Refunded ${fmt(r.body.amountMinor)}. Case ${(STATUS[r.body.caseStatus] || [r.body.caseStatus])[0].toLowerCase()}: ${r.body.detail}`, "okmsg");
    else flash(errText(r), "err");
    await reload();
  });
  const reject = twoStep("Reject", "danger", async () => {
    const r = await api("/api/admin/approvals/" + encodeURIComponent(a.id) + "/reject", { method: "POST", body: { paramsHash: a.paramsHash } });
    flash(r.ok ? "Rejected. The case was closed as denied." : errText(r), r.ok ? "okmsg" : "err");
    await reload();
  });
  return h("div", { class: "card" },
    h("div", { class: "row" },
      h("strong", null, "Order " + a.paypalOrderId), chip(a.status, pending ? "warn" : a.status === "used" ? "ok" : ""),
      h("span", { class: "muted" }, `${CLAIM[a.claimType] || a.claimType || "Claim"} · ${REMEDY[a.remedy] || a.remedy} · order total ${fmt(a.orderTotalMinor)}`),
      h("div", { class: "spacer" }), h("span", { class: "muted" }, pending ? "Expires " + relTime(a.expiresAt, true) : "Created " + relTime(a.createdAt))),
    h("h3", null, "Why it needs you"),
    reasons.length ? h("ul", { class: "plain" }, reasons.map((r) => h("li", null, String(r)))) : h("span", { class: "muted" }, "No rule covered this proposal."),
    h("h3", null, "The buyer wrote"), h("blockquote", null, a.buyerMessage),
    h("h3", null, "Suggested reply (not sent automatically)"), h("blockquote", { class: "draft" }, a.agentDraft),
    pending && role === "admin"
      ? h("div", { class: "row", style: "margin-top:12px" },
          h("label", null, h("span", { class: "muted" }, "Refund amount  "), h("span", null, "$"), amount),
          a.suggestedAmountMinor == null ? h("span", { class: "muted" }, "No suggestion: enter an amount") : h("span", { class: "muted" }, "Suggested " + fmt(a.suggestedAmountMinor)),
          h("div", { class: "spacer" }), reject, approve)
      : h("div", { class: "row", style: "margin-top:8px" }, h("span", { class: "amount" }, fmt(a.suggestedAmountMinor))));
}

// Only shown to the admin, and only when the server has ALLOW_DEMO_RESET=true. The button stays disabled until the exact phrase is typed.
function demoTools(reload) {
  if (role !== "admin" || !resetEnabled) return "";
  const PHRASE = "reset demo data";
  const input = h("input", { type: "text", placeholder: PHRASE, autocomplete: "off", "aria-label": "Type the phrase to confirm the reset", style: "width:220px" });
  const btn = h("button", { class: "btn danger", type: "button", disabled: true }, "Reset demo data");
  input.addEventListener("input", () => { btn.disabled = input.value !== PHRASE; });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const r = await api("/api/admin/reset", { method: "POST", body: { confirm: input.value } });
    if (r.ok) {
      const d = r.body.deleted || {};
      flash(`Demo data cleared (${d.cases ?? 0} cases, ${d.orders ?? 0} orders, ${d.refundLedger ?? 0} refunds). Policies were kept.`, "okmsg");
      input.value = "";
      await reload();
    } else { flash(errText(r), "err"); btn.disabled = input.value !== PHRASE; }
  });
  return h("div", { class: "card", style: "margin-top:24px" }, h("h3", { style: "margin-top:0" }, "Demo tools"),
    h("p", { class: "muted" }, "Clears every case, approval, refund, order and webhook event so the demo can start fresh. Policies are kept. This cannot be undone. Type \"" + PHRASE + "\" to enable the button."),
    h("div", { class: "row" }, input, btn));
}

// ---------- cases ----------
async function casesView(view) {
  let status = "";
  const body = h("div");
  const select = h("select", { "aria-label": "Filter by status" }, [["", "All cases"], ["NEEDS_HUMAN", "Needs you"], ["needs_approval", "Needs approval"], ["resolved", "Resolved"], ["denied", "Denied"], ["processing", "Reviewing"], ["error", "Error"]].map(([v, t]) => h("option", { value: v }, t)));
  select.addEventListener("change", () => { status = select.value; load(); });
  view.replaceChildren(h("div", { class: "row", style: "margin-bottom:12px" }, h("h2", { style: "margin:0" }, "Cases"), h("div", { class: "spacer" }), select, h("button", { class: "btn", type: "button", onclick: () => load() }, "Refresh")), body, demoTools(() => load()));

  async function load() {
    const r = await api("/api/admin/cases" + (status ? "?status=" + encodeURIComponent(status) : ""));
    if (!r.ok) return body.replaceChildren(h("div", { class: "banner err" }, errText(r)));
    const rows = r.body.cases;
    if (rows.length === 0) return body.replaceChildren(h("div", { class: "empty" }, "No cases yet. Buyers file them from the store page."));
    const tbody = h("tbody");
    for (const c of rows) {
      const tr = h("tr", { class: "click", tabindex: "0", "aria-expanded": "false" },
        h("td", null, relTime(c.createdAt)), h("td", null, c.paypalOrderId || "—"), h("td", null, statusChip(c.status)),
        h("td", { class: "hide-sm" }, c.decision ? [decisionChip(c.decision.decision), c.decision.amountMinor != null ? " " + fmt(c.decision.amountMinor) : ""] : "—"),
        h("td", null, c.outcomeReason || c.buyerMessage));
      let open = null;
      const toggle = async () => {
        if (open) { open.remove(); open = null; tr.setAttribute("aria-expanded", "false"); return; }
        const cell = h("td", { colspan: "5" }, h("span", { class: "muted" }, "Loading…"));
        open = h("tr", null, cell); tr.after(open); tr.setAttribute("aria-expanded", "true");
        try { const t = await api("/api/admin/cases/" + encodeURIComponent(c.id)); cell.replaceChildren(t.ok ? timeline(t.body, load) : h("div", { class: "banner err" }, errText(t))); }
        catch (e) { if (!(e instanceof AuthError)) cell.replaceChildren(h("div", { class: "banner err" }, "Could not load the timeline.")); }
      };
      tr.addEventListener("click", toggle);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      tbody.append(tr);
    }
    body.replaceChildren(h("div", { class: "card", style: "padding:4px 8px" }, h("table", null, h("thead", null, h("tr", null, ["When", "Order", "Status", h("span", { class: "hide-sm" }, "Decision"), "What happened"].map((x) => h("th", null, x)))), tbody)));
  }
  await load();
}

function timeline(t, reload) {
  const c = t.case;
  const sections = [h("h3", null, "The buyer wrote"), h("blockquote", null, c.buyerMessage),
    h("div", { class: "row" }, statusChip(c.status), h("span", null, c.outcomeReason || ""))];

  if (t.runs.length) {
    sections.push(h("h3", null, "What the agent looked at"));
    for (const r of t.runs) sections.push(h("div", { class: "muted" }, `${r.model} · ${r.tokensIn} tokens in, ${r.tokensOut} out · ${r.outcome}`));
    const calls = t.toolCalls.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (const tc of calls) {
      sections.push(h("details", null, h("summary", null, chip(tc.name), " ", tc.id.split(":").pop()), h("pre", null, JSON.stringify(tc.resultJson, null, 2))));
    }
  }
  for (const p of t.proposals) {
    sections.push(h("h3", null, "What the agent proposed"));
    sections.push(h("div", { class: "row" }, chip(REMEDY[p.remedy] || p.remedy), h("span", { class: "muted" }, CLAIM[p.claimType] || p.claimType || "")));
    sections.push(h("blockquote", { class: "draft" }, p.messageDraft));
  }
  for (const d of t.decisions) {
    const ctx = (d.contextJson && d.contextJson.context) || {};
    const reasons = (d.contextJson && d.contextJson.reasons) || [];
    sections.push(h("h3", null, "What the rule engine decided"));
    sections.push(h("div", { class: "row" }, decisionChip(d.decision), d.amountMinor != null ? h("span", { class: "amount" }, fmt(d.amountMinor)) : "",
      h("span", { class: "muted" }, "rules: " + (Array.isArray(d.ruleIds) ? d.ruleIds.join(", ") : ""))));
    if (reasons.length) sections.push(h("ul", { class: "plain" }, reasons.map((x) => h("li", null, String(x)))));
    sections.push(h("div", { class: "muted" }, `Facts used: refundable ${fmt(ctx.refundableMinor)} · refunds today ${fmt(ctx.refundsTodayMinor)} · buyer's refunds (90 days) ${ctx.buyerRefunds90dCount ?? "?"} · delivered ${ctx.daysSinceDelivery == null ? "unknown" : ctx.daysSinceDelivery + " days ago"}`));
  }
  for (const e of t.executions) {
    sections.push(h("h3", null, "Refund"));
    sections.push(h("div", { class: "row" }, chip(e.status, e.status === "SUCCEEDED" ? "ok" : e.status === "FAILED" ? "bad" : "warn"), h("span", { class: "muted" }, `attempts ${e.attempts} · key ${e.idempotencyKey}`),
      e.responseJson && e.responseJson.id ? h("span", null, "PayPal refund " + e.responseJson.id) : ""));
  }
  if (c.status === "NEEDS_HUMAN") sections.push(resolveForm(c, reload));
  return h("div", { style: "padding:4px 8px 16px" }, sections);
}

// Escalated cases: propose a refund (becomes a normal approval that must be confirmed) or decline.
function resolveForm(c, reload) {
  if (role !== "admin") return h("div", { class: "muted", style: "margin-top:16px" }, "This case is waiting for the merchant. Read-only access cannot resolve it.");
  const remedy = h("select", { "aria-label": "Refund type" }, ["partial_tier_a", "partial_tier_b", "full_refund"].map((r) => h("option", { value: r }, REMEDY[r])));
  const amount = h("input", { class: "money", type: "text", inputmode: "decimal", placeholder: "0.00", "aria-label": "Refund amount in dollars" });
  const out = h("div");
  const propose = h("button", { class: "btn primary", type: "button" }, "Propose refund");
  propose.addEventListener("click", async () => {
    const cents = parseDollars(amount.value);
    if (cents == null) return out.replaceChildren(h("div", { class: "banner err" }, "Enter a valid amount, like 19.00."));
    propose.disabled = true;
    const r = await api("/api/admin/cases/" + encodeURIComponent(c.id) + "/resolve", { method: "POST", body: { action: "refund", remedy: remedy.value, amountMinor: cents } });
    propose.disabled = false;
    if (!r.ok) return out.replaceChildren(h("div", { class: "banner err" }, errText(r)));
    const { approvalId, paramsHash, amountMinor } = r.body;
    const confirm = twoStep("Send " + fmt(amountMinor) + " now", "primary", async () => {
      const a = await api("/api/admin/approvals/" + encodeURIComponent(approvalId) + "/approve", { method: "POST", body: { paramsHash } });
      flash(a.ok ? `Refunded ${fmt(a.body.amountMinor)}. ${a.body.detail}` : errText(a), a.ok ? "okmsg" : "err");
      await reload();
    });
    out.replaceChildren(h("div", { class: "banner okmsg" }, "Refund of " + fmt(amountMinor) + " proposed. Send it now, or leave it in the Approvals tab."), confirm);
  });
  const decline = twoStep("Decline case", "danger", async () => {
    const r = await api("/api/admin/cases/" + encodeURIComponent(c.id) + "/resolve", { method: "POST", body: { action: "decline" } });
    flash(r.ok ? "Case declined." : errText(r), r.ok ? "okmsg" : "err");
    await reload();
  });
  return h("div", { class: "card", style: "margin-top:16px" }, h("h3", { style: "margin-top:0" }, "This case needs you"),
    h("p", { class: "muted" }, "The agent chose not to decide. Refunds you propose still go through the same checks and cannot override a refusal rule."),
    h("div", { class: "row" }, remedy, h("span", null, "$"), amount, propose, h("div", { class: "spacer" }), decline), out);
}

// ---------- policy (read-only) ----------
const EFFECT = { allow: ["Auto-approve", "ok"], require_approval: ["Ask me", "warn"], deny: ["Refuse", "bad"] };
function conditions(w) {
  const out = [];
  if (w.claim_type_in) out.push("claim is " + w.claim_type_in.map((x) => CLAIM[x] || x).join(" or "));
  if (w.days_since_delivery_lte != null) out.push(`delivered at most ${w.days_since_delivery_lte} days ago`);
  if (w.days_since_delivery_gte != null) out.push(`delivered at least ${w.days_since_delivery_gte} days ago`);
  if (w.order_total_minor_lte != null) out.push(`order is ${fmt(w.order_total_minor_lte)} or less`);
  if (w.order_total_minor_gte != null) out.push(`order is ${fmt(w.order_total_minor_gte)} or more`);
  if (w.buyer_refunds_90d_lte != null) out.push(`buyer has at most ${w.buyer_refunds_90d_lte} refunds in 90 days`);
  return out.length ? out.join(", and ") : "always";
}

function ruleCards(rules) {
  if (rules.length === 0) return [h("div", { class: "muted" }, "No rules: every proposal needs your approval.")];
  return rules.map((r) => {
    const [t, k] = EFFECT[r.effect] || [r.effect, ""];
    return h("div", { class: "rule" }, h("div", null, h("strong", null, r.id)),
      h("div", null, h("div", { class: "row" }, chip(t, k), h("strong", null, REMEDY[r.remedy] || r.remedy)),
        h("div", { class: "muted" }, "When " + conditions(r.when || {})),
        r.amount ? h("div", null, r.amount.percent_of_capture != null ? `Refund ${r.amount.percent_of_capture}% of the payment` : `Refund ${fmt(r.amount.fixed_minor)}`) : ""));
  });
}

function limitsBlock(limits) {
  return h("div", null,
    limits.daily_auto_refund_cap_minor != null ? h("div", null, "Auto-approved refunds per day: up to " + fmt(limits.daily_auto_refund_cap_minor)) : h("div", { class: "muted" }, "No daily cap"),
    limits.buyer_90d_cap_minor != null ? h("div", null, "Auto-approved refunds per buyer, 90 days: up to " + fmt(limits.buyer_90d_cap_minor)) : h("div", { class: "muted" }, "No per-buyer cap"),
    h("p", { class: "muted" }, "Anything not covered by a rule, or over a limit, waits for your approval. Nothing is ever refunded by guesswork."));
}

// One shape for both a fresh compile response and a stored draft row.
function reviewModel(src) {
  const report = src.report || {}, spec = src.policy || src.rulesJson || {};
  return {
    id: src.id, version: src.version, status: src.status, rulesHash: src.rulesHash, sourceText: src.sourceText || "",
    rules: spec.rules || [], limits: spec.limits || {}, cases: report.cases || [], warnings: report.warnings || [],
    ambiguities: report.ambiguities || [], unsupported: report.unsupported || [], activatable: report.activatable === true,
  };
}

const bullets = (items) => h("ul", { class: "plain" }, items.map((x) => h("li", null, String(x))));
const outcome = (o) => [decisionChip(o.decision), o.amountMinor != null ? " " + fmt(o.amountMinor) : ""];

// Review a draft: how it was understood, what the assistant was unsure about, and the generated tests run through the real engine.
function reviewPanel(v, onActivated) {
  const needsAck = v.unsupported.length > 0 || v.ambiguities.length > 0;
  const ack = h("input", { type: "checkbox", "aria-label": "I have read the notes above" });
  const activate = twoStep("Activate version " + v.version, "primary", async () => {
    if (needsAck && !ack.checked) return flash("Tick the box to confirm you have read the notes above.", "err");
    const r = await api("/api/policies/" + encodeURIComponent(v.id) + "/activate", { method: "POST", body: { confirm: true, rulesHash: v.rulesHash } });
    if (r.ok) { flash(`Version ${v.version} is now the active policy. New claims use it immediately.`, "okmsg"); await onActivated(); }
    else flash(errText(r), "err");
  });
  const passed = v.cases.filter((c) => c.pass).length;
  const canActivate = v.status === "draft" && v.activatable && role === "admin";
  const testRows = v.cases.map((c) => h("tr", null,
    h("td", null, c.name), h("td", null, outcome(c.expected)),
    h("td", null, outcome(c.actual), h("div", { class: "muted" }, Array.isArray(c.actual.ruleIds) ? c.actual.ruleIds.join(", ") : "")),
    h("td", null, chip(c.pass ? "agree" : "DISAGREE", c.pass ? "ok" : "bad"))));
  return h("div", { class: "card", style: "margin-top:12px" },
    h("div", { class: "row" }, h("h2", { style: "margin:0" }, "Review · version " + v.version), chip(v.status, v.status === "active" ? "ok" : ""),
      v.cases.length ? chip(passed === v.cases.length ? `All ${v.cases.length} tests agree` : `${v.cases.length - passed} of ${v.cases.length} tests disagree`, passed === v.cases.length ? "ok" : "bad") : chip("no tests on record", "warn"),
      h("span", { class: "muted" }, "fingerprint " + String(v.rulesHash).slice(0, 12))),
    v.sourceText ? [h("h3", null, "What you wrote"), h("blockquote", null, v.sourceText)] : "",
    v.unsupported.length ? [h("h3", null, "Not enforced: the rule language cannot express these"), bullets(v.unsupported)] : "",
    v.ambiguities.length ? [h("h3", null, "Where the assistant had to guess"), bullets(v.ambiguities)] : "",
    v.warnings.length ? [h("h3", null, "Warnings"), bullets(v.warnings)] : "",
    h("h3", null, "How it was understood"), ...ruleCards(v.rules), limitsBlock(v.limits),
    h("h3", null, "Tests the assistant wrote from your text, run through the real rule engine"),
    v.cases.length ? h("table", null, h("thead", null, h("tr", null, ["Scenario", "You expect", "The engine says", ""].map((x) => h("th", null, x)))), h("tbody", null, testRows)) : h("div", { class: "muted" }, "No generated tests are stored for this version."),
    canActivate
      ? h("div", { class: "row", style: "margin-top:16px" }, needsAck ? h("label", { class: "row" }, ack, h("span", null, "I have read the notes above")) : "", h("div", { class: "spacer" }), activate)
      : h("p", { class: "muted", style: "margin-top:16px" }, role !== "admin" ? "Read-only access: only the merchant can activate a policy." : v.status !== "draft" ? "Only a draft version can be activated." : "This version cannot be activated: its tests disagree with its rules, or none were generated. Reword the policy and compile again."));
}

// Paste a policy in plain English; Claude drafts rules and tests; nothing changes until a human activates the reviewed draft.
function composePanel(onActivated) {
  const ta = h("textarea", { rows: "7", maxlength: "8000", style: "width:100%", "aria-label": "Refund policy in plain English",
    placeholder: "Describe your refund policy in plain English, for example: We refund 50% of damaged items reported within 30 days of delivery. Orders above $75 always need my approval. Nothing is refunded after 90 days." });
  const out = h("div");
  const go = h("button", { class: "btn primary", type: "button" }, "Compile and review");
  go.addEventListener("click", async () => {
    const prose = ta.value.trim();
    if (prose.length < 20) return out.replaceChildren(h("div", { class: "banner err" }, ERRORS.invalid_prose));
    go.disabled = true;
    out.replaceChildren(h("p", { class: "muted", role: "status" }, "Compiling with Claude, then testing the result against the rule engine. This takes up to a minute…"));
    try {
      const r = await api("/api/policies/compile", { method: "POST", body: { prose } });
      if (r.status === 201) out.replaceChildren(reviewPanel(reviewModel({ ...r.body, sourceText: prose }), onActivated));
      else if (r.status === 422) out.replaceChildren(h("div", { class: "banner err" }, ERRORS.compile_invalid, Array.isArray(r.body && r.body.schemaErrors) ? bullets(r.body.schemaErrors) : ""));
      else out.replaceChildren(h("div", { class: "banner err" }, errText(r)));
    } catch (e) { if (!(e instanceof AuthError)) out.replaceChildren(h("div", { class: "banner err" }, "Could not reach the server.")); }
    finally { go.disabled = false; }
  });
  return h("details", { class: "card" },
    h("summary", null, h("strong", null, "Write a new policy version")),
    h("p", { class: "muted" }, "Nothing changes until you review the result and activate it."), ta, h("div", { style: "margin-top:12px" }, go), out);
}

async function policyView(view) {
  const reload = () => policyView(view);
  const [active, all] = await Promise.all([api("/api/policies/active"), api("/api/policies")]);
  const parts = role === "admin" ? [composePanel(reload)] : [];
  const slot = h("div"); // where a reviewed older version appears

  if (active.status === 404) parts.push(h("div", { class: "empty" }, "No policy is active yet. Write one above, review it, and activate it."));
  else if (!active.ok) parts.push(h("div", { class: "banner err" }, errText(active)));
  else {
    const p = active.body, spec = p.rulesJson || {};
    parts.push(
      h("div", { class: "card" },
        h("div", { class: "row" }, h("h2", { style: "margin:0" }, "Active policy · version " + p.version), chip("active", "ok"), h("span", { class: "muted" }, "fingerprint " + String(p.rulesHash).slice(0, 12))),
        h("h3", null, "What you wrote"), h("blockquote", null, p.sourceText)),
      h("div", { class: "card" }, h("h2", null, "How it was understood"), ...ruleCards(spec.rules || [])),
      h("div", { class: "card" }, h("h2", null, "Limits"), limitsBlock(spec.limits || {})));
  }

  if (all.ok && all.body.policies.length > 0) {
    const review = async (id) => {
      const r = await api("/api/policies/" + encodeURIComponent(id));
      slot.replaceChildren(r.ok ? reviewPanel(reviewModel(r.body), reload) : h("div", { class: "banner err" }, errText(r)));
      slot.scrollIntoView({ block: "nearest" });
    };
    parts.push(h("div", { class: "card" }, h("h2", null, "Versions"),
      ...all.body.policies.map((v) => h("div", { class: "row", style: "padding:4px 0" },
        h("strong", null, "v" + v.version), chip(v.status, v.status === "active" ? "ok" : ""), h("span", { class: "muted" }, relTime(v.createdAt)),
        h("div", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => review(v.id) }, v.status === "draft" && role === "admin" ? "Review and activate" : "View"))), slot));
  }
  view.replaceChildren(...parts);
}

// ---------- boot ----------
if (getToken()) start(); else renderLogin();
