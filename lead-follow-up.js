"use strict";

const followUp = {
  rows: null, busy: false, error: "", loaded: null, nextPage: 1,
};
function followUpView() {
  const byAdviser = new Map();
  for (const row of followUp.rows || []) {
    byAdviser.set(row.owner,(byAdviser.get(row.owner) || 0) + 1);
  }
  const advisers = [...byAdviser].map(([id,count]) => ({
    name:data.partners.find(p => p.reonic_user_id === id)?.full_name || "Unbekannter Key-Account",count,
  })).sort((a,b) => b.count-a.count || a.name.localeCompare(b.name,"de"));
  const notices = advisers.map(({name,count}) => '<li><strong>' + esc(name) + '</strong> · ' +
    count + (count === 1 ? ' auffälliger Lead' : ' auffällige Leads') + '</li>').join("");
  const status = followUp.busy ? (followUp.waiting ? "Reonic setzt den Abruf gleich fort …" : "Reonic-Anfragen werden geprüft …") :
    followUp.loaded ? advisers.length + " auffällige Vertriebler · Stand " + date(followUp.loaded) : "";
  return panel('<h2>Lead-Abarbeitung</h2><p>Vertriebler mit Anfragen in den überwachten Spalten, die seit mehr als fünf Tagen in Reonic unverändert sind.</p>' +
    btn(followUp.busy ? "Reonic wird gelesen …" : followUp.nextPage > 1 && !followUp.loaded ? "Abruf fortsetzen" : "Liste aktualisieren",
      'data-command="follow-up-refresh"' + (followUp.busy ? ' disabled' : '')) +
    '<p role="status">' + esc(status) + '</p>' +
    (followUp.error ? '<p role="alert">' + esc(followUp.error) + '</p>' : '') +
    (notices ? '<ul class="record">' + notices + '</ul>' : followUp.loaded ? '<p>Aktuell keine auffälligen Vertriebler.</p>' : ''));
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
      await pause(500);
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
