"use strict";

const followUp = {
  rows: null, busy: false, error: "", loaded: null, nextPage: 1,
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
  if (lead.unavailable) return {short:"Verlauf nicht abrufbar" + (lead.missing?.length ? " (" + lead.missing.join(", ") + ")" : ""),due:false};
  const latest = lead.events[0];
  const age = followUpWorkdays(latest?.at || lead.assignedAt || lead.createdAt,now);
  const reasons = [];
  if (age > 3 && !lead.missing?.length) reasons.push(latest ? "Nachfassen fällig" : "Keine Bearbeitung dokumentiert");
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

function followUpView() {
  const rows = followUp.rows || [];
  const now = Date.now();
  const visible = rows.map(row => ({...row,...followUpStatus(row,now)}))
    .filter(row => row.due)
    .sort((a,b) => (b.age ?? -1)-(a.age ?? -1) || a.name.localeCompare(b.name,"de"));
  const controls = '<div class="controls">' +
    btn(followUp.busy ? "Reonic wird gelesen …" : followUp.nextPage > 1 && !followUp.loaded ? "Abruf fortsetzen" : "Nachverfolgung aktualisieren",
      'data-command="follow-up-refresh"' + (followUp.busy ? ' disabled' : '')) + '</div>';
  const status = followUp.busy ? rows.length + " Reonic-Anfragen geprüft …" +
    (followUp.waiting ? " Der Abruf läuft gleich weiter." : "") :
    followUp.loaded ? visible.length + " mit Handlungsbedarf · Stand " + date(followUp.loaded) :
    followUp.error ? rows.length + " Reonic-Anfragen geprüft · " + visible.length + " mit Handlungsbedarf" : "";
  const incomplete = rows.some(row => row.unavailable || !row.complete);
  const table = visible.length ? '<div class="table-wrap"><table><thead><tr><th>Lead</th><th>Reonic-Spalte</th><th>Letzter Eintrag</th><th>Handlungsbedarf</th></tr></thead><tbody>' +
    visible.map(row => '<tr><td><strong>' + esc(row.name) + '</strong>' +
      (row.events.length ? record("Verlauf",'<ul>' + row.events.slice(0,10).map(e => '<li>' + esc(date(e.at)) + ' · ' + esc(e.kind) + (e.kind === "Notiz" && e.call ? ' (Anrufhinweis)' : '') + '</li>').join("") + '</ul>') : '') +
      '</td><td>' + esc(row.column) + '</td><td>' + (row.events[0] ? esc(date(row.events[0].at) + " · " + row.events[0].kind) : "—") +
      '</td><td><strong class="follow-up-overdue">' + esc(row.short) + '</strong>' +
      (row.age != null ? '<br><small>' + row.age + ' Werktage</small>' : '') +
      '</td></tr>').join("") + '</tbody></table></div>' :
    followUp.loaded && !incomplete ? '<p>Aktuell kein Handlungsbedarf.</p>' : "";
  return panel('<h2>Lead-Abarbeitung</h2>' + controls + '<p role="status">' + esc(status) + '</p>' +
    (followUp.error ? '<p role="alert">' + esc(followUp.error) + '</p>' : '') +
    (incomplete ? '<p>Einige Reonic-Verläufe konnten nicht vollständig geprüft werden.</p>' : '') + table);
}

async function loadFollowUp() {
  if (followUp.busy) return;
  if (followUp.loaded || !followUp.rows) {
    followUp.rows = [];
    followUp.nextPage = 1;
  }
  followUp.busy = true;
  followUp.error = "";
  followUp.loaded = null;
  const deadline = Date.now() + 120000;
  const rows = new Map(followUp.rows.map(row => [row.id,row]));
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
  if (view === "follow-up") render();
  try {
    let retries = 0;
    while (!$("app").hidden && view === "follow-up") {
      const remaining = deadline - Date.now();
      if (remaining < 1000) throw Error("Das Zeitfenster ist erreicht. Klicke auf „Abruf fortsetzen“.");
      const response = await client.functions.invoke("reonic-follow-up",{
        body:{page:followUp.nextPage},signal:AbortSignal.timeout(Math.min(25000,remaining))
      });
      if ($("app").hidden || view !== "follow-up") return;
      if (response.error) {
        const details = await response.error.context?.json?.().catch(()=>null);
        throw Error(details?.error || response.error.message);
      }
      const batch = response.data;
      if (batch?.retryAfter) {
        const wait = (Number(batch.retryAfter) + 1)*1000;
        if (retries++ || Date.now() + wait + 1000 >= deadline) {
          throw Error("Reonic begrenzt den Abruf. Warte kurz und klicke dann auf „Abruf fortsetzen“.");
        }
        followUp.waiting = true;
        render();
        await pause(wait);
        followUp.waiting = false;
        continue;
      }
      if (!Array.isArray(batch?.rows) || typeof batch.next !== "boolean") throw Error("Reonic hat keine vollständige Antwort geliefert.");
      retries = 0;
      for (const row of batch.rows) rows.set(row.id,row);
      followUp.rows = [...rows.values()];
      if (!batch.next) {
        followUp.loaded = new Date().toISOString();
        return;
      }
      followUp.nextPage++;
      render();
      await pause(5000);
    }
  } catch (error) {
    followUp.error = "Abruf unvollständig. " + error.message;
  } finally {
    followUp.waiting = false;
    followUp.busy = false;
    if (view === "follow-up" && !$("app").hidden) render();
  }
}

document.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (button?.dataset.command === "follow-up-refresh" ||
      (button?.dataset.view === "follow-up" && !followUp.loaded && !followUp.error)) void loadFollowUp();
});
