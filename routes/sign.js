/**
 * Public contract signing route — hosted on the SOCO middleware.
 *
 * Customer flow:
 *   1. Email link points to /sign/:token
 *   2. GET /sign/:token  → renders the contract + signature canvas (no login)
 *   3. POST /sign/:token → captures signature image + typed name, updates ContractLog
 *      and emails a confirmation to the customer + SOCO team
 *
 * No Base44 frontend auth involved. ContractLog RLS allows anonymous read+update,
 * so the middleware does the data work via the Base44 REST API with its api_key.
 */

const express = require('express');
const router = express.Router();
const base44 = require('../lib/base44');

const COMPANY = {
    name: 'SOCO Production',
    tagline: 'Professional AV Solutions',
    brand_orange: '#F97316',
    brand_dark: '#111827',
    counter_signer_name: 'Colton Henderson',
    counter_signer_title: 'Co-Owner, SOCO Production, LLC',
    counter_signature_url: 'https://raw.githubusercontent.com/JamesUdo/soco-twilio-middleware/main/colton_signature.png',
    support_phone: '(405) 252-1886',
    support_email: 'service@socoproduction.com',
    legal_address: '120 N Rockwell, Unit F 106, Oklahoma City, OK 73127',
};

// ----- helpers -----
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function todayIso() { return new Date().toISOString().slice(0, 10); }

async function findContractLogByToken(token) {
    if (!token || typeof token !== 'string') return null;
    // Use the list endpoint with a filter on signing_token.
    const list = await base44.queryEntities('ContractLog', { signing_token: token }, 5);
    const arr = Array.isArray(list) ? list : (list.results || list.data || []);
    return arr.find(c => c.signing_token === token) || null;
}

async function getTemplate(template_id) {
    if (!template_id) return null;
    try {
        return await base44.getEntity('ContractTemplate', template_id);
    } catch (e) {
        console.warn('Template fetch failed:', e.message);
        return null;
    }
}

async function getDefaultTemplate() {
    try {
        const list = await base44.queryEntities('ContractTemplate', { is_default: true }, 1);
        const arr = Array.isArray(list) ? list : (list.results || list.data || []);
        if (arr.length) return arr[0];
        // Fallback: first active template
        const list2 = await base44.queryEntities('ContractTemplate', {}, 10);
        const arr2 = Array.isArray(list2) ? list2 : (list2.results || list2.data || []);
        return arr2[0] || null;
    } catch (e) {
        return null;
    }
}

function mergeTemplate(html, ctx) {
    if (!html) return '';
    return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
        // Resolve dot-path lookups
        const v = key.split('.').reduce((acc, k) => acc && acc[k], ctx);
        return v == null ? '' : esc(String(v));
    });
}

// ===================================================================
// GET /sign/:token  — render the signing page
// ===================================================================
router.get('/:token', async (req, res) => {
    const token = req.params.token;
    res.set('Cache-Control', 'no-store');

    let contract;
    try { contract = await findContractLogByToken(token); }
    catch (e) {
        console.error('findContractLog error:', e.message);
        return res.status(500).send(renderError('We had trouble loading your contract.', 'Please try again or call (405) 252-1886.'));
    }

    if (!contract) {
        return res.status(404).send(renderError('Contract not found', 'This signing link is no longer valid. Please request a new one from your SOCO representative.'));
    }

    // If already signed, show the success page
    if (contract.status === 'Signed' || contract.signed_at) {
        return res.send(renderAlreadySigned(contract));
    }

    // Look up template + linked records for merge context
    let template = await getTemplate(contract.contract_template_id || contract.template_id);
    if (!template) template = await getDefaultTemplate();

    let invoice = null, deal = null, company = null, contact = null;
    try { if (contract.invoice_id) invoice = await base44.getEntity('Invoice', contract.invoice_id); } catch {}
    try { if (contract.deal_id) deal = await base44.getEntity('Deal', contract.deal_id); } catch {}
    try { if (contract.company_id) company = await base44.getEntity('Company', contract.company_id); } catch {}
    try { if (contract.contact_id) contact = await base44.getEntity('Contact', contract.contact_id); } catch {}

    const ctx = {
        today: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        customer_name: contract.recipient_name || [contact?.first_name, contact?.last_name].filter(Boolean).join(' ') || 'Customer',
        customer_email: contract.recipient_email || contact?.email || '',
        company_name: company?.name || company?.company_name || invoice?.company_name || deal?.deal_name || '',
        project_name: deal?.deal_name || invoice?.project_name || '',
        scope_of_work: invoice?.scope_of_work || invoice?.notes || deal?.notes || '',
        total_value: invoice?.total_amount != null ? `$${Number(invoice.total_amount).toFixed(2)}` : '$0.00',
        counter_signer_name: COMPANY.counter_signer_name,
        counter_signer_title: COMPANY.counter_signer_title,
        counter_signature_url: COMPANY.counter_signature_url,
        company: COMPANY,
    };

    const contractHtml = template?.body_html
        ? mergeTemplate(template.body_html, ctx)
        : defaultContractHtml(ctx);

    // Mark as viewed (fire-and-forget)
    if (!contract.viewed_at) {
        base44.updateEntity('ContractLog', contract.id || contract._id, {
            viewed_at: new Date().toISOString(),
            status: contract.status === 'Sent' ? 'Viewed' : contract.status,
        }).catch(e => console.warn('mark viewed failed:', e.message));
    }

    return res.send(renderSignPage({ contract, contractHtml, ctx }));
});

