"use strict";

const followUp = {
  rows: null, busy: false, error: "", loaded: null, nextPage: 1,
};
const adviserNotes = new Map();
const adviserDrafts = new Map();
const openAdviserNotes = new Set();
const adviserNotesSaving = new Set();
let adviserNotesError = "";

function adviserNote(id,name) {
  const saved = adviserNotes.get(id);
  return '<details class="adviser-note" data-adviser-note="' + esc(id) + '"' +
    (openAdviserNotes.has(id) ? ' open' : '') + '><summary>Notiz' + (saved?.note ? ' vorhanden' : '') + '</summary>' +
    '<form data-adviser-note-form="' + esc(id) + '"><label>Notiz zu ' + esc(name) +
    '<textarea name="note" rows="3" maxlength="4000">' + esc(adviserDrafts.get(id) ?? saved?.note ?? "") + '</textarea></label>' +
    btn("Notiz speichern",adviserNotesSaving.has(id) ? "disabled" : "") +
    '<small role="status">' + (saved?.updated_at ? 'Gespeichert ' + esc(date(saved.updated_at)) : '') +
    '</small></form></details>';
}

async function loadAdviserNotes() {
  const {data:notes,error} = await client.from("follow_up_adviser_notes").select("reonic_user_id,note,updated_at");
  adviserNotesError = error ? "Gespeicherte Notizen konnten nicht geladen werden." : "";
  if (error) return;
  adviserNotes.clear();
  for (const note of notes) adviserNotes.set(note.reonic_user_id,note);
}

document.addEventListener("toggle",event => {
  const details = event.target;
  if (!details.matches?.("[data-adviser-note]") || !details.isConnected) return;
  const id = details.dataset.adviserNote;
  if (details.open) openAdviserNotes.add(id);
  else openAdviserNotes.delete(id);
},true);

document.addEventListener("input",event => {
  const form = event.target.closest?.("[data-adviser-note-form]");
  if (form) adviserDrafts.set(form.dataset.adviserNoteForm,event.target.value);
});

document.addEventListener("submit",async event => {
  const form = event.target;
  if (!form.matches("[data-adviser-note-form]")) return;
  event.preventDefault();
  const id = form.dataset.adviserNoteForm;
  if (adviserNotesSaving.has(id)) return;
  const note = form.elements.note.value.trim();
  adviserNotesSaving.add(id);
  form.querySelector("button").disabled = true;
  try {
    const {data:saved,error} = await client.from("follow_up_adviser_notes").upsert({
      reonic_user_id:id,note,updated_at:new Date().toISOString(),
    }).select("reonic_user_id,note,updated_at").single();
    if (error) throw error;
    adviserNotes.set(id,saved);
    if (adviserDrafts.get(id)?.trim() === note) adviserDrafts.delete(id);
    if (view === "follow-up") render();
  } catch {
    const current = [...document.querySelectorAll("[data-adviser-note-form]")].find(f => f.dataset.adviserNoteForm === id);
    if (current) current.querySelector("[role=status]").textContent = "Speichern fehlgeschlagen. Bitte erneut versuchen.";
  } finally {
    adviserNotesSaving.delete(id);
    const current = [...document.querySelectorAll("[data-adviser-note-form]")].find(f => f.dataset.adviserNoteForm === id);
    if (current) current.querySelector("button").disabled = false;
  }
});

function followUpView() {
  const byAdviser = new Map();
  for (const row of followUp.rows || []) {
    byAdviser.set(row.owner,(byAdviser.get(row.owner) || 0) + 1);
  }
  const advisers = [...byAdviser].map(([id,count]) => ({
    id,name:data.partners.find(p => p.reonic_user_id === id)?.full_name || "Unbekannter Key-Account",count,
  })).sort((a,b) => b.count-a.count || a.name.localeCompare(b.name,"de"));
  const notices = advisers.map(({id,name,count}) => '<li class="follow-up-adviser"><div><strong>' + esc(name) + '</strong> · ' +
    count + (count === 1 ? ' auffälliger Lead' : ' auffällige Leads') + '</div>' + adviserNote(id,name) + '</li>').join("");
  const status = followUp.busy ? (followUp.waiting ? "Reonic setzt den Abruf gleich fort …" : "Reonic-Anfragen werden geprüft …") :
    followUp.loaded ? advisers.length + " auffällige Vertriebler · Stand " + date(followUp.loaded) : "";
  return panel('<h2>Lead-Abarbeitung</h2><p>Vertriebler mit Anfragen in den überwachten Spalten, die seit mehr als fünf Tagen in Reonic unverändert sind.</p>' +
    btn(followUp.busy ? "Reonic wird gelesen …" : followUp.nextPage > 1 && !followUp.loaded ? "Abruf fortsetzen" : "Liste aktualisieren",
      'data-command="follow-up-refresh"' + (followUp.busy ? ' disabled' : '')) +
    '<p role="status">' + esc(status) + '</p>' +
    (adviserNotesError ? '<p role="alert">' + esc(adviserNotesError) + '</p>' : '') +
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
    await loadAdviserNotes();
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
