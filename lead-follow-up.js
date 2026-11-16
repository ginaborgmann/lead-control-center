"use strict";

const followUp = {
  rows: null, columns: [], busy: false, error: "", loaded: null,
  owner: "", onlyDue: false, nextPage: 1,
};
const followUpClock = new Intl.DateTimeFormat("de-DE", {
  timeZone:"Europe/Berlin", hour:"2-digit", minute:"2-digit", hourCycle:"h23"
});

function followUpWorkdays(from,to) {
  if (!Number.isFinite(Date.parse(from))) return null;
  const start = new Date(berlinDay(from) + "T00:00:00Z");
  const end = new Date(berlinDay(to) + "T00:00:00Z");
  const days = Math.round((end-start)/86400000);
  if (days <= 0) return 0;
  let weekdays = Math.floor(days/7)*5;
  for (let i=1; i<=days%7; i++) {
    const day = (start.getUTCDay()+i)%7;
    if (day > 0 && day < 6) weekdays++;
  }
  return weekdays;
}

function followUpStatus(lead,now) {
  if (lead.unavailable) return {short:"Verlauf nicht abrufbar",due:false};
  const latest = lead.events[0];
  const age = followUpWorkdays(latest?.at || lead.assignedAt || lead.createdAt,now);
  const reasons = [];
  if (age > 3) reasons.push(latest ? "Nachfassen fällig" : "Keine Bearbeitung dokumentiert");
  if (lead.assignedAt && lead.complete && followUpWorkdays(lead.assignedAt,now) > 2) {
    const calls = lead.events.filter(e => e.call && Date.parse(e.at) >= Date.parse(lead.assignedAt) &&
      followUpWorkdays(lead.assignedAt,e.at) <= 2).reverse();
    const attempts = calls.filter((call,index) => index === 0 || Date.parse(call.at)-Date.parse(calls[index-1].at) >= 5*60000);
    if (!calls.some(call => call.reached) && new Set(attempts.map(call => followUpClock.format(new Date(call.at)))).size < 2) {
      reasons.push(attempts.length ? "Zweiter Anrufversuch nicht dokumentiert" : "Kein Anrufversuch bis zur Frist dokumentiert");
    }
  }
  return {short:reasons.join(" · ") || (latest ? "Im Verlauf dokumentiert" : "Noch kein Eintrag"),due:reasons.length>0,age};
}

function followUpOwner(id) {
  return id ? data.partners.find(p => p.reonic_user_id === id)?.full_name || "Unbekannter Key-Account" : "Ohne Key-Account";
}

