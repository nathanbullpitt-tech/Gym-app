import type { Config } from "@netlify/functions"
import { getDatabase } from "@netlify/database"
import { requireUser } from "../lib/auth.mts"

const db = getDatabase()
const PATH = /^[a-z]+\/[A-Za-z0-9_\-:.]{1,80}$/
const MAX_DOC = 400_000

type Op = { op: "set" | "update" | "delete"; path: string; data?: unknown }

export default async (req: Request) => {
  const me = await requireUser()
  if (me instanceof Response) return me

  if (req.method === "GET") {
    const rows = await db.sql<{ path: string; data: unknown }>`SELECT path, data FROM docs WHERE user_id = ${me.id}`
    const docs: Record<string, unknown> = {}
    for (const r of rows) docs[r.path] = r.data
    return Response.json({ docs, email: me.email })
  }

  if (req.method === "POST") {
    let body: { ops?: Op[] }
    try { body = await req.json() } catch { return Response.json({ error: "bad_json" }, { status: 400 }) }
    const ops = Array.isArray(body.ops) ? body.ops.slice(0, 200) : []
    for (const o of ops) {
      if (!o || !PATH.test(String(o.path))) return Response.json({ error: "bad_path", path: o && o.path }, { status: 400 })
      if (o.op !== "delete") {
        if (!o.data || typeof o.data !== "object" || Array.isArray(o.data)) return Response.json({ error: "bad_data", path: o.path }, { status: 400 })
        if (JSON.stringify(o.data).length > MAX_DOC) return Response.json({ error: "too_large", path: o.path }, { status: 413 })
      }
    }
    for (const o of ops) {
      if (o.op === "delete") {
        await db.sql`DELETE FROM docs WHERE user_id = ${me.id} AND path = ${o.path}`
      } else if (o.op === "update") {
        await db.sql`INSERT INTO docs (user_id, path, data) VALUES (${me.id}, ${o.path}, ${JSON.stringify(o.data)}::jsonb)
          ON CONFLICT (user_id, path) DO UPDATE SET data = docs.data || EXCLUDED.data, updated_at = NOW()`
      } else {
        await db.sql`INSERT INTO docs (user_id, path, data) VALUES (${me.id}, ${o.path}, ${JSON.stringify(o.data)}::jsonb)
          ON CONFLICT (user_id, path) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`
      }
    }
    return Response.json({ ok: true, n: ops.length })
  }

  return new Response("Method not allowed", { status: 405 })
}

export const config: Config = { path: "/api/data", method: ["GET", "POST"] }
