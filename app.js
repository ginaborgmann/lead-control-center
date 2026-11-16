"use strict";

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const date = value => value ? new Intl.DateTimeFormat("de-DE", {
  dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin"
}).format(new Date(value)) : "—";
const btn = (text, attrs = "") => '<button class="btn" ' + attrs + '>' + text + '</button>';
const input = (label, name, value = "", attrs = "") =>
  '<label>' + label + '<input name="' + name + '" value="' + esc(value) + '" ' + attrs + '></label>';
const options = (rows, selected) => rows.map(([value, label]) =>
  '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(label) + '</option>').join("");
const select = (label, name, rows, selected) =>
  '<label>' + label + '<select name="' + name + '">' + options(rows, selected) + '</select></label>';
const titles = { dashboard: "Dashboard", leads: "Leads & Zuweisung", partners: "Verkäufer", orders: "Bestellungen", settings: "Einstellungen" };
const statuses = { new: "Neu", assigned: "Zugewiesen", in_progress: "In Bearbeitung", completed: "Abgeschlossen" };
const orderStatuses = { draft: "Entwurf", open: "Offen", in_progress: "In Bearbeitung", completed: "Abgeschlossen", cancelled: "Storniert" };
const zipAttr = 'inputmode="numeric" pattern="[0-9]{5}" maxlength="5"';
let client, view = "dashboard", data, refreshVersion = 0, recovery = false;
const filter = { leads: "", partners: "", orders: "", status: "", orderSort: "az", orderSupplier: "", partnerPostalView: "with" };
async function reonicRequests(body) {
  const result = await client.functions.invoke("reonic-requests",{body});
  if (result.error) {
    const details = await result.error.context?.json?.().catch(() => null);
    throw Error(details?.error || result.error.message);
  }
  return result.data;
}
let importing = false;
let refreshingReonic = false;
async function refreshReonic() {
  if (refreshingReonic) return;
  refreshingReonic = true;
  $("reload").disabled = true;
  message("Reonic wird aktualisiert …");
  const errors = [];
  let users, requests;
  try {
    try { users = await sync(); }
    catch (error) { errors.push("Benutzer: " + error.message); }
    try { requests = await reonicRequests({action:"sync"}); }
    catch (error) { errors.push("Teams und Anfragen: " + error.message); }
    await refresh();
    const counts = [users && users.count + " Benutzer",requests && requests.teams + " Teams",
      requests && requests.suppliers + " Leadquellen",requests && requests.count + " offene Anfragen"].filter(Boolean);
    message([...counts, ...errors].join(" · "));
  } finally {
    refreshingReonic = false;
    $("reload").disabled = false;
  }
}
async function importRequests(showCount = false) {
  if (importing || refreshingReonic) return;
  importing = true;
  try {
    const result = await reonicRequests({action:"sync"});
    if (showCount) message(result.count + " Reonic-Anfragen · " + result.teams + " Teams abgerufen.");
    await refresh();
  } catch (error) { message("Reonic-Abruf: " + error.message); }
  finally { importing = false; }
}
let syncError = "";

function message(text) { $("message").textContent = text; }
function fail(error) { if (error) throw error; }
function formData(form) { return Object.fromEntries(new FormData(form)); }
const optional = value => value?.trim() || null;

async function all(table, key = "id") {
  const list = [];
  for (let offset = 0; ; offset += 500) {
    const result = await client.from(table).select("*").order(key).range(offset, offset + 499);
    fail(result.error);
    list.push(...result.data);
    if (result.data.length < 500) return list;
  }
}

async function refresh() {
  const version = ++refreshVersion;
  try {
    const [leads, partners, orders, suppliers, assignments, sync, activity, teams] = await Promise.all([
      all("leads"), all("sales_partners"), all("lead_orders"), all("lead_suppliers"),
      all("lead_assignments", "lead_id"), all("reonic_sync_state", "singleton"), all("activity_log"), all("reonic_teams")
    ]);
    if (version !== refreshVersion) return;
    data = { leads, partners, orders, suppliers, assignments, sync: sync[0], activity, teams };
    $("connection").textContent = "Supabase verbunden";
    render();
  } catch (error) {
    if (version !== refreshVersion) return;
    $("connection").textContent = "Supabase-Abruf fehlgeschlagen";
    message("Daten konnten nicht geladen werden. " + error.message);
  }
}

function render() {
  $("title").textContent = titles[view];
  document.querySelectorAll("[data-view]").forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (!data) return;
  const views = { dashboard, leads, partners, orders, settings };
  $("workspace").innerHTML = views[view]();
  renderRecords();
  if ($("lead-focus")) void advanceQuick();
}

function panel(content) { return '<section class="panel">' + content + '</section>'; }
function fields(action, content, text = "Speichern", id = "") {
  return '<form class="fields" data-action="' + action + '" data-id="' + esc(id) + '">' + content + btn(text) + '</form>';
}
function record(title, body) { return '<details class="record"><summary>' + title + '</summary>' + body + '</details>'; }
function search(placeholder) {
  return '<input data-search type="search" aria-label="' + placeholder + '" placeholder="' + placeholder + '" value="' + esc(filter[view]) + '">';
}
function syncStatus() {
  if (syncError) return "Letzter Abruf fehlgeschlagen. " + esc(syncError);
  return data.sync ? "Letzter erfolgreicher Reonic-Import " + date(data.sync.synced_at) + " · " + data.sync.user_count + " Benutzer" : "Reonic wurde noch nicht erfolgreich synchronisiert.";
}
const berlinDay = value => new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Berlin",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(value));
function weekStart(value) {
  const day = new Date(berlinDay(value) + "T00:00:00Z");
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay()+6)%7);
  return day.toISOString().slice(0,10);
}
function confirmed(a) {
  return Boolean(a.reonic_synced_at || !data.leads.find(l => l.id === a.lead_id)?.reonic_project_id);
}
function assignmentsInWeek(week) {
  return data.assignments.filter(a => confirmed(a) && weekStart(a.reonic_synced_at || a.assigned_at) === week);
}
function weeklySummary() {
  const week = weekStart(Date.now());
  const current = assignmentsInWeek(week);
  const activeOrders = data.orders.filter(o => o.order_type === "weekly" && ["open","in_progress"].includes(o.status));
  const ids = new Set([...activeOrders.map(o => o.supplier_id),...current.map(a => a.supplier_id || data.orders.find(o => o.id === a.order_id)?.supplier_id)]);
  const rows = [...ids].map(id => {
    const orders = activeOrders.filter(o => o.supplier_id === id);
    const qty = orders.reduce((sum,o) => sum+(o.quantity ?? 0),0);
    const assigned = current.filter(a => (a.supplier_id || data.orders.find(o => o.id === a.order_id)?.supplier_id) === id).length;
    return "<tr><td>" + esc(id ? supplierFor(id) : "Ohne Lead-Anbieter") + "</td><td>" +
      qty + (orders.some(o => o.quantity == null) ? " + offene Mengen" : "") + "</td><td>" + assigned + "</td></tr>";
  });
  return panel('<h2>Lead-Anbieter · Woche ab ' + esc(week.split("-").reverse().join(".")) +
    '</h2><div class="table-wrap"><table><thead><tr><th>Lead-Anbieter</th><th>Bestellt pro Woche</th><th>Diese Woche zugewiesen</th></tr></thead><tbody>' +
    rows.join("") + '</tbody></table></div>');
}
function partnerWeek(week) {
  const totals = new Map();
  const get = id => {
    if (!totals.has(id)) totals.set(id,{received:0,ordered:0,remaining:0,unlimited:0});
    return totals.get(id);
  };
  const assignedByOrder = new Map();
  for (const assignment of assignmentsInWeek(week)) {
    get(assignment.partner_id).received++;
    if (assignment.order_id) {
      assignedByOrder.set(assignment.order_id,(assignedByOrder.get(assignment.order_id) || 0) + 1);
    }
  }
  for (const order of data.orders) {
    if (!order.partner_id || order.order_type !== "weekly" || !["open","in_progress"].includes(order.status)) continue;
    const total = get(order.partner_id);
    if (order.quantity == null) {
      total.unlimited++;
      continue;
    }
    total.ordered += order.quantity;
    total.remaining += Math.max(0,order.quantity - (assignedByOrder.get(order.id) || 0));
  }
  return totals;
}
function weeklyQuantity(value,openQuantity) {
  if (!openQuantity) return String(value);
  return value ? value + " + Menge offen" : "Menge offen";
}
function adviserWeeklySummary() {
  const week = weekStart(Date.now());
  const rows = [...partnerWeek(week)].sort(([a],[b]) => nameFor(a).localeCompare(nameFor(b),"de"))
    .map(([id,total]) => '<tr><td><strong>' + esc(nameFor(id)) + '</strong></td><td>' +
      weeklyQuantity(total.ordered,total.unlimited) + '</td><td>' + total.received +
      '</td><td><strong class="weekly-remaining">' + weeklyQuantity(total.remaining,total.unlimited) + '</strong></td></tr>');
  return panel('<h2>Berater · Woche ab ' + esc(week.split("-").reverse().join(".")) +
    '</h2><div class="table-wrap"><table class="adviser-week-table"><thead><tr><th>Berater</th><th>Bestellt</th><th>Erhalten</th><th>Noch offen</th></tr></thead><tbody>' +
    (rows.join("") || '<tr><td colspan="4">Diese Woche sind noch keine Bestellungen oder Zuweisungen erfasst.</td></tr>') +
    '</tbody></table></div>');
}
function dashboard() {
  const metrics = [["Leads", data.leads.length], ["Aktive Verkäufer", data.partners.filter(p => p.active && p.reonic_present).length],
    ["Zuweisungen", data.assignments.length], ["Bestellungen", data.orders.length]];
  return '<div class="stats">' + metrics.map(([name, count]) =>
    '<div class="stat"><div class="muted">' + name + '</div><strong>' + count + '</strong></div>').join("") +
    '</div>' + weeklySummary() + adviserWeeklySummary() + panel('<h2>Verbindungen</h2><p>Supabase verbunden</p><p>' + syncStatus() + '</p>');
}

