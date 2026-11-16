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
      if (result.status === 429) throw new ReonicLimit(Math.max(1,Number(result.headers.get("Retry-After")) || 60));
      if (!result.ok) throw Error("Reonic meldet HTTP " + result.status + " für " + path.split(/[/?]/)[0] + ".");
      return result.json();
    };
    const page = Number(body.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 1000) return reply({error:"Ungültige Seite."},400);
    const boards = await api("kanbanBoards?projectDomain=residential&projectStage=request");
    if (!Array.isArray(boards.data) || boards.pagination?.next) throw Error("Reonic-Anfragen-Boards konnten nicht vollständig gelesen werden.");

    const columns = new Map<string,string>();
    for (const board of boards.data) {
      if (board.archivedAt) continue;
      for (const column of board.columns || []) {
        const name = column.name.toLowerCase().replace(/[^a-z0-9]/g,"");
        if (!column.archivedAt && /^(neueanfragen|leadnichterreicht(12|34|45|56|79|912))$/.test(name)) {
          columns.set(column.id,column.name);
        }
      }
    }
    if (!columns.size || columns.size > 50) throw Error("Die Anfragen-Spalten konnten nicht eindeutig gelesen werden.");
    const cutoff = Date.now() - 5 * 86400000;
    const query = new URLSearchParams({
      stage:"request",kanbanColumnIds:[...columns.keys()].join(","),
      "updatedAt.lt":new Date(Math.ceil(cutoff/60000)*60000).toISOString(),itemsPerPage:"100",page:String(page),
    });
    const projects = await api("residentialProjects?" + query);
    if (!Array.isArray(projects.data) || !projects.pagination) throw Error("Reonic lieferte keine vollständige Seite.");
    const rows = projects.data.flatMap((p: {
      id:string; keyAccountManagerId?:string; kanbanColumnId:string; updatedAt?:string;
    }) => {
      const changedAt = Date.parse(p.updatedAt || "");
      const column = columns.get(p.kanbanColumnId);
      if (!p.keyAccountManagerId || !column || !Number.isFinite(changedAt) || changedAt >= cutoff) return [];
      return [{id:p.id,owner:p.keyAccountManagerId,column,changedAt:p.updatedAt}];
    });
    return reply({rows,next:Boolean(projects.pagination.next)});
  } catch (error) {
    if (error instanceof ReonicLimit) return reply({retryAfter:error.seconds});
    return reply({error:error instanceof Error ? error.message : "Reonic-Abruf fehlgeschlagen."},502);
  }
});

class ReonicLimit extends Error {
  constructor(public seconds: number) { super("Reonic-Abruflimit erreicht."); }
}