// ===================================================================
// POST /sign/:token  — capture the signature
// ===================================================================
router.post('/:token', express.json({ limit: '10mb' }), async (req, res) => {
    const token = req.params.token;
    const { signature_image, typed_name, accepted } = req.body || {};

    if (!signature_image || !typed_name || !accepted) {
        return res.status(400).json({ error: 'Signature, typed name, and acceptance are required.' });
    }

    const contract = await findContractLogByToken(token);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });
    if (contract.status === 'Signed' || contract.signed_at) {
        return res.status(409).json({ error: 'This contract has already been signed.' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.connection?.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';

    // Update the ContractLog
    try {
        await base44.updateEntity('ContractLog', contract.id || contract._id, {
            status: 'Signed',
            signed_at: new Date().toISOString(),
            signer_typed_name: typed_name.trim(),
            signature_image_url: signature_image, // data URL stored inline; can upload to file storage later
            signer_ip: ip,
            signer_user_agent: ua,
        });
    } catch (e) {
        console.error('ContractLog update failed:', e.message);
        return res.status(502).json({ error: 'Could not save your signature. Please try again.' });
    }

    // Fire confirmation email (non-blocking)
    sendSignedConfirmation(contract, typed_name.trim(), signature_image).catch(e => {
        console.warn('Signed email failed:', e.message);
    });

    return res.json({ ok: true });
});

// ----- email confirmation (non-blocking) -----
async function sendSignedConfirmation(contract, typedName, signatureDataUrl) {
    try {
        const { Resend } = require('resend');
        if (!process.env.RESEND_API_KEY) return;
        const resend = new Resend(process.env.RESEND_API_KEY);

        const recipients = [];
        if (contract.recipient_email) recipients.push(contract.recipient_email);
        const teamEmails = ['james@socoproduction.com', 'colton@socoproduction.com'];

        const html = `
          <div style="font-family: Arial, sans-serif; max-width:600px;">
            <div style="background:${COMPANY.brand_orange}; padding:20px; text-align:center;">
              <h1 style="color:white; margin:0; font-size:22px;">Agreement Signed ✓</h1>
            </div>
            <div style="padding:24px;">
              <h2 style="color:${COMPANY.brand_dark}; margin:0 0 12px 0;">Thank you, ${esc(typedName)}!</h2>
              <p>The SOCO Production agreement for <strong>your project</strong> has been electronically signed.</p>
              <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px; padding:14px; margin:18px 0;">
                <p style="margin:0 0 6px 0;"><strong>Signed by:</strong> ${esc(typedName)}</p>
                <p style="margin:0 0 6px 0;"><strong>Date:</strong> ${new Date().toLocaleString('en-US', { dateStyle:'long', timeStyle:'short' })}</p>
                <p style="margin:0;"><strong>Contract ID:</strong> ${esc(contract.id || contract._id || '')}</p>
              </div>
              <p style="font-size:13px; color:#6b7280;">A signed copy of the agreement is saved to your SOCO Production account. Questions? Reply to this email or call ${esc(COMPANY.support_phone)}.</p>
            </div>
            <div style="background:#f3f4f6; padding:14px; text-align:center; font-size:12px; color:#6b7280;">
              ${esc(COMPANY.name)} · ${esc(COMPANY.legal_address)}
            </div>
          </div>
        `;

        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'SOCO Production <noreply@socoproduction.com>',
            to: [...new Set([...recipients, ...teamEmails])],
            subject: `Signed: ${COMPANY.name} Agreement — ${typedName}`,
            html,
        });
    } catch (e) {
        console.warn('Signed-confirmation email error:', e.message);
    }
}