let leadTab = "open";
let leadMode = "list";

function leads() {
  const openCount = data.leads.filter(isOpenLead).length;
  const assignedCount = data.assignments.length;
  return panel('<div class="panel-head"><h2>Leads zur Zuweisung</h2>' +
    btn("+ Lead hinzufügen", 'data-command="new-lead"') + '</div><div id="new-lead" hidden>' + fields("lead", input("Kundenname", "customer_name", "", 'required maxlength="250"') +
    input("Deutsche PLZ", "postal_code", "", zipAttr + " required") + input("E-Mail", "email", "", 'type="email"') +
    input("Telefon", "phone", "", 'type="tel"') + input("Lead-Anbieter", "source") + input("Notizen", "notes"), "Lead speichern")+
    '</div><div class="lead-tabs">' +
    '<button class="lead-tab ' + (leadTab === "open" ? "active" : "") + '" data-command="open-leads">Offene Leads (' + openCount + ')</button>' +
    '<button class="lead-tab ' + (leadTab === "assigned" ? "active" : "") + '" data-command="assigned-leads">Zugewiesen (' + assignedCount + ')</button>' +
    btn("Reonic-Anfragen und Teams laden", 'data-command="requests"') + '</div>' +
    (leadTab === "open" ? '<div class="lead-mode-switch">' +
      '<button class="lead-tab ' + (leadMode === "list" ? "active" : "") + '" data-command="lead-list">☷ Listenansicht</button>' +
      '<button class="lead-tab ' + (leadMode === "focus" ? "active" : "") + '" data-command="quick">▣ Einzeln zuweisen</button></div>' : '') +
    (leadTab === "open" && leadMode === "focus" ? '<div id="lead-focus" class="lead-focus-card"></div>' :
      '<div class="toolbar">' + search("Lead, PLZ oder Leadanbieter suchen …") +
      '<select id="lead-status" aria-label="Status filtern">' +
      options(leadTab === "open" ? [["","Alle offenen Leads"],["reonic","Reonic · Ohne Status"],["reonic-new","Reonic · Neue Anfragen"]] :
        [["","Alle Zuweisungen"],...Object.entries(statuses).slice(1)],filter.status) +
      '</select></div><div id="records" class="table-wrap"></div>'));
}
function isOpenLead(lead) {
  return lead.status === "new" && (!lead.reonic_project_id || lead.reonic_queue_open);
}
function matchesPartnerPostalView(partner) {
  if (filter.partnerPostalView === "all") return true;
  if (!partner.reonic_present || !partner.reonic_user_id) return false;
  const hasPostalCode = Boolean(partner.postal_code?.trim() || partner.reonic_postal_code?.trim());
  return filter.partnerPostalView === "with" ? hasPostalCode : !hasPostalCode;
}
function partners() {
  return panel('<h2>Verkäufer verwalten</h2><div class="controls">' + search("Name, PLZ, Team oder Kontakt suchen") +
    btn(filter.partnerPostalView === "without" ? "Zur PLZ-Liste" : "Reonic-Benutzer hinzufügen", 'data-command="partner-intake"') +
    '<label>Ansicht <select id="partner-postal-view">' +
    options([["with","Mit PLZ"],["without","Reonic-Benutzer ohne PLZ"],["all","Alle Profile verwalten"]],filter.partnerPostalView) +
    '</select></label>' + btn("Reonic synchronisieren", 'data-command="sync"') + '</div><p>' + syncStatus() + '</p>' +
    (filter.partnerPostalView === "without" ? '<h3>Reonic-Benutzer hinzufügen</h3><p>Benutzer öffnen, PLZ und bei Bedarf das Team eintragen und speichern. Danach erscheint das Profil in der PLZ-Liste.</p>' : '') +
    '<div id="records"></div>');
}

