import { createClient } from "npm:@supabase/supabase-js@2.89.0";

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
    const started = new Date().toISOString();
    const response = await fetch("https://api.reonic.com/rest/v3/users", {
      headers: { "X-Authorization": apiKey, Accept: "application/json", "Reonic-Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15000), redirect: "error",
    });
    if (!response.ok) return reply({ error: "Reonic hat den Abruf abgelehnt.", status: response.status }, 502);
    const result = await response.json();
    if (!Array.isArray(result.data) || result.pagination?.next ||
        result.data.some((u: ReonicUser) => !u || typeof u.id !== "string" || !u.id.trim())) {
      return reply({ error: "Reonic hat keine vollständige Benutzerliste geliefert." }, 502);
    }
    const users = (result.data as ReonicUser[])
      .filter(u => !u.archivedAt && !u.deletedAt)
      .map(u => ({
        reonic_id: u.id,
        name: u.fullName?.trim() || "Unbenannter Benutzer",
        email: u.email || null,
        phone: u.phone || null,
        is_external: Boolean(u.isExternal),
      }));
    if (new Set(users.map(u => u.reonic_id)).size !== users.length) {
      return reply({ error: "Reonic hat doppelte Benutzer-IDs geliefert." }, 502);
    }
    const server = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: options });
    const { data: applied, error: syncError } = await server.rpc("apply_reonic_users", {
      p_users: users, p_started: started,
    });
    if (syncError) {
      console.error("Reonic sync database error", syncError.code);
      return reply({ error: "Verkäufer konnten nicht gespeichert werden." }, 500);
    }
    return reply({ success: true, applied, count: users.length, users });
  } catch {
    return reply({ error: "Reonic konnte nicht erreicht oder die Antwort nicht verarbeitet werden." }, 502);
  }
});