function followUpView() {
  const rows = followUp.rows || [];
  const now = Date.now();
  const report = rows.map(row => ({...row,...followUpStatus(row,now)}));
  const groups = new Map();
  for (const row of report) {
    const key = row.owner || "unassigned";
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(row);
  }
  const owners = [...groups.keys()].sort((a,b) => followUpOwner(a).localeCompare(followUpOwner(b),"de"));
  const controls = '<div class="controls">' +
    btn(followUp.busy ? "Reonic wird gelesen …" : "Nachverfolgung aktualisieren",
      'data-command="follow-up-refresh"' + (followUp.busy ? ' disabled' : '')) +
    '<select id="follow-up-owner" aria-label="Key-Account">' +
    options([["","Alle Key-Accounts"],...owners.map(id => [id,followUpOwner(id === "unassigned" ? null : id)])],followUp.owner) +
    '</select><label><input type="checkbox" id="follow-up-due"' + (followUp.onlyDue ? ' checked' : '') +
    '> Nur Handlungsbedarf</label></div>';
  const summary = '<p role="status">' + (followUp.busy ? rows.length + " Anfragen geprüft …" :
    followUp.loaded ? rows.length + " Anfragen · " + report.filter(row=>row.due).length + " mit Handlungsbedarf · Stand " + date(followUp.loaded) :
    "Die ausgewählten Reonic-Anfragen werden beim Öffnen geprüft.") + '</p>';
  const sections = owners.filter(id => !followUp.owner || followUp.owner === id).map(id => {
    const group = groups.get(id);
    const visible = group.filter(row => !followUp.onlyDue || row.due)
      .sort((a,b) => Number(b.due)-Number(a.due) || (b.age ?? -1)-(a.age ?? -1) || a.name.localeCompare(b.name,"de"));
    if (!visible.length) return "";
    const title = esc(followUpOwner(id === "unassigned" ? null : id)) + " · " +
      group.filter(row=>row.due).length + " mit Handlungsbedarf / " + group.length + " Anfragen";
    return panel('<h3>' + title + '</h3><div class="table-wrap"><table><thead><tr><th>Lead</th><th>Reonic-Spalte</th><th>Letzter Eintrag</th><th>Stand</th></tr></thead><tbody>' +
      visible.map(row => '<tr><td><strong>' + esc(row.name) + '</strong>' +
        (row.events.length ? record("Verlauf",'<ul>' + row.events.slice(0,10).map(e=>'<li>' + esc(date(e.at)) + ' · ' + esc(e.kind) + (e.kind === "Notiz" && e.call ? ' (Anrufhinweis)' : '') + '</li>').join("") + '</ul>') : '') +
        '</td><td>' + esc(row.column) + '</td><td>' + (row.events[0] ? esc(date(row.events[0].at) + " · " + row.events[0].kind) : "—") +
        '</td><td><strong' + (row.due ? ' class="follow-up-overdue"' : '') + '>' + esc(row.short) + '</strong>' +
        (row.age != null ? '<br><small>' + row.age + ' Werktage</small>' : '') +
        (!row.assignedAt && !row.unavailable ? '<br><small>Zuweisungsdatum nicht verfügbar</small>' : '') +
        '</td></tr>').join("") + '</tbody></table></div>');
  });
  const unavailable = report.filter(row=>row.unavailable || !row.complete).length;
  return panel('<h2>Lead-Abarbeitung</h2>' + controls + summary +
    '<p class="muted">Nachfassen nach mehr als 3 Werktagen ohne Notiz oder Aktivität. Samstag und Sonntag zählen nicht.</p>' +
    (followUp.error ? '<p role="alert">' + esc(followUp.error) + '</p>' : '') +
    (unavailable ? '<p>' + unavailable + ' Verläufe fehlen oder sind unvollständig.</p>' : '')) +
    (sections.join("") || (!followUp.busy && followUp.rows ? panel('<p>Keine Anfragen für diese Auswahl.</p>') : ""));
}

async function loadFollowUp() {
  if (followUp.busy) return;
  followUp.busy = true;
  followUp.error = "";
  followUp.loaded = null;
  followUp.rows = [];
  if (view === "follow-up") render();
  try {
    const rows = new Map();
    for (let page=1; ; page++) {
      const response = await client.functions.invoke("reonic-follow-up",{body:{page}});
      if (response.error) {
        const details = await response.error.context?.json?.().catch(()=>null);
        throw Error(details?.error || response.error.message);
      }
      if ($("app").hidden) return;
      for (const row of response.data.rows) rows.set(row.id,row);
      followUp.rows = [...rows.values()];
      if (view === "follow-up") render();
      if (!response.data.next) break;
    }
    followUp.loaded = new Date().toISOString();
  } catch (error) {
    followUp.error = "Abruf unvollständig. " + error.message;
  } finally {
    followUp.busy = false;
    if (view === "follow-up" && !$("app").hidden) render();
  }
}

document.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (button?.dataset.command === "follow-up-refresh" ||
      (button?.dataset.view === "follow-up" && !followUp.rows)) void loadFollowUp();
});
document.addEventListener("change",event => {
  if (event.target.id === "follow-up-owner") followUp.owner = event.target.value;
  else if (event.target.id === "follow-up-due") followUp.onlyDue = event.target.checked;
  else return;
  render();
});