function orders() {
  const orderedSupplierIds = new Set(data.orders.map(o => o.supplier_id));
  const suppliers = data.suppliers.filter(s => s.active || orderedSupplierIds.has(s.id))
    .sort((a,b) => a.name.localeCompare(b.name,"de",{sensitivity:"base"}));
  return panel('<h2>Neue Lead-Bestellung</h2>' + orderForm({ order_type: "once", status: "open" })) +
    panel('<h2>Bestellungen</h2><div class="controls">' + search("Bestellung, Verkäufer oder Anbieter suchen") +
      '<label>Sortierung <select id="order-sort">' +
      options([["az","Berater A–Z"],["za","Berater Z–A"],["newest","Neueste zuerst"]],filter.orderSort) +
      '</select></label><label>Lead-Anbieter <select id="order-supplier">' +
      options([["","Alle Anbieter"],...suppliers.map(s => [s.id,s.name]),["unassigned","Ohne Anbieter"]],filter.orderSupplier) +
      '</select></label></div><p id="order-result-count" class="muted" role="status"></p><div id="records"></div>');
}
function orderForm(o) {
  const sellers = [["", "Freie Gebietsbestellung"], ...data.partners.map(p => [p.id, p.full_name])];
  const suppliers = [["", "Kein Anbieter gewählt"], ...data.suppliers.filter(s => s.active || s.id === o.supplier_id).map(s => [s.id, s.name])];
  const orderState = Object.entries(orderStatuses);
  if (o.status && !orderStatuses[o.status]) orderState.push([o.status, o.status]);
  return fields("order", select("Verkäufer", "partner_id", sellers, o.partner_id) +
    input("Name der freien Gebietsbestellung", "area_name", o.area_name, 'maxlength="100" placeholder="z. B. Region Köln"') +
    select("Lead-Anbieter", "supplier_id", suppliers, o.supplier_id) +
    select("Bestellart", "order_type", [["once", "Einmalig"], ["weekly", "Wöchentlich"]], o.order_type) +
    (o.postal_codes_only ? '<p>Hinterlegte PLZ beim Anbieter · Menge offen</p>' : input("Menge", "quantity", o.quantity, 'type="number" min="1" required')) +
    input("Gebiets-PLZ", "postal_code", o.postal_code, zipAttr + " required") +
    (o.postal_codes_only ? '' : input("Umkreis als Luftlinie (km)", "radius_km", o.radius_km, 'type="number" min="0.1" step="0.1"') +
    input("Oder maximale Fahrzeit (Min.)", "max_drive_minutes", o.max_drive_minutes, 'type="number" min="1" step="1"')) +
    select("Status", "status", orderState, o.status) + input("Notizen", "notes", o.notes), "Bestellung speichern", o.id);
}

function settings() {
  return panel('<h2>Lead-Verteilung</h2><p>Deutsche PLZ · Luftlinie zwischen PLZ-Mittelpunkten. Die Vorschläge sind nach Fahrtweg sortiert. Bei gleichem Fahrtweg zählt die höhere Priorität. Priorität und Einsatzradius sind pro Verkäufer einstellbar.</p>' +
    '<p>Eine Bestellung ist bei der Zuweisung optional.</p><p>PLZ-Daten von <a href="https://www.geonames.org/export/zip/">GeoNames</a>, CC BY 4.0. Je PLZ wurden die Koordinaten der Einträge mit der höchsten Genauigkeitsstufe gemittelt.</p>') +
    panel('<h2>Lead-Anbieter</h2>' + supplierForm({ active: true }) + data.suppliers.map(s => record(esc(s.name), supplierForm(s))).join(""));
}
function supplierForm(s) {
  return fields("supplier", input("Name", "name", s.name, "required") + input("E-Mail", "email", s.email, 'type="email"') +
    select("Status", "active", [["true", "Aktiv"], ["false", "Inaktiv"]], String(s.active)), "Anbieter speichern", s.id);
}


const nameFor = id => data.partners.find(p => p.id === id)?.full_name || "—";
const supplierFor = id => data.suppliers.find(s => s.id === id)?.name || "—";
const matches = (...parts) => parts.join(" ").toLocaleLowerCase("de").includes(filter[view].trim().toLocaleLowerCase("de"));

