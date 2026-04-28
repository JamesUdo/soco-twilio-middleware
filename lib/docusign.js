/**
 * DocuSign API client for SOCO PRODUCTION
 * Uses JWT Grant flow for server-to-server auth
 */

const DOCUSIGN_ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID;
const DOCUSIGN_INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY;
const DOCUSIGN_USER_ID = process.env.DOCUSIGN_USER_ID;
const DOCUSIGN_PRIVATE_KEY = (process.env.DOCUSIGN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const DOCUSIGN_BASE_URL = process.env.DOCUSIGN_BASE_URL || 'https://na4.docusign.net';
const DOCUSIGN_AUTH_SERVER = process.env.DOCUSIGN_AUTH_SERVER || 'account.docusign.com';

let _accessToken = null;
let _tokenExpiry = 0;

/**
 * Get an access token via JWT Grant
 */
async function getAccessToken() {
    const now = Date.now();
    if (_accessToken && now < _tokenExpiry - 60000) {
          return _accessToken;
    }

  const fetch = (await import('node-fetch')).default;
    const crypto = await import('crypto');

  // Build JWT
  const header = { alg: 'RS256', typ: 'JWT' };
    const iat = Math.floor(now / 1000);
    const exp = iat + 3600;
    const payload = {
          iss: DOCUSIGN_INTEGRATION_KEY,
          sub: DOCUSIGN_USER_ID,
          aud: DOCUSIGN_AUTH_SERVER,
          iat,
          exp,
          scope: 'signature impersonation'
    };

  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const signingInput = `${b64url(header)}.${b64url(payload)}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signingInput);
    const signature = sign.sign(DOCUSIGN_PRIVATE_KEY, 'base64url');
    const jwt = `${signingInput}.${signature}`;

  // Exchange JWT for access token
  const res = await fetch(`https://${DOCUSIGN_AUTH_SERVER}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: jwt
        })
  });

  if (!res.ok) {
        const text = await res.text();
        throw new Error(`DocuSign auth error ${res.status}: ${text}`);
  }

  const data = await res.json();
    _accessToken = data.access_token;
    _tokenExpiry = now + (data.expires_in * 1000);

  console.log('DocuSign access token refreshed');
    return _accessToken;
}

/**
 * Make an authenticated API call to DocuSign
 */
async function apiCall(method, path, body = null) {
    const fetch = (await import('node-fetch')).default;
    const token = await getAccessToken();
    const url = `${DOCUSIGN_BASE_URL}/restapi/v2.1/accounts/${DOCUSIGN_ACCOUNT_ID}${path}`;

  const options = {
        method,
        headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
        }
  };
    if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
    if (!res.ok) {
          const text = await res.text();
          throw new Error(`DocuSign API error ${res.status}: ${text}`);
    }
    return res.json();
}

/**
 * List available templates
 */
async function listTemplates(searchText = '') {
    const params = new URLSearchParams({ count: '50' });
    if (searchText) params.append('search_text', searchText);
    return apiCall('GET', `/templates?${params.toString()}`);
}

/**
 * Get a specific template's details (including tabs/fields)
 */
async function getTemplate(templateId) {
    return apiCall('GET', `/templates/${templateId}`);
}

/**
 * Create and send an envelope from a template
 */
async function createEnvelopeFromTemplate({
    templateId,
    signer,
    textTabs = [],
    emailSubject = 'Please sign: SOCO Production Contract',
    emailBlurb = 'Please review and sign the attached document from SOCO Production.',
    status = 'sent'
}) {
    const templateRole = {
          email: signer.email,
          name: signer.name,
          roleName: signer.roleName || 'Signer'
    };

  if (textTabs.length > 0) {
        templateRole.tabs = {
                textTabs: textTabs.map(t => ({
                          tabLabel: t.tabLabel,
                          value: t.value
                }))
        };
  }

  const envelopeDefinition = {
        templateId,
        templateRoles: [templateRole],
        emailSubject,
        emailBlurb,
        status
  };

  return apiCall('POST', '/envelopes', envelopeDefinition);
}

/**
 * Create and send an envelope from a remote URL document
 */
async function createEnvelopeFromUrl({
    documentUrl,
    documentName = 'Contract',
    signer,
    emailSubject = 'Please sign: SOCO Production Contract',
    emailBlurb = 'Please review and sign the attached document from SOCO Production.',
    status = 'sent'
}) {
    const envelopeDefinition = {
          documents: [{
                  documentId: '1',
                  name: documentName,
                  remoteUrl: documentUrl
          }],
          recipients: {
                  signers: [{
                            email: signer.email,
                            name: signer.name,
                            recipientId: '1',
                            routingOrder: '1',
                            tabs: {
                                        signHereTabs: [{
                                                      documentId: '1',
                                                      recipientId: '1',
                                                      anchorString: '/sig/',
                                                      anchorUnits: 'pixels',
                                                      anchorXOffset: '0',
                                                      anchorYOffset: '0'
                                        }],
                                        dateSignedTabs: [{
                                                      documentId: '1',
                                                      recipientId: '1',
                                                      anchorString: '/date/',
                                                      anchorUnits: 'pixels',
                                                      anchorXOffset: '0',
                                                      anchorYOffset: '0'
                                        }]
                            }
                  }]
          },
          emailSubject,
          emailBlurb,
          status
    };

  return apiCall('POST', '/envelopes', envelopeDefinition);
}

/**
 * Get envelope status
 */
async function getEnvelope(envelopeId) {
    return apiCall('GET', `/envelopes/${envelopeId}`);
}

module.exports = {
    getAccessToken,
    listTemplates,
    getTemplate,
    createEnvelopeFromTemplate,
    createEnvelopeFromUrl,
    getEnvelope
};
