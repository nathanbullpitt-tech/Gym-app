import type { Config } from "@netlify/functions"
import { getDatabase } from "@netlify/database"
import { requireUser } from "../lib/auth.mts"

const db = getDatabase()

// Rough Anthropic list prices in USD per million tokens, by model family. Netlify bills $1 = 180 credits.
const PRICE: [RegExp, number, number][] = [
  [/haiku-5/i, 0.1, 0.5], [/haiku/i, 1, 5],
  [/sonnet-5/i, 2, 10], [/sonnet/i, 3, 15],
  [/opus-5/i, 4, 20], [/opus/i, 5, 25],
]
const priceFor = (m: string) => PRICE.find(([re]) => re.test(m)) || [/./, 3, 15]

export default async () => {
  const me = await requireUser()
  if (me instanceof Response) return me
  const month = new Date().toISOString().slice(0, 7)
  const rows = await db.sql<{ user_id: string; model: string; calls: number; input_tokens: string; output_tokens: string }>`
    SELECT user_id, model, calls, input_tokens, output_tokens FROM ai_usage WHERE month = ${month}`
  const sum = (mine: boolean) => {
    let calls = 0, usd = 0
    for (const r of rows) {
      if (mine && r.user_id !== me.id) continue
      const [, pin, pout] = priceFor(r.model)
      calls += Number(r.calls)
      usd += (Number(r.input_tokens) * pin + Number(r.output_tokens) * pout) / 1e6
    }
    return { calls, usd: Math.round(usd * 100) / 100, credits: Math.round(usd * 180) }
  }
  return Response.json({ month, you: sum(true), everyone: sum(false) })
}

export const config: Config = { path: "/api/usage", method: "GET" }
