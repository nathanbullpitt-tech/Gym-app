import type { Config, Context } from "@netlify/functions"
import { getDatabase } from "@netlify/database"
import { requireUser } from "../lib/auth.mts"

const db = getDatabase()
const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789"
const code = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => ALPHA[b % ALPHA.length]).join("")

export default async (req: Request, context: Context) => {
  const c = context.params.code

  if (req.method === "GET" && c) {
    const rows = await db.sql<{ kind: string; title: string; payload: unknown; created_at: string }>`
      SELECT kind, title, payload, created_at FROM shares WHERE code = ${c}`
    if (!rows.length) return Response.json({ error: "not_found" }, { status: 404 })
    return Response.json(rows[0])
  }

  if (req.method === "POST" && !c) {
    const me = await requireUser()
    if (me instanceof Response) return me
    let body: { kind?: string; title?: string; payload?: unknown }
    try { body = await req.json() } catch { return Response.json({ error: "bad_json" }, { status: 400 }) }
    const kind = body.kind === "plan" ? "plan" : "workout"
    const title = String(body.title || "Workout").slice(0, 80)
    const json = JSON.stringify(body.payload ?? null)
    if (!body.payload || json.length > 200_000) return Response.json({ error: "bad_payload" }, { status: 400 })
    const k = code()
    await db.sql`INSERT INTO shares (code, owner_id, kind, title, payload) VALUES (${k}, ${me.id}, ${kind}, ${title}, ${json}::jsonb)`
    return Response.json({ code: k })
  }

  return new Response("Method not allowed", { status: 405 })
}

export const config: Config = { path: ["/api/share", "/api/share/:code"], method: ["GET", "POST"] }