function matchesLeadStatus(lead) {
  if (!filter.status) return true;
  if (filter.status !== "reonic" && filter.status !== "reonic-new") return lead.status === filter.status;
  if (!lead.reonic_project_id || !lead.reonic_queue_open || lead.status !== "new") return false;
  return filter.status === "reonic-new" ? lead.source?.startsWith("Reonic · Neue Anfragen · ") : lead.source === "Reonic · Ohne Status";
}
function renderRecords() {
  if (!$("records")) return;
  if (view === "leads") {
    const assigned = leadTab === "assigned";
    const list = data.leads.filter(l => (assigned ? Boolean(data.assignments.find(a => a.lead_id === l.id)) : isOpenLead(l)) &&
      matchesLeadStatus(l) && matches(l.customer_name,l.postal_code,l.source,l.email,l.phone));
    list.sort((a,b) => b.created_at.localeCompare(a.created_at));
    $("records").innerHTML = '<table><thead><tr><th>Lead / Kundenkontakt</th><th>PLZ' +
      (assigned ? '' : ' · Vorschläge') + '</th><th>Leadanbieter / Quelle</th><th>' +
      (assigned ? 'Zugewiesen an / Datum' : 'Aktion') + '</th></tr></thead><tbody>' +
      (list.map(l => {
        const assignment = data.assignments.find(a => a.lead_id === l.id);
        return '<tr><td><strong>' + esc(l.customer_name) + '</strong><div class="tiny">' +
          esc([l.email,l.phone].filter(Boolean).join(" · ")) + '</div></td><td>' +
          (assigned ? esc(l.postal_code || "PLZ fehlt") : btn(esc(l.postal_code || "PLZ fehlt"), 'data-command="suggest" data-id="' + esc(l.id) + '"')) +
          '</td><td>' + esc(l.source) + '</td><td>' +
          (assigned ? esc(nameFor(assignment.partner_id)) + ' · ' + date(assignment.assigned_at) + leadRecord(l) :
            btn("10 Vorschläge ansehen", 'data-command="suggest" data-id="' + esc(l.id) + '"')) +
          '</td></tr>';
      }).join("") || '<tr><td colspan="4" class="empty">Keine passenden Leads gefunden.</td></tr>') +
      '</tbody></table>';
    return;
  }
  const lists = {
    leads: () => [...data.leads].sort((a,b) => b.created_at.localeCompare(a.created_at)).filter(l =>
      matchesLeadStatus(l) && matches(l.customer_name, l.postal_code, l.source, l.email, l.phone)).map(leadRecord),
    partners: () => [...data.partners].sort((a,b) => a.full_name.localeCompare(b.full_name, "de")).filter(p =>
      matchesPartnerPostalView(p) &&
      matches(p.full_name, p.postal_code, p.reonic_postal_code, p.email, p.phone, p.reonic_user_id, data.teams.find(t => t.id === p.reonic_team_id)?.name)).map(partnerRecord),
    orders: () => {
      const visible = data.orders.filter(o =>
        (!filter.orderSupplier || (o.supplier_id || "unassigned") === filter.orderSupplier) &&
        matches(o.id, o.area_name, nameFor(o.partner_id), supplierFor(o.supplier_id), o.postal_code, orderStatuses[o.status] || o.status));
      visible.sort((a,b) => {
        const newest = b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id);
        if (filter.orderSort === "newest") return newest;
        if (!a.partner_id || !b.partner_id) return Number(!a.partner_id)-Number(!b.partner_id) || newest;
        const byName = nameFor(a.partner_id).localeCompare(nameFor(b.partner_id),"de",{sensitivity:"base"});
        return byName * (filter.orderSort === "za" ? -1 : 1) || newest;
      });
      $("order-result-count").textContent = visible.length + " von " + data.orders.length + " Bestellungen";
      const groups = new Map();
      for (const order of visible) {
        const key = order.partner_id || order.id;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(order);
      }
      return [...groups.values()].map(orderGroup);
    }
  };
  $("records").innerHTML = lists[view]().join("") || '<p class="muted">Keine passenden Einträge.</p>';
}
function historyFor(entity,id,labels) {
  const entries = data.activity.filter(item => item.entity === entity && item.record_id === id).reverse();
  if (!entries.length) return "";
  return "<h3>Verlauf</h3><ul>" + entries.map(item =>
    "<li>" + date(item.changed_at) + " · " + (item.action === "insert" ? "Erfasst" : "Geändert") +
    (item.new_status ? " · " + esc(labels[item.new_status] || item.new_status) : "") + "</li>").join("") + "</ul>";
}
function leadRecord(l) {
  const a = data.assignments.find(row => row.lead_id === l.id);
  const order = a && data.orders.find(o => o.id === a.order_id);
  const meta = "<p>Erfasst " + date(l.created_at) + " · " + esc([l.email, l.phone, l.source].filter(Boolean).join(" · ")) + "</p>" +
    (l.notes ? "<p>" + esc(l.notes) + "</p>" : "");
  const pending = a && l.reonic_project_id && !a.reonic_synced_at;
  const team = data.teams.find(team => team.id === a?.reonic_team_id);
  const actions = a ? '<p>Zuweisung an ' + esc(nameFor(a.partner_id)) + ' · ' + date(a.assigned_at) +
    (a.manual ? ' · Manuell zugewiesen' : '') +
    (a.distance_km == null ? '' : ' · ' + a.distance_km.toLocaleString("de-DE",{maximumFractionDigits:1}) + ' km Luftlinie') +
    (team ? ' · Team ' + esc(team.name) : '') +
    (pending ? '<p>Übertragung an Reonic ausstehend.</p>' + btn("Erneut an Reonic übertragen", 'data-command="retry-reonic" data-id="' + esc(l.id) + '"') : '') +
    (order ? ' · Bestellung vom ' + date(order.created_at) : '') + '</p>' +
    fields("leadStatus", select("Status", "status", Object.entries(statuses).slice(1),l.status), "Status speichern", l.id) :
    l.reonic_project_id && !l.reonic_queue_open ? "<p>Diese Anfrage ist in Reonic nicht mehr in der offenen Warteschlange.</p>" : btn("Verkäufer vorschlagen", 'data-command="suggest" data-id="' + esc(l.id) + '"');
  return record(esc(l.customer_name) + " · " + esc(l.postal_code || "PLZ fehlt") + " · " + esc(pending ? "Reonic-Übertragung ausstehend" : l.reonic_project_id && !a ? (l.reonic_queue_open ? l.source : "Reonic · Nicht mehr offen") : statuses[l.status]), meta + actions + historyFor("leads",l.id,statuses));
}
function partnerRecord(p) {
  const zip = p.postal_code || p.reonic_postal_code;
  const team = data.teams.find(t => t.id === p.reonic_team_id);
  const teamLabel = team ? team.name + (team.active ? "" : " (archiviert)") :
    p.reonic_team_optional ? "Ohne Team" : "Kein Team hinterlegt";
  const title = esc(p.full_name) + ' · <strong>Team: ' + esc(teamLabel) + '</strong> · ' + (zip ? esc(zip) : '<span class="zip-warning">PLZ fehlt</span>') +
    ' · ' + (!p.reonic_present ? 'Nicht mehr in Reonic verfügbar' : p.active ? 'Freigeschaltet' : 'Deaktiviert');
  return record(title, '<p>' + esc([p.email,p.phone,p.reonic_user_id && "Reonic-ID " + p.reonic_user_id].filter(Boolean).join(" · ")) + '</p>' +
    fields("partner", input("Manuelle PLZ", "postal_code", p.postal_code, zipAttr) +
      input("Einsatzradius (km)", "radius_km", p.radius_km, 'type="number" min="0.1" max="2000" step="0.1"') +
      input("Priorität", "priority", p.priority, 'type="number" step="1" required') +
      select("Reonic-Team", "reonic_team_id", [["","Team auswählen"], ...data.teams.filter(team => team.active || team.id === p.reonic_team_id).map(team => [team.id,team.name + (team.active ? "" : " (archiviert)")])],p.reonic_team_id) +
      select("Freigabe", "active", [["true","Freigeschaltet"],["false","Deaktiviert"]],String(p.active)), "Verkäufer speichern",p.id) + sellerOrders(p));
}
function sellerOrders(p) {
  const linked = data.orders.filter(o => o.partner_id === p.id);
  return '<h3>Bestellungen</h3>' +
    (linked.length ? linked.map(orderRecord).join("") : '<p class="muted">Noch keine Bestellung erfasst.</p>') +
    record("Neue Bestellung für " + esc(p.full_name),orderForm({
      partner_id:p.id, order_type:"once", status:"open",
      postal_code:p.postal_code || p.reonic_postal_code, radius_km:p.radius_km
    }));
}
function orderGroup(orders) {
  const name = orders[0].partner_id ? nameFor(orders[0].partner_id) : orders[0].area_name || "Freie Gebietsbestellung";
  const entries = orders.slice().sort((a,b) =>
    supplierFor(a.supplier_id).localeCompare(supplierFor(b.supplier_id),"de"));
  const labels = entries.map(order => {
    const supplier = order.supplier_id ? supplierFor(order.supplier_id) : "Ohne Anbieter";
    const amount = order.quantity == null ? "Menge offen" : order.quantity +
      (order.order_type === "weekly" ? " pro Woche" : " einmalig");
    return '<span class="order-provider">' + esc(supplier) + ' <strong>' + esc(amount) + '</strong></span>';
  }).join("");
  return '<details class="record grouped-order"><summary><span class="order-group-line"><strong>' +
    esc(name) + '</strong><span class="order-provider-list">' + labels +
    '</span></span></summary>' + entries.map(orderRecord).join("") + '</details>';
}
function orderRecord(o) {
  const assigned = data.assignments.filter(a => a.order_id === o.id);
  const counted = assigned.filter(a => confirmed(a) && (o.order_type !== "weekly" ||
    weekStart(a.reonic_synced_at || a.assigned_at) === weekStart(Date.now()))).length;
  const progress = (o.quantity == null ? "Menge offen" : o.quantity + " bestellt") + " · " + counted +
    (o.order_type === "weekly" ? " diese Woche zugewiesen" : " zugewiesen");
  const supplier = o.supplier_id ? supplierFor(o.supplier_id) : "Ohne Anbieter";
  const volume = o.quantity == null ? "Menge offen" : o.quantity +
    (o.quantity === 1 ? " Lead" : " Leads") + (o.order_type === "weekly" ? " pro Woche" : " einmalig");
  return record(esc(o.partner_id ? nameFor(o.partner_id) : o.area_name || "Freie Gebietsbestellung") + " · " +
    esc(supplier) + ' · <strong>' + esc(volume) + '</strong> · ' +
    esc(orderStatuses[o.status] || o.status) + " · " + date(o.created_at),
    "<p>" + esc(supplierFor(o.supplier_id)) + " · " + progress + "</p>" + orderForm(o) +
    (assigned.length ? "<ul>" + assigned.map(a => "<li>" + esc(data.leads.find(l => l.id === a.lead_id)?.customer_name) + " · " + date(a.assigned_at) + "</li>").join("") + "</ul>" : "") + historyFor("lead_orders",o.id,orderStatuses));
}

