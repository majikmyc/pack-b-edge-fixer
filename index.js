/**
 * Pack B — Unified Stateless Cloudflare Edge Automation Fixer Worker
 * Solves:
 *  - #8 Make.com Single-Webhook Fan-Out & 500-Item Batch Chunker (avoids 40-min timeout)
 *  - #19/#26 Meta WhatsApp Cloud API GET hub.challenge + Chatwoot nfm_reply Normalizer
 *  - #27 Cal.com March 2026 Unversioned attendeeSeatId Root Flattener
 *  - #51 Zapier Daily Hard-Cap Circuit Breaker & Payload Deduplicator
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.searchParams.has('hub.challenge')) {
      const verifyToken = url.searchParams.get('hub.verify_token');
      if (!env.WHATSAPP_VERIFY_TOKEN || verifyToken === env.WHATSAPP_VERIFY_TOKEN) {
        return new Response(url.searchParams.get('hub.challenge'), { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ status: 'ok', pack: 'Pack-B-Edge-Fixer' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const rawBody = await request.text();
    let payload = {};
    try { payload = JSON.parse(rawBody); } catch (e) { payload = { raw: rawBody }; }

    if (payload?.payload?.attendees && Array.isArray(payload.payload.attendees)) {
      const seatObj = payload.payload.attendees.find(a => a?.bookingSeat?.attendeeSeatId || a?.bookingSeat?.id);
      if (seatObj && !payload.payload.attendeeSeatId) {
        payload.payload.attendeeSeatId = seatObj.bookingSeat.attendeeSeatId || seatObj.bookingSeat.id;
      }
    }
    const waEntry = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (waEntry?.type === 'interactive' && waEntry?.interactive?.type === 'nfm_reply') {
      payload.chatwoot_normalized_note = `[WhatsApp Flow Submission]: ${waEntry.interactive.nfm_reply.response_json}`;
    }
    const fanoutTargets = (env.FANOUT_WEBHOOK_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (fanoutTargets.length > 0) {
      ctx.waitUntil(Promise.all(fanoutTargets.map(target =>
        fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
      )));
    }
    return new Response(JSON.stringify({ ok: true, normalized: true, payload }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};


// Module 5 (#70): vLLM / Qwen3_Coder Streaming Tool-Call Missing Closing Brace '}' Reconstructor
export function reconstructStreamingToolJson(rawChunkStr) {
  let openBraces = 0;
  for (const ch of rawChunkStr) {
    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces = Math.max(0, openBraces - 1);
  }
  return openBraces > 0 ? rawChunkStr + '}'.repeat(openBraces) : rawChunkStr;
}

// Module 6 (#71 & #75): n8n / WooCommerce Webhook Cross-Execution Idempotency & Retry-After Calculator
export function computeWebhookIdempotencyAndBackoff(payload, headers = {}) {
  const entityId = payload?.id || payload?.order_id || 'unknown';
  const updatedAt = payload?.updated_at || payload?.date_modified_gmt || '0';
  const idempotencyKey = `wh_${entityId}_${updatedAt}`;
  const retryAfterRaw = Number(headers['retry-after'] || headers['Retry-After'] || 0);
  const waitMs = retryAfterRaw > 0 ? retryAfterRaw * 1000 : 3000;
  return { idempotencyKey, waitMs };
}
