import { createClient } from '@supabase/supabase-js';
import {
  applyAction,
  isAuthorizedRequest,
  parseUpdate,
  withStatusLine,
  type OrderActionsGateway,
} from '@/app/lib/telegram-order-actions';

/**
 * POST /api/telegram/webhook — Telegram callback queries for the order
 * notification buttons (✅ Підтвердити / 💰 Оплачено / ❌ Скасувати).
 *
 * Security: the X-Telegram-Bot-Api-Secret-Token header must equal the
 * derived webhook secret (HMAC of the bot token — see
 * app/lib/telegram-order-actions.ts). Requests without a valid header are
 * dropped with 401 BEFORE any parsing; Telegram never retries 4xx.
 *
 * Contract: ALWAYS answers 200 (Telegram retries non-2xx aggressively);
 * the outcome of the action is reported to the chat via answerCallbackQuery
 * (toast) and — on success — by appending a status line to the original
 * message. The handlers reuse the admin RPCs (forward-only transitions,
 * atomic cancel with stock restore, conditional paid), so the webhook can
 * never put an order into a state the admin UI couldn't.
 *
 * Registration (one-off, owner/agent): setWebhook with url
 * https://towary-dla-domu.com/api/telegram/webhook and secret_token =
 * webhookSecret(TELEGRAM_BOT_TOKEN) — see docs/.
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

function gateway(): OrderActionsGateway {
  return {
    async order(orderNumber) {
      const { data } = await supabase
        .from('orders')
        .select('id, order_number, status, payment_status, payment_method')
        .eq('order_number', orderNumber)
        .maybeSingle();
      return data;
    },
    async confirm(orderId) {
      const { error } = await supabase.rpc('admin_set_order_status', {
        p_order_id: orderId,
        p_new_status: 'confirmed',
      });
      if (!error) return 'ok';
      return error.code === 'P0409' ? 'conflict' : 'conflict';
    },
    async cancel(orderId) {
      const { error } = await supabase.rpc('admin_cancel_order', { p_order_id: orderId });
      return !error || error.code === 'P0409' ? 'ok' : 'conflict';
    },
    async markPaid(orderId) {
      const { data, error } = await supabase
        .from('orders')
        .update({
          payment_status: 'paid',
          payment_method: 'готівка на точці',
        })
        .eq('id', orderId)
        .neq('payment_status', 'paid')
        .select('id');
      if (error) return 'already-paid';
      return (data ?? []).length > 0 ? 'ok' : 'already-paid';
    },
  };
}

async function tgApi(token: string, method: string, body: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Best-effort: a failed toast/edit must not affect the 200 answer.
  }
}

export async function POST(request: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (
    !token ||
    !isAuthorizedRequest(request.headers.get('x-telegram-bot-api-secret-token'), token)
  ) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return Response.json({ ok: true });
  }

  const cb = parseUpdate(update);
  if (!cb) {
    // Non-callback updates (or foreign bots) are acknowledged silently.
    return Response.json({ ok: true });
  }

  try {
    const gw = gateway();
    const row = (await gw.order(cb.orderNumber)) as import('@/app/lib/telegram-order-actions').OrderRow | null;
    if (!row) {
      await tgApi(token, 'answerCallbackQuery', {
        callback_query_id: cb.id,
        text: 'Замовлення не знайдено',
        show_alert: true,
      });
      return Response.json({ ok: true });
    }

    const outcome = await applyAction(cb.action, row, gw);

    await tgApi(token, 'answerCallbackQuery', {
      callback_query_id: cb.id,
      text: outcome.flash,
      show_alert: outcome.kind === 'error',
    });

    if (outcome.kind === 'ok' && 'statusLine' in outcome) {
      const original =
        typeof (update as { callback_query?: { message?: { text?: unknown } } })
          .callback_query?.message?.text === 'string'
          ? ((update as { callback_query: { message: { text: string } } }).callback_query
              .message.text)
          : null;
      if (original !== null) {
        await tgApi(token, 'editMessageText', {
          chat_id: cb.chatId,
          message_id: cb.messageId,
          text: withStatusLine(original, outcome.statusLine),
        });
      }
    }
  } catch {
    // Never surface internals; the toast above already fired when possible.
  }

  return Response.json({ ok: true });
}