async function validZip(zip) {
  const result = await client.from("de_postal_codes").select("postal_code").eq("postal_code",zip).maybeSingle();
  fail(result.error);
  return Boolean(result.data);
}
async function save(action, values, id) {
  let result;
  switch (action) {
    case "lead":
      if (!(await validZip(values.postal_code))) throw Error("Diese deutsche PLZ ist in der Standortliste unbekannt.");
      result = await client.from("leads").insert(Object.fromEntries(Object.entries(values).map(([key,value]) => [key,optional(value)])));
      break;
    case "leadStatus":
      result = await client.from("leads").update({status:values.status}).eq("id",id).select("id").single();
      break;
    case "partner":
      if (values.postal_code && !(await validZip(values.postal_code))) throw Error("Diese deutsche PLZ ist in der Standortliste unbekannt.");
      if (values.active === "true" && (!(values.postal_code || data.partners.find(p=>p.id===id)?.reonic_postal_code) || !values.radius_km)) {
        throw Error("Für die Freigabe sind PLZ und Einsatzradius erforderlich.");
      }
      result = await client.from("sales_partners").update({
        postal_code:optional(values.postal_code), radius_km:values.radius_km ? Number(values.radius_km) : null,
        reonic_team_id:optional(values.reonic_team_id), priority:Number(values.priority), active:values.active === "true"
      }).eq("id",id).select("id").single();
      break;
    case "order": {
      if (values.postal_code && !(await validZip(values.postal_code))) throw Error("Diese deutsche PLZ ist in der Standortliste unbekannt.");
      const postalCodesOnly = Boolean(data.orders.find(o => o.id === id)?.postal_codes_only);
      if (!postalCodesOnly && Boolean(values.radius_km) === Boolean(values.max_drive_minutes)) {
        throw Error("Bitte entweder den Luftlinien-Umkreis oder die maximale Fahrzeit eintragen.");
      }
      const row = {...values, area_name:optional(values.area_name), max_drive_minutes:values.max_drive_minutes ? Number(values.max_drive_minutes) : null, partner_id:optional(values.partner_id), supplier_id:optional(values.supplier_id),
        postal_code:optional(values.postal_code), radius_km:values.radius_km ? Number(values.radius_km) : null,
        quantity:postalCodesOnly ? null : Number(values.quantity), notes:optional(values.notes)};
      result = id ? await client.from("lead_orders").update(row).eq("id",id).select("id").single() : await client.from("lead_orders").insert(row);
      break;
    }
    case "supplier": {
      const row = {name:values.name.trim(),email:optional(values.email),active:values.active === "true"};
      if (!row.name) throw Error("Bitte einen Namen eingeben.");
      result = id ? await client.from("lead_suppliers").update(row).eq("id",id).select("id").single() : await client.from("lead_suppliers").insert(row);
      break;
    }
    case "assign":
      if (data.leads.find(l => l.id === id)?.reonic_project_id) {
        await reonicRequests({action:"assign",lead_id:id,...values});
        return;
      }
      result = await client.from("lead_assignments").insert({lead_id:id,partner_id:values.partner_id,order_id:optional(values.order_id),supplier_id:optional(values.supplier_id),manual:values.manual === "true"});
      if (result.error?.code === "23505") throw Error("Dieser Lead ist bereits zugewiesen. Bitte aktualisieren.");
      break;
    default: throw Error("Unbekannte Aktion.");
  }
  fail(result.error);
}
let focusId = null;
function focusQueue() {
  return data?.leads.filter(isOpenLead).sort((a,b) =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)) || [];
}
async function advanceQuick(delta = 0) {
  const target = $("lead-focus");
  if (!target) return;
  const queue = focusQueue();
  const index = queue.findIndex(l => l.id === focusId);
  const next = queue[Math.max(0,Math.min(queue.length - 1,index + delta))];
  if (!next) {
    focusId = null;
    target.innerHTML = '<h2>Alle offenen Leads erledigt</h2>';
    return;
  }
  focusId = next.id;
  await suggest(next.id,true);
}
function manualPartnerForm(lead) {
  const partners = data.partners.filter(p => p.reonic_present &&
    (!lead.reonic_project_id || (p.reonic_user_id && (p.reonic_team_optional || data.teams.some(t => t.id === p.reonic_team_id && t.active && t.leader_ids.length)))))
    .sort((a,b) => a.full_name.localeCompare(b.full_name,"de"));
  if (!partners.length) return '<div class="focus-other"><h3>Vertriebspartner manuell auswählen</h3><p>Schalte zuerst einen Vertriebspartner frei' +
    (lead.reonic_project_id ? ' und hinterlege sein Reonic-Team' : '') + '.</p></div>';
  return '<div class="focus-other"><h3>Vertriebspartner manuell auswählen</h3>' + fields("assign",
    '<input type="hidden" name="manual" value="true">' +
    input("Name oder PLZ suchen","partner_search","",'type="search" autocomplete="off" data-manual-search') +
    select("Vertriebspartner","partner_id",[["","Bitte wählen"],...partners.map(p =>
      [p.id,p.full_name + " · " + (p.postal_code || p.reonic_postal_code || "PLZ fehlt") + (p.active ? "" : " · Deaktiviert")])],"") + assignmentChoice(lead,""),
    "Manuell zuweisen",lead.id) + '</div>';
}
async function byDrivingDistance(lead, candidates) {
  if (!candidates.length) return {ranked:[], unavailable:0};
  const zipFor = id => {
    const partner = data.partners.find(p => p.id === id);
    return partner?.postal_code || partner?.reonic_postal_code;
  };
  const zips = [...new Set([lead.postal_code,...candidates.map(p => zipFor(p.partner_id))].filter(Boolean))];
  const result = await client.from("de_postal_codes").select("postal_code,longitude,latitude").in("postal_code",zips);
  fail(result.error);
  const points = new Map(result.data.map(p => [p.postal_code,p.longitude + "," + p.latitude]));
  const destination = points.get(lead.postal_code);
  const routes = new Map();
  const origins = zips.filter(zip => zip !== lead.postal_code && points.has(zip));
  if (destination) {
    if (zips.includes(lead.postal_code)) routes.set(lead.postal_code,{driveKm:0,driveMinutes:0});
    for (let offset = 0; offset < origins.length; offset += 40) {
      const batch = origins.slice(offset,offset+40);
      try {
        const coordinates = [...batch.map(zip => points.get(zip)),destination].join(";");
        const response = await fetch("https://router.project-osrm.org/table/v1/driving/" + coordinates +
          "?destinations=" + batch.length + "&annotations=distance,duration",
          {signal:AbortSignal.timeout(8000),referrerPolicy:"no-referrer"});
        if (!response.ok) continue;
        const matrix = await response.json();
        batch.forEach((zip,index) => {
          const metres = matrix.distances?.[index]?.[0];
          const seconds = matrix.durations?.[index]?.[0];
          if (Number.isFinite(metres) && Number.isFinite(seconds)) {
            routes.set(zip,{driveKm:metres/1000,driveMinutes:seconds/60});
          }
        });
      } catch { /* The view reports candidates whose routes could not be calculated. */ }
    }
  }
  const ranked = candidates.map(p => ({...p,...routes.get(zipFor(p.partner_id))}));
  const unavailable = ranked.filter(p => p.driveKm == null).length;
  ranked.sort((a,b) => (a.driveKm ?? Infinity) - (b.driveKm ?? Infinity) ||
    (a.driveKm == null && b.driveKm == null ? a.distance_km - b.distance_km : 0) ||
    b.priority-a.priority || a.partner_id.localeCompare(b.partner_id));
  return {ranked:ranked.slice(0,10),unavailable};
}
function sourceForLead(lead) {
  const normalize = value => (value || "").toLowerCase().replace(/[^a-z0-9]/g,"");
  if (lead.reonic_source_id) return data.suppliers.find(s => s.active && s.reonic_source_id === lead.reonic_source_id)?.id || "";
  const key = normalize(lead.source?.split(" · ").at(-1));
  return data.suppliers.find(s => s.active && normalize(s.name) === key)?.id || "";
}
function assignmentChoice(lead, partnerId) {
  const source = sourceForLead(lead);
  const sourceField = source
    ? '<input type="hidden" name="supplier_id" value="' + esc(source) + '"><p>Lead-Anbieter: ' + esc(supplierFor(source)) + '</p>'
    : select("Lead-Anbieter","supplier_id",[["","Bitte wählen"],...data.suppliers.filter(s => s.active).map(s => [s.id,s.name])],"");
  return sourceField + '<div data-order-choice>' +
    select("Bestellung","order_id",orderOptions(partnerId,source),"") + '</div>';
}
function orderOptions(partner,source) {
  return [["","Ohne Bestellung"],...data.orders.filter(o => o.partner_id === partner && o.supplier_id === source &&
    ["open","in_progress"].includes(o.status)).map(o => [o.id,
    (o.quantity == null ? "Menge offen" : o.quantity + (o.order_type === "weekly" ? " pro Woche" : " einmalig")) +
    " · " + (o.postal_codes_only ? "Hinterlegte PLZ" : o.radius_km != null ? o.radius_km + " km Luftlinie" : o.max_drive_minutes + " Min. Fahrzeit")])];
}
function bindOrderChoices(target) {
  for (const form of target.querySelectorAll('form[data-action="assign"]')) {
    const {supplier_id:source,partner_id:partner,order_id:order} = form.elements;
    if (form.hasAttribute("data-quick-direct")) continue;
    source.required = true;
    const update = () => {
      const choices = orderOptions(partner.value,source.value);
      const selected = choices.length === 2 ? choices[1][0] : "";
      const area = form.querySelector("[data-order-choice]");
      order.innerHTML = options(choices,selected);
      const automatic = Boolean(source.value && partner.value && choices.length <= 2);
      order.closest("label").hidden = automatic;
      area.querySelector("[data-order-summary]")?.remove();
      if (automatic) {
        const summary = document.createElement("p");
        summary.dataset.orderSummary = "";
        summary.textContent = selected ? "Bestellung: " + choices[1][1] : "Keine offene Bestellung für diese Quelle.";
        area.append(summary);
      }
    };
    source.addEventListener("change", update);
    partner.addEventListener("change", update);
    update();
  }
}
function compactSuggestion(lead,partner,index,weekly = {received:0,ordered:0,remaining:0,unlimited:0}) {
  const source = sourceForLead(lead);
  const matching = orderOptions(partner.partner_id,source);
  const hidden = (name,value) => '<input type="hidden" name="' + name + '" value="' + esc(value) + '">';
  const extra = matching.length > 2 || !source;
  const form = '<form class="quick-action" data-action="assign" data-id="' + esc(lead.id) + '"' +
    (extra ? '' : ' data-quick-direct') + '>' + hidden("partner_id",partner.partner_id) +
    hidden("manual",String(Boolean(partner.outside_radius || !data.partners.find(p => p.id === partner.partner_id)?.active))) +
    (extra ? assignmentChoice(lead,partner.partner_id) : hidden("supplier_id",source) + hidden("order_id",matching[1]?.[0] || "")) +
    btn("Zuweisen") + '</form>';
  const km = value => value.toLocaleString("de-DE",{maximumFractionDigits:1});
  const route = partner.driveKm == null ? "Fahrtweg nicht verfügbar" :
    km(partner.driveKm) + ' km Fahrtweg · ' + Math.round(partner.driveMinutes) + ' Min.';
  const seller = data.partners.find(p => p.id === partner.partner_id);
  const team = data.teams.find(t => t.id === seller?.reonic_team_id && t.active);
  const blocked = lead.reonic_project_id && !seller.reonic_team_optional && !team?.leader_ids.length ? "Team fehlt" : "";
  const inside = !partner.outside_radius;
  const routeText = '<span class="quick-route' + (inside && partner.driveKm != null ? ' quick-route-inside' : '') +
    '">' + route + '</span>';
  return '<div class="quick-row' + (inside ? ' quick-row-inside' : '') + '"><strong class="quick-rank" aria-label="Platz ' + (index+1) + '">' + (index+1) +
    '</strong><div><strong>' + esc(partner.full_name) + '</strong>' +
    (seller && !seller.active ? ' <span class="assignment-disabled">Deaktiviert</span>' : '') + '<span class="quick-week-count">' +
    (weekly.unlimited ? weekly.ordered + ' fest bestellt · ' + weekly.remaining + ' offen · Menge teils offen' :
      weekly.ordered + ' bestellt · ' + weekly.remaining + ' offen') + '</span><small>' + routeText + ' · ' +
    km(partner.distance_km) + ' km Luftlinie' + (partner.outside_radius ? (seller?.radius_km == null ? ' · Kein Einsatzradius hinterlegt' : ' · Außerhalb Einsatzradius') : '') +
    '</small></div><div class="quick-card-end"><span class="quick-received"><strong>' + weekly.received +
    '</strong><span>Diese Woche<br>erhalten</span></span>' + (blocked ? '<small>' + blocked + '</small>' : extra ? '<details><summary>Zuweisen</summary>' + form + '</details>' : form) + '</div></div>';
}
async function suggest(id, quick = false) {
  const lead = data.leads.find(l => l.id === id);
  if (!lead) return;
  const dialog = $("suggestions");
  const target = $(quick ? "lead-focus" : "suggest-content");
  if (!target) return;
  target.innerHTML = "<h2>" + esc(lead.customer_name) + "</h2><p>Geeignete Verkäufer werden gesucht …</p>";
  dialog.dataset.lead = id;
  dialog.dataset.quick = String(quick);
  if (!quick && !dialog.open) dialog.showModal();
  const isCurrent = () => quick ? $("lead-focus") === target && focusId === id : dialog.open && dialog.dataset.lead === id;
  const contactLookup = lead.reonic_project_id
    ? reonicRequests({action:"contact",lead_id:id}).then(result => result.contact).catch(() => null)
    : Promise.resolve(null);
  try {
    const result = await client.rpc(quick ? "nearby_lead_partners" : "lead_candidates",{p_lead_id:id});
    fail(result.error);
    const candidates = result.data;
    const {ranked,unavailable} = await byDrivingDistance(lead,candidates);
    if (!isCurrent()) return;
    const weeklyCounts = quick ? partnerWeek(weekStart(Date.now())) : null;
    const queue = quick ? focusQueue() : [];
    const index = queue.findIndex(row => row.id === id);
    const details = '<div class="lead-focus-details">' +
      [lead.postal_code || "PLZ fehlt",lead.source,lead.email,lead.phone].filter(Boolean)
        .map(item => '<span>' + esc(item) + '</span>').join("") + '</div>';
    const heading = (quick ? '<div class="lead-focus-count">Lead ' + (index + 1) + ' von ' + queue.length + '</div>' : '') +
      '<h2 class="lead-focus-name">' + esc(lead.customer_name) + '</h2>' + details + '<div class="lead-focus-details" data-contact></div>' +
      (quick ? '<div class="lead-focus-actions">' +
        btn("← Zurück", 'data-command="focus-prev" ' + (index <= 0 ? "disabled" : "")) +
        btn("Weiter →", 'data-command="focus-next" ' + (index >= queue.length - 1 ? "disabled" : "")) +
        '</div>' : "");
    target.innerHTML = (quick ? '<div class="quick-layout"><div class="quick-lead">' + heading + '</div><div>' : heading) + (
      ranked.length ? '<div class="' + (quick ? 'quick-suggestions' : 'suggest-cards') + '">' + ranked.map((p,index) => {
        if (quick) return compactSuggestion(lead,p,index,weeklyCounts.get(p.partner_id));
        const seller = data.partners.find(s => s.id === p.partner_id);
        const team = data.teams.find(t => t.id === seller?.reonic_team_id && t.active);
        const needsTeam = Boolean(lead.reonic_project_id && (!seller?.reonic_user_id || (!seller.reonic_team_optional && !team?.leader_ids.length)));
        const choice = assignmentChoice(lead,p.partner_id);
        return (quick ? '<section class="record"><strong>' : '<details class="record"><summary>') + (index+1) + ". " + esc(p.full_name) + " · " +
          p.distance_km.toLocaleString("de-DE",{maximumFractionDigits:2}) + " km Luftlinie · " + (p.driveKm?.toLocaleString("de-DE",{maximumFractionDigits:1}) ?? "—") +
          " km Fahrtweg · ca. " + (p.driveMinutes == null ? "—" : Math.round(p.driveMinutes)) + " Min. Fahrzeit · Priorität " + p.priority + (quick ? '</strong>' : '</summary>') +
          (lead.reonic_project_id ? "<p>" + (team ? "Reonic-Team: " + esc(team.name) : seller?.reonic_team_optional ? "Zuweisung ohne Team" : "Bitte beim Berater zuerst ein Reonic-Team auswählen.") + "</p>" : "") +
          (needsTeam ? "" : fields("assign", '<input type="hidden" name="partner_id" value="' + esc(p.partner_id) + '">' + choice, "Lead zuweisen",id)) + (quick ? '</section>' : '</details>');
      }).join("") + "</div>" : "<p>Keine passenden Verkäufer gefunden. Prüfe Freigabe, Standort-PLZ und Einsatzradien.</p>") + (unavailable ? "<p>Für " + unavailable + " geeignete Vertriebspartner war kein Fahrtweg abrufbar.</p>" : "") + (quick ? '<details class="quick-manual"><summary>Anderen Vertriebspartner suchen</summary>' + manualPartnerForm(lead) + '</details></div></div>' : manualPartnerForm(lead));
    bindOrderChoices(target);
    const manual = target.querySelector('[data-manual-search]');
    if (manual) {
      const partnerSelect = manual.form.elements.partner_id;
      partnerSelect.required = true;
      const allOptions = Array.from(partnerSelect.options);
      manual.addEventListener("input", () => {
        const query = manual.value.trim().toLocaleLowerCase("de");
        const selected = partnerSelect.value;
        partnerSelect.replaceChildren(...allOptions.filter(option =>
          !option.value || option.textContent.toLocaleLowerCase("de").includes(query)));
        partnerSelect.value = Array.from(partnerSelect.options).some(option => option.value === selected) ? selected : "";
      });
    }
    const contact = await contactLookup;
    if (contact && isCurrent()) {
      const extra = [contact.address,contact.city,contact.email === lead.email ? null : contact.email,contact.phone === lead.phone ? null : contact.phone];
      target.querySelector("[data-contact]").innerHTML = extra.filter(Boolean).map(value => "<span>" + esc(value) + "</span>").join("");
    }
  } catch (error) {
    if (!isCurrent()) return;
    target.innerHTML = "<p>" + esc("Vorschläge konnten nicht geladen werden. " + error.message) + "</p>" +
      (quick ? btn("Weiter →", 'data-command="focus-next"') : "");
  }
}

