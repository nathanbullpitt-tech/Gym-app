import type { Config } from "@netlify/functions"
import Anthropic from "@anthropic-ai/sdk"
import { requireUser } from "../lib/auth.mts"

// Model choice: env override first, then whatever the AI Gateway currently lists, then sensible fallbacks.
const FALLBACK = { main: ["claude-sonnet-5-5", "claude-sonnet-4-5"], quick: ["claude-haiku-5-5", "claude-haiku-4-5"] }
let discovered: string[] | null = null

async function gatewayModels(): Promise<string[]> {
  if (discovered) return discovered
  try {
    const r = await fetch("https://api.netlify.com/api/v1/ai-gateway/providers/detailed", { signal: AbortSignal.timeout(4000) })
    const found = new Set<string>()
    const walk = (v: unknown) => {
      if (typeof v === "string") { if (/^claude-[a-z0-9.\-]+$/.test(v)) found.add(v) }
      else if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === "object") Object.values(v).forEach(walk)
    }
    if (r.ok) walk(await r.json())
    discovered = [...found]
  } catch { discovered = [] }
  return discovered
}
const ver = (id: string) => (id.match(/\d+/g) || []).filter(n => n.length < 6).map(Number)
const newer = (a: string, b: string) => {
  const x = ver(a), y = ver(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0)
  return a.length - b.length
}
async function candidates(tier: "main" | "quick"): Promise<string[]> {
  const env = Netlify.env.get(tier === "quick" ? "KC_MODEL_QUICK" : "KC_MODEL")
  const family = tier === "quick" ? /haiku/ : /sonnet/
  const live = (await gatewayModels()).filter(m => family.test(m)).sort(newer).slice(0, 2)
  return [...new Set([env, ...live, ...FALLBACK[tier]].filter(Boolean) as string[])]
}

type Body = {
  system?: string
  messages: Anthropic.MessageParam[]
  tools?: Anthropic.Tool[]
  tier?: "main" | "quick"
  max_tokens?: number
}

export default async (req: Request) => {
  const me = await requireUser()
  if (me instanceof Response) return me
  if (!Netlify.env.get("ANTHROPIC_BASE_URL") && !Netlify.env.get("ANTHROPIC_API_KEY"))
    return Response.json({ error: "gateway_off", message: "The AI Gateway isn't active yet. Do one production deploy first." }, { status: 503 })

  let body: Body
  try { body = await req.json() } catch { return Response.json({ error: "bad_json" }, { status: 400 }) }
  if (!Array.isArray(body.messages) || !body.messages.length) return Response.json({ error: "no_messages" }, { status: 400 })

  const anthropic = new Anthropic()
  const tier = body.tier === "quick" ? "quick" : "main"
  const params = {
    max_tokens: Math.min(Math.max(Number(body.max_tokens) || 4096, 256), 16000),
    messages: body.messages,
    ...(body.system ? { system: body.system } : {}),
    ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools.slice(0, 20) } : {}),
  }

  // Try each model until one is accepted (the gateway's list changes over time).
  let stream: AsyncIterable<Anthropic.RawMessageStreamEvent> | null = null
  let model = ""
  let lastErr: unknown = null
  for (const m of await candidates(tier)) {
    try {
      stream = await anthropic.messages.create({ ...params, model: m, stream: true })
      model = m
      break
    } catch (e: any) {
      lastErr = e
      const status = e?.status
      if (status === 404 || (status === 400 && /model/i.test(String(e?.message)))) continue
      break
    }
  }
  if (!stream) {
    const status = (lastErr as any)?.status
    const code = status === 429 ? "rate_limited" : status === 400 ? "bad_request" : "upstream"
    console.error("ai error", status, String((lastErr as any)?.message || lastErr))
    return Response.json({ error: code, message: String((lastErr as any)?.message || "AI request failed") }, { status: status === 429 ? 429 : 502 })
  }

  // Stream NDJSON: {"t":"text","d":"..."} lines, then one {"t":"done",...} line.
  const enc = new TextEncoder()
  const out = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"))
      const blocks: any[] = []
      let stop: string | null = null
      try {
        for await (const ev of stream!) {
          if (ev.type === "content_block_start") {
            const b: any = { ...ev.content_block }
            if (b.type === "tool_use") b._json = ""
            blocks[ev.index] = b
          } else if (ev.type === "content_block_delta") {
            const b = blocks[ev.index]
            if (ev.delta.type === "text_delta") { b.text = (b.text || "") + ev.delta.text; send({ t: "text", d: ev.delta.text }) }
            else if (ev.delta.type === "input_json_delta") b._json += ev.delta.partial_json
          } else if (ev.type === "message_delta") {
            stop = ev.delta.stop_reason || stop
          }
        }
        const content = blocks.filter(Boolean).map(b => {
          if (b.type === "tool_use") {
            let input = {}
            try { input = b._json ? JSON.parse(b._json) : (b.input || {}) } catch { input = {} }
            return { type: "tool_use", id: b.id, name: b.name, input }
          }
          if (b.type === "text") return { type: "text", text: b.text || "" }
          return null
        }).filter(Boolean)
        send({ t: "done", content, stop_reason: stop, model })
      } catch (e: any) {
        console.error("ai stream error", String(e?.message || e))
        send({ t: "error", error: e?.status === 429 ? "rate_limited" : "upstream", message: String(e?.message || e) })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(out, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } })
}

export const config: Config = {
  path: "/api/ai",
  method: "POST",
  rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ["ip", "domain"] },
}
