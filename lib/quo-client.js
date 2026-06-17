/**
 * Quo (formerly OpenPhone) API client
 * Used to send SMS and manage Quo resources from the SOCO middleware.
 *
 * Auth: Quo uses the raw API key in the Authorization header — NOT "Bearer <key>".
 *   Authorization: <api_key>
 *
 * Docs: https://www.quo.com/docs/mdx/api-reference/introduction
 */

const QUO_BASE_URL = process.env.QUO_BASE_URL || 'https://api.quo.com/v1';
const QUO_API_KEY = process.env.QUO_API_KEY;

function headers() {
    if (!QUO_API_KEY) {
        throw new Error('QUO_API_KEY is not set');
    }
    return {
        'Authorization': QUO_API_KEY,
        'Content-Type': 'application/json',
    };
}

/**
 * Send a text message via Quo.
 * @param {Object} opts
 * @param {string} opts.from - Quo phone number (E.164) OR Quo phone number ID (PN…)
 * @param {string|string[]} opts.to - Recipient phone number(s) in E.164
 * @param {string} opts.content - Message body (1-1600 chars)
 * @param {string} [opts.userId] - Quo user ID (US…) — defaults to phone number owner
 * @returns {Promise<{id, status, from, to, text}>}
 */
async function sendSMS({ from, to, content, userId }) {
    const fetch = (await import('node-fetch')).default;
    const recipients = Array.isArray(to) ? to : [to];

    const body = { from, to: recipients, content };
    if (userId) body.userId = userId;

    const res = await fetch(`${QUO_BASE_URL}/messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
    });

    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

    if (!res.ok) {
        throw new Error(`Quo SMS send failed (${res.status}): ${parsed?.message || parsed?.raw || text}`);
    }
    return parsed.data;
}

/**
 * List all Quo webhooks currently registered on this workspace.
 * Useful for setup verification.
 */
async function listWebhooks() {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`${QUO_BASE_URL}/webhooks`, { headers: headers() });
    const json = await res.json();
    if (!res.ok) throw new Error(`Quo listWebhooks failed: ${JSON.stringify(json)}`);
    return json.data;
}

/**
 * Register a webhook subscription on Quo.
 * @param {Object} opts
 * @param {string} opts.kind - 'messages' | 'calls' | 'call-summaries' | 'call-transcripts'
 * @param {string[]} opts.events - e.g. ['message.received','message.delivered']
 * @param {string} opts.url - public URL on our middleware that will receive POSTs
 * @param {string} [opts.label] - human-readable label
 * @param {string[]} [opts.resourceIds] - PN ids to scope the webhook (omit for all numbers)
 */
async function createWebhook({ kind, events, url, label, resourceIds }) {
    const fetch = (await import('node-fetch')).default;
    const body = {
        events,
        url,
        label: label || `SOCO middleware - ${kind}`,
        status: 'enabled',
    };
    if (resourceIds && resourceIds.length) body.resourceIds = resourceIds;

    const res = await fetch(`${QUO_BASE_URL}/webhooks/${kind}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Quo createWebhook(${kind}) failed: ${JSON.stringify(json)}`);
    return json.data; // includes the `key` we use to verify signatures
}

/**
 * Verify the signature of an inbound webhook POST from Quo.
 *
 * Quo signs each webhook with the webhook's `key` (returned at creation time)
 * and sends an "x-openphone-signature" / "openphone-signature" header on each
 * delivery. The header is typically of the form:
 *   hmac;1;<timestamp>;<hash>
 *
 * If the user has multiple webhooks (messages, calls, etc.) each may have its
 * own key — we store them per-webhook by environment variable name.
 *
 * @param {string} rawBody - the raw request body as a string (BEFORE JSON parse)
 * @param {string} signatureHeader - the signature header value sent by Quo
 * @param {string} secret - the webhook's `key`
 * @returns {boolean}
 */
function verifySignature(rawBody, signatureHeader, secret) {
    if (!secret || !signatureHeader) return false;
    const crypto = require('crypto');
    try {
        // Header format: "hmac;<version>;<timestamp>;<digest>"
        const parts = String(signatureHeader).split(';');
        if (parts.length < 4) {
            // Some Quo deployments send just the digest — try direct compare as fallback
            const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
            return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signatureHeader)));
        }
        const [/*algo*/, /*version*/, timestamp, providedDigest] = parts;
        const signedPayload = `${timestamp}.${rawBody}`;
        const expected = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(signedPayload).digest('base64');
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(providedDigest));
    } catch (e) {
        console.warn('Quo signature verification threw:', e.message);
        return false;
    }
}

module.exports = {
    sendSMS,
    listWebhooks,
    createWebhook,
    verifySignature,
};