async function sync() {
  const {data: result,error} = await client.functions.invoke("reonic-sync-users",{body:{}});
  if (error) {
    const details = await error.context?.json?.().catch(() => null);
    throw Error(details?.error ? details.error + (details.status ? " (HTTP " + details.status + ")." : "") : error.message);
  }
  if (!result?.success) throw Error("Reonic hat keinen erfolgreichen Abruf bestätigt.");
  syncError = "";
  return result;
}
document.addEventListener("input",event => {
  if (!event.target.matches("[data-search]")) return;
  filter[view] = event.target.value;
  renderRecords();
});
$("workspace").addEventListener("change",event => {
  const fields = {"lead-status":"status","order-sort":"orderSort","order-supplier":"orderSupplier","partner-postal-view":"partnerPostalView"};
  const field = fields[event.target.id];
  if (!field) return;
  filter[field] = event.target.value;
  if (field === "partnerPostalView") render();
  else renderRecords();
});
document.addEventListener("click",async event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.view) { view = button.dataset.view; message(""); render(); }
  if (button.dataset.command === "partner-intake") {
    filter.partnerPostalView = filter.partnerPostalView === "without" ? "with" : "without";
    filter.partners = "";
    render();
  }
  if (button.dataset.command === "requests") await importRequests(true);
  if (button.dataset.command === "retry-reonic") {
    button.disabled = true;
    try {
      await reonicRequests({action:"assign",lead_id:button.dataset.id});
      message("Berater und Team wurden in Reonic gespeichert.");
    } catch(error) { message(error.message); }
    finally { button.disabled = false; await refresh(); }
  }
  if (button.dataset.command === "new-lead") $("new-lead").hidden = !$("new-lead").hidden;
  if (["open-leads","assigned-leads","lead-list","quick"].includes(button.dataset.command)) {
    leadTab = button.dataset.command === "assigned-leads" ? "assigned" : "open";
    leadMode = button.dataset.command === "quick" ? "focus" : "list";
    filter.status = "";
    focusId = null;
    render();
  }
  if (!saving && button.dataset.command === "focus-prev") await advanceQuick(-1);
  if (!saving && button.dataset.command === "focus-next") await advanceQuick(1);
  if (button.dataset.command === "suggest") await suggest(button.dataset.id);
  if (button.dataset.command === "sync") {
    button.disabled = true;
    message("Reonic wird synchronisiert …");
    try { await refreshReonic(); } catch(error) { syncError = error.message; message("Reonic: " + syncError); render(); }
    finally { button.disabled = false; }
  }
});
let saving = false;
document.addEventListener("submit",async event => {
  const form = event.target;
  if (!form.matches("[data-action]")) return;
  event.preventDefault();
  if (saving) return;
  const values = formData(form);
  const action = form.dataset.action;
  saving = true;
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const quick = action === "assign" && Boolean(form.closest("#lead-focus"));
    if (quick) {
      const queue = focusQueue();
      const i = queue.findIndex(l => l.id === form.dataset.id);
      focusId = queue[i + 1]?.id || queue[i - 1]?.id || null;
    }
    await save(action,values,form.dataset.id);
    const dialog = $("suggestions");
    if (action === "assign" && !quick) dialog.close();
    message(action === "assign" ? "Lead zugewiesen." : "Gespeichert.");
    await refresh();
  } catch(error) {
    if (action === "assign") {
      const dialog = $("suggestions");
      if (form.closest("#lead-focus")) {
        focusId = form.dataset.id;
        message(error.message);
      } else if (dialog.open && dialog.dataset.quick === "true") {
        const notice = document.createElement("p");
        notice.setAttribute("role", "alert");
        notice.textContent = error.message;
        $("suggest-content").prepend(notice);
      } else {
        dialog.close();
        message(error.message);
      }
      await refresh();
    }
    else message(error.message);
  } finally {
    saving = false;
    if (button) button.disabled = false;
  }
});


