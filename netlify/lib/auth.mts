import { getUser } from "@netlify/identity"

export type Me = { id: string; email: string }

/** Returns the signed-in user, or a 401/403 Response. */
export async function requireUser(): Promise<Me | Response> {
  const user = await getUser()
  if (!user) return Response.json({ error: "signed_out" }, { status: 401 })
  const allow = (Netlify.env.get("KC_ALLOWED_EMAILS") || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
  const email = (user.email || "").toLowerCase()
  if (allow.length && !allow.includes(email)) return Response.json({ error: "not_allowed" }, { status: 403 })
  return { id: user.id, email }
}
