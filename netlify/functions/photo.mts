import type { Config, Context } from "@netlify/functions"
import { getStore } from "@netlify/blobs"
import { requireUser } from "../lib/auth.mts"

const store = () => getStore({ name: "progress-photos", consistency: "strong" })
const ID = /^[a-z0-9]{8,40}$/

export default async (req: Request, context: Context) => {
  const me = await requireUser()
  if (me instanceof Response) return me
  const id = context.params.id

  if (req.method === "POST" && !id) {
    const type = req.headers.get("content-type") || ""
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return Response.json({ error: "bad_type" }, { status: 415 })
    const buf = await req.arrayBuffer()
    if (buf.byteLength > 4_000_000) return Response.json({ error: "too_large" }, { status: 413 })
    const newId = crypto.randomUUID().replace(/-/g, "")
    await store().set(`${me.id}/${newId}`, buf, { metadata: { type } })
    return Response.json({ id: newId })
  }
  if (!id || !ID.test(id)) return Response.json({ error: "bad_id" }, { status: 400 })
  const key = `${me.id}/${id}`

  if (req.method === "GET") {
    const r = await store().getWithMetadata(key, { type: "arrayBuffer" })
    if (!r) return new Response("Not found", { status: 404 })
    return new Response(r.data, { headers: { "content-type": String(r.metadata.type || "image/jpeg"), "cache-control": "private, max-age=31536000, immutable" } })
  }
  if (req.method === "DELETE") {
    await store().delete(key)
    return Response.json({ ok: true })
  }
  return new Response("Method not allowed", { status: 405 })
}

export const config: Config = { path: ["/api/photo", "/api/photo/:id"], method: ["GET", "POST", "DELETE"] }