const loginStatus = text => { $("login-status").textContent = text; };
const login = $("login");
const homepage = location.origin + location.pathname;
const initialLogin = login.innerHTML;

function lock(text) {
  refreshVersion++;
  data = null;
  $("workspace").replaceChildren();
  $("app").hidden = true;
  $("gb-connect").hidden = false;
  if ($("suggestions").open) $("suggestions").close();
  loginStatus(text);
}
async function open(session) {
  if (!session) { lock("Bitte als Administrator anmelden."); return; }
  const result = await client.from("app_admins").select("user_id").eq("user_id",session.user.id).maybeSingle();
  if (result.error || !result.data) {
    lock(result.error ? "Admin-Freigabe konnte nicht geprüft werden." : "Dieses Konto ist für das Dashboard nicht freigeschaltet.");
    return;
  }
  $("gb-connect").hidden = true;
  $("app").hidden = false;
  $("connection").textContent = "Supabase wird geprüft …";
  message("");
  await refresh();
  void refreshReonic();
}
function showRecovery() {
  recovery = true;
  lock("Wähle ein neues Passwort.");
  login.innerHTML = '<div class="gb-brand">G.B</div><h2>Passwort zurücksetzen</h2>' +
    input("Neues Passwort", "new_password", "", 'type="password" autocomplete="new-password" minlength="8" required') +
    input("Passwort wiederholen", "confirm_password", "", 'type="password" autocomplete="new-password" minlength="8" required') +
    '<div class="gb-actions"><button>Passwort speichern</button></div><p id="login-status" role="status">Wähle ein neues Passwort.</p>';
}
login.addEventListener("submit",async event => {
  event.preventDefault();
  if (!client) return;
  const values = formData(login);
  const submitting = event.submitter;
  submitting.disabled = true;
  try {
    if (recovery) {
      if (values.new_password !== values.confirm_password) throw Error("Die Passwörter stimmen nicht überein.");
      fail((await client.auth.updateUser({password:values.new_password})).error);
      await client.auth.signOut({scope:"local"});
      recovery = false;
      login.innerHTML = initialLogin;
      history.replaceState(null,"",homepage);
      lock("Passwort gespeichert. Bitte erneut anmelden.");
      return;
    }
    loginStatus("Anmeldung wird geprüft …");
    const result = await client.auth.signInWithPassword({email:values.email.trim(),password:values.password});
    login.elements.password.value = "";
    if (result.error) throw Error("Anmeldung fehlgeschlagen. Prüfe E-Mail und Passwort.");
    await open(result.data?.session);
  } catch (error) { loginStatus(error.message); }
  finally { submitting.disabled = false; }
});
login.addEventListener("click",async event => {
  if (event.target.id !== "reset" || !client) return;
  const email = login.elements.email;
  if (!email.value || !email.reportValidity()) { loginStatus("Bitte zuerst deine E-Mail-Adresse eingeben."); email.focus(); return; }
  try {
    fail((await client.auth.resetPasswordForEmail(email.value.trim(),{redirectTo:homepage})).error);
    loginStatus("Falls das Konto existiert, erhältst du einen Link per E-Mail.");
  } catch { loginStatus("Der Passwort-Link konnte gerade nicht angefordert werden."); }
});
$("logout").addEventListener("click",async () => {
  const {error} = await client.auth.signOut({scope:"local"});
  if (error) { message("Abmeldung fehlgeschlagen. Bitte erneut versuchen."); return; }
  lock("Abgemeldet.");
});
$("reload").addEventListener("click",async () => {
  await refreshReonic();
});
async function init() {
  if (!window.supabase?.createClient) { lock("Die Anmeldung konnte nicht geladen werden. Bitte die Seite neu laden."); return; }
  client = window.supabase.createClient("https://ndwoogyptnlqjitnowsu.supabase.co","sb_publishable_vRr4Bz882fk1bcsaJ8hmyw_lM5DYN1A");
  const params = new URLSearchParams(location.hash.slice(1));
  const recoveryLink = params.get("type") === "recovery";
  const authLinkError = params.has("error_code");
  client.auth.onAuthStateChange(event => {
    if (event === "PASSWORD_RECOVERY" && !recovery) showRecovery();
    if (event === "SIGNED_OUT" && !$("app").hidden) lock("Bitte erneut anmelden.");
  });
  const result = await client.auth.getSession();
  if (recovery) return;
  if (recoveryLink && result.data.session && !result.error) { showRecovery(); return; }
  if (recoveryLink || authLinkError) {
    history.replaceState(null,"",homepage);
    lock("Der Passwort-Link ist ungültig oder abgelaufen. Bitte einen neuen Link anfordern.");
    return;
  }
  await open(result.data.session);
}
init().catch(() => lock("Die Anmeldung konnte nicht vorbereitet werden. Bitte die Seite neu laden."));
