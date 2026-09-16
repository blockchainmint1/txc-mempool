// Telegram notify relay for the box's monitor/canary scripts.
// The bot token lives in Lovable's secret store (TELEGRAM_BOT_TOKEN), so the
// server never needs a copy — the scripts just POST here with a shared secret.
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { timingSafeEqual } from 'crypto'

const Body = z.object({
  secret: z.string().min(1),
  text: z.string().min(1).max(4000),
  // optional override; defaults to the quiet alerts group
  chat: z.string().optional(),
})

export const Route = createFileRoute('/api/public/notify')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env['TELEGRAM_NOTIFY_SECRET']
        const token = process.env['TELEGRAM_BOT_TOKEN']
        if (!expected || !token) {
          return Response.json({ ok: false, error: 'not configured' }, { status: 503 })
        }

        let body: z.infer<typeof Body>
        try {
          body = Body.parse(await request.json())
        } catch {
          return Response.json({ ok: false, error: 'bad request' }, { status: 400 })
        }

        const a = Buffer.from(body.secret)
        const b = Buffer.from(expected)
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
        }

        const chatId = body.chat ?? '-5101771348'
        const tg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: body.text }),
        })
        const tgBody = (await tg.json().catch(() => ({}))) as { description?: string }
        if (!tg.ok) {
          return Response.json(
            { ok: false, error: tgBody.description ?? `telegram ${tg.status}` },
            { status: 502 },
          )
        }
        return Response.json({ ok: true })
      },
    },
  },
})
