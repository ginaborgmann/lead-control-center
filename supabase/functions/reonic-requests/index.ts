import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.89.0";

const allowedOrigin = "https://ginaborgmann.github.io";
const cors = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Cache-Control": "no-store",
};
const reply = (body: object, status = 200) => Response.json(body, { status, headers: cors });

type ReonicUser = {
  id: string;
  fullName?: string;
  email?: string;
  phone?: string;
  isExternal?: boolean;
  archivedAt?: string;
  deletedAt?: string;
};

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
    const server = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: options });
    const body = await req.json();
    const headers = { "X-Authorization": apiKey, Accept: "application/json", "Reonic-Cache-Control": "no-cache" };
    const api = async (path: string, payload?: object) => {
      const result = await fetch("https://api.reonic.com/rest/v3/" + path, {
        headers: { ...headers, "Content-Type": "application/json" },
        method: payload ? "POST" : "GET", body: payload ? JSON.stringify(payload) : undefined,
        redirect: "error", signal: AbortSignal.timeout(15000),
      });
      if (!result.ok) throw Error("Reonic meldet HTTP " + result.status + " für " + path.split(/[/?]/)[0] + ".");
      return result.json();
    };
    async function requestScope() {
      const [columns, sources] = await Promise.all([api("kanbanColumns"),api("leadSources")]);
      if (!Array.isArray(columns.data) || !Array.isArray(sources.data) ||
          columns.pagination?.next || sources.pagination?.next) {
        throw Error("Reonic hat die Spalten oder Lead-Quellen nicht vollständig geliefert.");
      }
      const normalize = (label: string) => label.toLocaleLowerCase("de-DE").replace(/[^a-z0-9]/g,"");
      const newColumns = columns.data.filter((c: {name:string;archivedAt?:string}) =>
        !c.archivedAt && normalize(c.name) === "neueanfragen").map((c: {id:string}) => c.id);
      const activeSources = sources.data.filter((source: {archivedAt?: string}) => !source.archivedAt)
        .map((source: {id:string;name:string}) => ({id:source.id,name:source.name}));
      const labels = new Map<string,string>([["leadnodes","Leadnodes"],["betterbusiness","Better Business"]]);
      const sourceLabels = new Map<string,string>();
      for (const source of sources.data) {
        const label = labels.get(normalize(source.name));
        if (!source.archivedAt && label) sourceLabels.set(source.id,label);
      }
      if (!newColumns.length || new Set(sourceLabels.values()).size !== labels.size) {
        throw Error("Reonic: „Neue Anfragen“, „Leadnodes“ oder „Better Business“ konnte nicht eindeutig gefunden werden.");
      }
      return {newColumns,sourceLabels,activeSources};
    }
    if (body.action === "sync") {
      const teams = await api("teams");
      if (!Array.isArray(teams.data) || teams.pagination?.next ||
          teams.data.some((team: {id?: unknown; name?: unknown}) => typeof team.id !== "string" || typeof team.name !== "string")) {
        throw Error("Reonic hat keine vollständige Teamliste geliefert.");
      }
      const teamRows = teams.data.map((team: {id: string; name: string; archivedAt?: string}) =>
        ({id:team.id,name:team.name,active:!team.archivedAt}));
      if (teamRows.length) db(await server.from("reonic_teams").upsert(teamRows));
      const prior = db(await server.from("reonic_teams").select("id").eq("active",true));
      const seen = new Set(teamRows.map((team: {id:string}) => team.id));
      const missing = prior.filter((team: {id:string}) => !seen.has(team.id)).map((team: {id:string}) => team.id);
      if (missing.length) db(await server.from("reonic_teams").update({active:false}).in("id",missing));

      const {newColumns,sourceLabels,activeSources} = await requestScope();
      const supplierCount = db(await server.rpc("sync_reonic_lead_sources",{p_sources:activeSources}));
      const ids = new Set<string>();
      const searches = [
        {columns:"null", sources:null},
        ...newColumns.map((id: string) => ({columns:id,sources:[...sourceLabels.keys()].join(",")})),
      ];
      for (const search of searches) {
        let complete = false;
        for (let page = 1; page <= 100; page++) {
          const query = new URLSearchParams({stage:"request",kanbanColumnIds:search.columns,assignedUserIds:"null",
            keyAccountManagerIds:"null",itemsPerPage:"200",page:String(page)});
          if (search.sources) query.set("leadSourceIds",search.sources);
          const projects = await api("residentialProjects?" + query);
          if (!Array.isArray(projects.data) || !projects.pagination ||
              projects.data.some((project: {id?:unknown}) => typeof project.id !== "string")) {
            throw Error("Die Reonic-Anfragen konnten nicht vollständig gelesen werden.");
          }
          const rows = projects.data.map((project: {
            id:string; name?:string; leadSourceId?:string; address?:{postcode?:string}; customerContact?:{fullName?:string; primaryEmail?:string}
          }) => ({
            reonic_project_id:project.id, customer_name:(project.customerContact?.fullName?.trim() || project.name?.trim() || "Reonic-Anfrage").slice(0,250),
            postal_code:/^\d{5}$/.test(project.address?.postcode || "") ? project.address?.postcode : null,
            email:project.customerContact?.primaryEmail || null, source:search.sources ? "Reonic · Neue Anfragen · " + sourceLabels.get(project.leadSourceId || "") : "Reonic · Ohne Status",
          }));
          if (rows.length) db(await server.from("leads").upsert(rows,{onConflict:"reonic_project_id"}));
          for (const row of rows) ids.add(row.reonic_project_id);
          if (!projects.pagination.next) { complete = true; break; }
        }
        if (!complete) throw Error("Der Abruf hat die maximale Seitenzahl erreicht. Bitte Reonic-Anfragen prüfen.");
      }
      db(await server.rpc("reconcile_reonic_queue",{p_ids:[...ids]}));
      return reply({success:true,count:ids.size,suppliers:supplierCount,teams:teamRows.filter((team:{active:boolean})=>team.active).length});
    }
    if (body.action === "contact" && typeof body.lead_id === "string") {
      const lead = db(await server.from("leads").select("reonic_project_id").eq("id",body.lead_id).single());
      if (!lead.reonic_project_id) return reply({error:"Kein Reonic-Kontakt verfügbar."},404);
      const project = await api("residentialProjects/" + encodeURIComponent(lead.reonic_project_id));
      const contactId = project.customerContact?.id;
      if (!contactId) return reply({contact:null});
      const contact = await api("contacts/" + encodeURIComponent(contactId));
      return reply({contact:{
        name:contact.fullName, email:contact.primaryEmail, phone:contact.mobile || contact.phone,
        address:[project.address?.street,project.address?.houseNumber].filter(Boolean).join(" "),
        city:project.address?.city,
      }});
    }
    if (body.action !== "assign" || typeof body.lead_id !== "string") return reply({error:"Ungültige Aktion."},400);
    const lead = db(await server.from("leads").select("id,reonic_project_id").eq("id",body.lead_id).single());
    if (!lead.reonic_project_id) return reply({error:"Diese Anfrage stammt nicht aus Reonic."},400);
    const path = "residentialProjects/" + encodeURIComponent(lead.reonic_project_id);
    let assignment = await readAssignment(server,lead.id);
    if (assignment?.reonic_synced_at) return reply({success:true});
    let project = await api(path);
    if (!Array.isArray(project.assignedUserIds) || !Array.isArray(project.assignedTeamIds)) {
      throw Error("Reonic hat die aktuellen Zuweisungen der Anfrage nicht vollständig geliefert.");
    }
    if (!assignment) {
      if (!body.partner_id) return reply({error:"Bitte einen Berater auswählen."},400);
      if (project.archivedAt || project.stage !== "request" || project.keyAccountManagerId || project.assignedUserIds.length) {
        return reply({error:"Die Anfrage ist in Reonic nicht mehr offen und ohne Berater."},409);
      }
      if (project.kanbanColumnId) {
        const scope = await requestScope();
        if (!scope.newColumns.includes(project.kanbanColumnId) || !scope.sourceLabels.has(project.leadSourceId)) {
          return reply({error:"Die Anfrage gehört nicht mehr zu den ausgewählten Reonic-Spalten und Quellen."},409);
        }
      }
      const result = await server.rpc("reserve_reonic_assignment",{
        p_lead:lead.id,p_partner:body.partner_id,p_order:body.order_id || null,p_actor:user.id,p_manual:body.manual === "true",
      });
      assignment = await readAssignment(server,lead.id);
      if (!assignment) throw Error(result.error?.message || "Die Zuweisung konnte nicht gespeichert werden.");
      if (assignment.partner_id !== body.partner_id) return reply({error:"Die Anfrage wurde bereits einem anderen Berater zugewiesen."},409);
    }
    const partner = db(await server.from("sales_partners").select("reonic_user_id,active,reonic_present")
      .eq("id",assignment.partner_id).single());
    if (!partner.active || !partner.reonic_present || !partner.reonic_user_id) {
      throw Error("Der reservierte Berater ist in Reonic nicht mehr verfügbar.");
    }
    if ((project.keyAccountManagerId && project.keyAccountManagerId !== partner.reonic_user_id) ||
        project.assignedUserIds.some((id: string) => id !== partner.reonic_user_id)) {
      throw Error("Die Anfrage wurde inzwischen in Reonic einem anderen Berater zugewiesen.");
    }
    const userIds = [partner.reonic_user_id];
    const teamIds = [...new Set([...project.assignedTeamIds,assignment.reonic_team_id])];
    if (!project.assignedUserIds.includes(userIds[0]) || !project.assignedTeamIds.includes(assignment.reonic_team_id)) {
      project = await api(path + "/update",{assignedUserIds:userIds,assignedTeamIds:teamIds});
      if (!project.assignedUserIds?.includes(userIds[0]) || !project.assignedTeamIds?.includes(assignment.reonic_team_id)) {
        project = await api(path);
      }
      if (!project.assignedUserIds?.includes(userIds[0]) || !project.assignedTeamIds?.includes(assignment.reonic_team_id)) {
        throw Error("Reonic hat Berater und Team noch nicht bestätigt. Bitte erneut übertragen.");
      }
    }
    db(await server.from("lead_assignments").update({reonic_synced_at:new Date().toISOString()}).eq("lead_id",lead.id));
    return reply({success:true});
  } catch (error) {
    return reply({error:error instanceof Error ? error.message : "Reonic konnte nicht verarbeitet werden."},502);
  }
});

function db<T>(result: {data:T; error:{code?:string} | null}): NonNullable<T> {
  if (result.error) {
    console.error("Reonic requests database error",result.error.code);
    throw Error("Supabase konnte die Anfrage nicht speichern oder lesen.");
  }
  return result.data as NonNullable<T>;
}

async function readAssignment(server: SupabaseClient, id:string) {
  return db(await server.from("lead_assignments").select("partner_id,reonic_team_id,reonic_synced_at").eq("lead_id",id).maybeSingle());
}
