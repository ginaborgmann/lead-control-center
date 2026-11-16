import { createClient } from "npm:@supabase/supabase-js@2.89.0";

const allowedOrigin = "https://ginaborgmann.github.io";
const cors = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Cache-Control": "no-store",
};
const reply = (body: object, status = 200) => Response.json(body, { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply({ error: "Methode nicht erlaubt." }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return reply({ error: "Bitte anmelden." }, 401);
  const options = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
  const url = Deno.env.get("SUPABASE_URL")!;
  try {
    const client = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: options, global: { headers: { Authorization: auth } },
    });
    const { data: { user }, error } = await client.auth.getUser(auth.slice(7));
    if (error || !user) return reply({ error: "Bitte erneut anmelden." }, 401);
    const { data: admin, error: checkError } = await client
      .from("app_admins").select("user_id").eq("user_id", user.id).maybeSingle();
    if (checkError) return reply({ error: "Admin-Freigabe konnte nicht geprüft werden." }, 503);
    if (!admin) return reply({ error: "Admin-Freigabe fehlt." }, 403);

    const apiKey = Deno.env.get("REONIC_API_KEY");
    if (!apiKey) return reply({ error: "Der Reonic-Schlüssel fehlt in Supabase." }, 500);
    const body = await req.json();
    const headers = { "X-Authorization": apiKey, Accept: "application/json" };
    const api = async (path: string, payload?: object) => {
      const result = await fetch("https://api.reonic.com/rest/v3/" + path, {
        headers: { ...headers, "Content-Type": "application/json" },
        method: payload ? "POST" : "GET", body: payload ? JSON.stringify(payload) : undefined,
        redirect: "error", signal: AbortSignal.timeout(15000),
      });
      if (!result.ok) throw Error("Reonic meldet HTTP " + result.status + " für " + path.split(/[/?]/)[0] + ".");
      return result.json();
    };
    const page = Number(body.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 1000) return reply({error:"Ungültige Seite."},400);
    const boards = await api("kanbanBoards?projectDomain=residential&projectStage=request");
    if (!Array.isArray(boards.data) || boards.pagination?.next) throw Error("Reonic-Anfragen-Boards konnten nicht vollständig gelesen werden.");
    const monitored = /^(neueanfragen|leadnichterreicht(12|34|56|79|912))$/;
    const columns = new Map<string,string>();
    for (const board of boards.data) {
      if (board.archivedAt) continue;
      for (const column of board.columns || []) {
        const key = column.name.toLowerCase().replace(/[^a-z0-9]/g,"");
        if (!column.archivedAt && monitored.test(key)) columns.set(column.id,column.name);
      }
    }
    if (!columns.size || columns.size > 50) throw Error("Die überwachten Anfragen-Spalten konnten nicht gelesen werden.");
    const query = new URLSearchParams({stage:"request",kanbanColumnIds:[...columns.keys()].join(","),itemsPerPage:"8",page:String(page)});
    const projects = await api("residentialProjects?" + query);
    if (!Array.isArray(projects.data) || !projects.pagination) throw Error("Reonic lieferte keine vollständige Seite mit Anfragen.");
    const rows = await Promise.all(projects.data.map(async (project: Project) => {
      const base = {
        id:project.id, name:project.customerContact?.fullName || project.name || "Anfrage",
        column:columns.get(project.kanbanColumnId) || "Anfrage",
        owner:project.keyAccountManagerId || null,
      };
      try {
        const parent = new URLSearchParams({parentType:"residentialProject",parentId:project.id,itemsPerPage:"200"});
        const [notes,activities,assigned] = await Promise.all([
          api("notes?" + parent + "&sort=-createdAt"),
          api("activities/manual?" + parent),
          client.from("leads").select("lead_assignments(reonic_synced_at,sales_partners(reonic_user_id))")
            .eq("reonic_project_id",project.id).maybeSingle(),
        ]);
        if (assigned.error || !Array.isArray(notes.data) || !Array.isArray(activities.data)) throw Error("Verlauf unvollständig.");
        const events = [
          ...notes.data.map((entry: Entry) => ({at:entry.createdAt,kind:"Notiz",call:/^(?:ne|nicht erreicht)\b|\banruf(?:versuch)?\b|\bangerufen\b/i.test(entry.text?.trim() || ""), reached:false})),
          ...activities.data.map((entry: Entry) => ({at:entry.createdAt,kind:entry.type === "call" ? "Anruf" : "Termin", call:entry.type === "call",reached:entry.type === "call" && ["connectedSuccessfulDiscussion","connectedNeedsFollowup"].includes(entry.outcome || "")})),
        ].filter(entry => Number.isFinite(Date.parse(entry.at))).sort((a,b) => b.at.localeCompare(a.at));
        const stored = assigned.data?.lead_assignments;
        const assignment = Array.isArray(stored) ? stored[0] : stored;
        const seller = assignment?.sales_partners;
        const owner = Array.isArray(seller) ? seller[0] : seller;
        const assignedAt = base.owner && owner?.reonic_user_id === base.owner ? assignment?.reonic_synced_at : null;
        return {...base,assignedAt,createdAt:project.requestCreatedAt || project.projectCreatedAt,
          complete:!notes.pagination?.next && !activities.pagination?.next,events};
      } catch {
        return {...base,unavailable:true,events:[]};
      }
    }));
    return reply({rows,next:Boolean(projects.pagination.next),columns:[...new Set(columns.values())]});
  } catch (error) {
    return reply({error:error instanceof Error ? error.message : "Reonic-Abruf fehlgeschlagen."},502);
  }
});

type Project = {id:string; name?:string; customerContact?:{fullName?:string}; kanbanColumnId:string;
  keyAccountManagerId?:string; requestCreatedAt?:string; projectCreatedAt?:string};
type Entry = {createdAt:string; text?:string; type?:string; outcome?:string};