// ===================================================================
// HTML rendering
// ===================================================================
function pageShell(bodyHtml, title) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${esc(title)} — SOCO Production</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background:#f3f4f6; color:#111827; line-height:1.55; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 0; }
  .header { background:${COMPANY.brand_dark}; color:white; padding:20px 32px; }
  .header h1 { margin:0; font-size:20px; letter-spacing:1px; }
  .header .tag { font-size:13px; color:#9ca3af; margin-top:4px; }
  .card { background:white; padding: 32px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
  .contract { font-size:14px; line-height:1.6; }
  .contract h1, .contract h2, .contract h3 { color:#111827; }
  .contract table { width:100%; border-collapse:collapse; margin: 14px 0; }
  .contract table td { border:1px solid #ddd; padding:6px 8px; vertical-align:top; }
  .sig-section { background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:24px; margin-top:28px; }
  .sig-section h2 { margin:0 0 16px 0; font-size:16px; color:#111827; }
  .sig-pad-wrap { background:white; border:2px dashed #d1d5db; border-radius:6px; position:relative; }
  .sig-pad { width:100%; height:160px; display:block; touch-action:none; cursor:crosshair; }
  .sig-placeholder { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); color:#9ca3af; font-size:13px; pointer-events:none; }
  .sig-clear { margin-top:6px; background:none; border:none; color:${COMPANY.brand_orange}; font-size:12px; cursor:pointer; padding:0; }
  .field { margin-top:14px; }
  .field label { display:block; font-size:13px; font-weight:600; color:#111827; margin-bottom:4px; }
  .field input { width:100%; padding:10px 12px; font-size:14px; border:1px solid #d1d5db; border-radius:6px; font-family:inherit; }
  .field input:focus { outline:none; border-color:${COMPANY.brand_orange}; box-shadow:0 0 0 3px rgba(249,115,22,0.15); }
  .checkbox-row { display:flex; gap:10px; align-items:flex-start; margin-top:16px; font-size:13px; color:#374151; }
  .checkbox-row input { margin-top:3px; }
  .submit-btn { width:100%; margin-top:18px; background:${COMPANY.brand_orange}; color:white; border:none; padding:14px 24px; font-size:16px; font-weight:600; border-radius:8px; cursor:pointer; }
  .submit-btn:disabled { background:#9ca3af; cursor:not-allowed; }
  .submit-btn:hover:not(:disabled) { background:#ea580c; }
  .error { color:#991b1b; background:#fee2e2; border:1px solid #fca5a5; padding:10px 14px; border-radius:6px; font-size:14px; margin-top:12px; display:none; }
  .audit-banner { background:#FEF3C7; border-left:4px solid #F59E0B; padding:12px 16px; margin-bottom:24px; font-size:13px; color:#78350F; border-radius:4px; }
  .success-icon { width:64px; height:64px; background:#10B981; border-radius:50%; margin:0 auto 20px; display:flex; align-items:center; justify-content:center; color:white; font-size:36px; line-height:1; }
  .countersig { margin-top:18px; padding-top:14px; border-top:1px solid #e5e7eb; }
  .countersig img { height:48px; display:block; margin-bottom:4px; }
  .footer { text-align:center; padding:18px; color:#6b7280; font-size:12px; }
  @media (max-width: 600px) {
    .card { padding:20px; }
    .header { padding:16px 20px; }
  }
</style>
</head>
<body>
<div class="wrap">${bodyHtml}</div>
</body>
</html>`;
}

function renderError(title, msg) {
    return pageShell(`
      <div class="header"><h1>${esc(COMPANY.name)}</h1><div class="tag">${esc(COMPANY.tagline)}</div></div>
      <div class="card" style="text-align:center; padding-top:48px;">
        <div style="font-size:48px; color:#dc2626; margin-bottom:8px;">⚠</div>
        <h2 style="margin:0 0 8px 0;">${esc(title)}</h2>
        <p style="color:#6b7280;">${esc(msg)}</p>
      </div>
    `, title);
}

function renderAlreadySigned(contract) {
    return pageShell(`
      <div class="header"><h1>${esc(COMPANY.name)}</h1><div class="tag">${esc(COMPANY.tagline)}</div></div>
      <div class="card" style="text-align:center; padding-top:48px;">
        <div class="success-icon">✓</div>
        <h2 style="margin:0 0 8px 0;">Thank you, ${esc(contract.signer_typed_name || 'Customer')}!</h2>
        <p style="color:#374151; margin:0 0 16px 0;">Your signed agreement has been recorded.</p>
        <p style="color:#6b7280; font-size:13px;">A signed copy will be emailed to <strong>${esc(contract.recipient_email || 'you')}</strong> and the SOCO team within a few minutes.</p>
      </div>
      <div class="footer">${esc(COMPANY.name)} · ${esc(COMPANY.support_email)} · ${esc(COMPANY.support_phone)}</div>
    `, 'Agreement Signed');
}

function defaultContractHtml(ctx) {
    return `
      <h2 style="text-align:center; margin:0 0 8px 0;">${esc(COMPANY.name.toUpperCase())}</h2>
      <p style="text-align:center; color:#6b7280; margin:0 0 24px 0;">Sales Agreement &amp; General Terms and Conditions</p>
      <table>
        <tr><td style="background:#fafafa; width:30%;"><strong>Customer</strong></td><td>${esc(ctx.customer_name)}</td></tr>
        <tr><td style="background:#fafafa;"><strong>Company</strong></td><td>${esc(ctx.company_name)}</td></tr>
        <tr><td style="background:#fafafa;"><strong>Project</strong></td><td>${esc(ctx.project_name)}</td></tr>
        <tr><td style="background:#fafafa;"><strong>Scope of Work</strong></td><td>${esc(ctx.scope_of_work)}</td></tr>
        <tr><td style="background:#fafafa;"><strong>Total Contract Value</strong></td><td>${esc(ctx.total_value)}</td></tr>
        <tr><td style="background:#fafafa;"><strong>Agreement Date</strong></td><td>${esc(ctx.today)}</td></tr>
      </table>
      <h3 style="text-align:center; font-style:italic;">General Terms &amp; Conditions</h3>
      <p>By signing below, the Customer acknowledges they have read, understood, and agreed to the SOCO Production General Terms and Conditions for Sales — including jury waiver, Oklahoma governing law, late payment interest at 1.5% per month, and the warranty terms set forth therein. The full T&amp;Cs are available at socoproduction.com/terms or upon request.</p>
    `;
}

function renderSignPage({ contract, contractHtml, ctx }) {
    const body = `
      <div class="header"><h1>${esc(COMPANY.name)}</h1><div class="tag">${esc(COMPANY.tagline)}</div></div>
      <div class="card">
        <div class="audit-banner">
          <strong>Electronic Signature Request</strong> — Customer: ${esc(ctx.customer_name)} · Date: ${esc(ctx.today)}<br>
          By signing, you agree this electronic signature is the legal equivalent of your handwritten signature.
        </div>
        <div class="contract">${contractHtml}</div>

        <div class="countersig">
          <p style="margin:0 0 4px 0; font-size:13px; color:#6b7280;">SOCO Production countersignature:</p>
          <img src="${esc(COMPANY.counter_signature_url)}" alt="Colton Henderson signature" />
          <p style="margin:0; font-size:12px; color:#6b7280;">${esc(COMPANY.counter_signer_name)} · ${esc(COMPANY.counter_signer_title)} · ${esc(ctx.today)}</p>
        </div>

        <div class="sig-section">
          <h2>Customer Signature</h2>
          <div class="sig-pad-wrap">
            <canvas id="sigpad" class="sig-pad"></canvas>
            <div class="sig-placeholder" id="sig-placeholder">Sign here with mouse or finger</div>
          </div>
          <button type="button" class="sig-clear" id="sig-clear">Clear signature</button>

          <div class="field">
            <label for="typed-name">Full Name (typed)</label>
            <input id="typed-name" type="text" autocomplete="name" placeholder="Type your full legal name" />
          </div>

          <div class="checkbox-row">
            <input id="accept" type="checkbox" />
            <label for="accept" style="font-weight:400; line-height:1.45;">
              I confirm that I have read and agree to the SOCO Production Sales Agreement &amp; General Terms above. I understand this electronic signature is legally binding.
            </label>
          </div>

          <div id="err" class="error"></div>
          <button id="submit" class="submit-btn" disabled>Sign Contract</button>
        </div>
      </div>
      <div class="footer">${esc(COMPANY.name)} · ${esc(COMPANY.support_email)} · ${esc(COMPANY.support_phone)}</div>

      <script>
      (function(){
        var canvas = document.getElementById('sigpad');
        var placeholder = document.getElementById('sig-placeholder');
        var ctx = canvas.getContext('2d');
        var drawing = false, hasInk = false;
        var dpr = window.devicePixelRatio || 1;
        function resize() {
          var rect = canvas.getBoundingClientRect();
          canvas.width = rect.width * dpr;
          canvas.height = 160 * dpr;
          ctx.scale(dpr, dpr);
          ctx.lineWidth = 2.2;
          ctx.lineCap = 'round';
          ctx.strokeStyle = '#111827';
        }
        resize();
        window.addEventListener('resize', resize);

        function pos(e) {
          var rect = canvas.getBoundingClientRect();
          var p = e.touches ? e.touches[0] : e;
          return { x: p.clientX - rect.left, y: p.clientY - rect.top };
        }
        function start(e) { e.preventDefault(); drawing = true; hasInk = true; placeholder.style.display='none'; var p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
        function move(e)  { if (!drawing) return; e.preventDefault(); var p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); updateButton(); }
        function end(e)   { drawing = false; }
        canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move); canvas.addEventListener('mouseup', end); canvas.addEventListener('mouseleave', end);
        canvas.addEventListener('touchstart', start, { passive: false }); canvas.addEventListener('touchmove', move, { passive: false }); canvas.addEventListener('touchend', end);

        document.getElementById('sig-clear').addEventListener('click', function() {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          hasInk = false;
          placeholder.style.display = 'block';
          updateButton();
        });

        var typed = document.getElementById('typed-name');
        var accept = document.getElementById('accept');
        var submit = document.getElementById('submit');
        var err = document.getElementById('err');

        function updateButton() {
          submit.disabled = !(hasInk && typed.value.trim().length > 1 && accept.checked);
        }
        typed.addEventListener('input', updateButton);
        accept.addEventListener('change', updateButton);

        submit.addEventListener('click', async function() {
          submit.disabled = true;
          submit.textContent = 'Submitting…';
          err.style.display = 'none';
          try {
            var dataUrl = canvas.toDataURL('image/png');
            var res = await fetch(window.location.pathname, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                signature_image: dataUrl,
                typed_name: typed.value.trim(),
                accepted: accept.checked,
              }),
            });
            var json = await res.json().catch(function(){ return {}; });
            if (!res.ok) throw new Error(json.error || ('Request failed (' + res.status + ')'));
            // Replace the page with the success view
            document.open();
            document.write(${JSON.stringify(pageShell(`
              <div class="header"><h1>${esc(COMPANY.name)}</h1><div class="tag">${esc(COMPANY.tagline)}</div></div>
              <div class="card" style="text-align:center; padding-top:48px;">
                <div class="success-icon">✓</div>
                <h2 style="margin:0 0 8px 0;">Thank you!</h2>
                <p style="color:#374151; margin:0 0 16px 0;">Your signed agreement has been recorded.</p>
                <p style="color:#6b7280; font-size:13px;">A signed copy will be emailed to you and the SOCO team within a few minutes.</p>
              </div>
              <div class="footer">${esc(COMPANY.name)} · ${esc(COMPANY.support_email)} · ${esc(COMPANY.support_phone)}</div>
            `, 'Agreement Signed'))});
            document.close();
          } catch (e) {
            err.textContent = 'Could not submit your signature. ' + (e.message || '') + ' Please try again or call ' + ${JSON.stringify(COMPANY.support_phone)} + '.';
            err.style.display = 'block';
            submit.disabled = false;
            submit.textContent = 'Sign Contract';
          }
        });
      })();
      </script>
    `;
    return pageShell(body, 'Sign Agreement');
}

module.exports = router;
