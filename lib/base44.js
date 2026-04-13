/**
 * Base44 API client for SOCO PRODUCTION app
 * Handles all CRUD operations for entities
 */

const BASE_URL = process.env.BASE44_API_URL;
const API_KEY = process.env.BASE44_API_KEY;

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`
};

async function fetchJSON(url, options = {}) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Base44 API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ============ Generic CRUD ============

async function createEntity(entityName, data) {
  return fetchJSON(`${BASE_URL}/entities/${entityName}`, {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

async function updateEntity(entityName, id, data) {
  return fetchJSON(`${BASE_URL}/entities/${entityName}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  });
}

async function queryEntities(entityName, filters = {}, limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) });
  for (const [key, value] of Object.entries(filters)) {
    params.append(`filter_${key}`, value);
  }
  return fetchJSON(`${BASE_URL}/entities/${entityName}?${params.toString()}`);
}

async function getEntity(entityName, id) {
  return fetchJSON(`${BASE_URL}/entities/${entityName}/${id}`);
}

// ============ TeamPhone Lookups ============

// Cache team phones to avoid repeated lookups
let _phoneCache = null;
let _phoneCacheTime = 0;
const CACHE_TTL = 60000; // 1 minute

async function getTeamPhones() {
  const now = Date.now();
  if (_phoneCache && (now - _phoneCacheTime) < CACHE_TTL) {
    return _phoneCache;
  }
  const result = await queryEntities('TeamPhone', {}, 100);
  _phoneCache = Array.isArray(result) ? result : (result.results || result.data || []);
  _phoneCacheTime = now;
  return _phoneCache;
}

function clearPhoneCache() {
  _phoneCache = null;
}

async function findTeamPhoneByNumber(phoneNumber) {
  const phones = await getTeamPhones();
  // Normalize: strip everything except digits, then compare last 10
  const normalize = (n) => (n || '').replace(/\D/g, '').slice(-10);
  const target = normalize(phoneNumber);
  return phones.find(p => normalize(p.twilio_phone_number) === target);
}

// ============ Contact Lookups ============

async function findContactByPhone(phoneNumber) {
  const normalize = (n) => (n || '').replace(/\D/g, '').slice(-10);
  const target = normalize(phoneNumber);

  // Search by phone and mobile fields
  const contacts = await queryEntities('Contact', {}, 500);
  const list = Array.isArray(contacts) ? contacts : (contacts.results || contacts.data || []);

  return list.find(c =>
    normalize(c.phone) === target || normalize(c.mobile) === target
  );
}

// ============ AutoReply Lookups ============

async function getActiveAutoReplies(teamPhoneId) {
  const rules = await queryEntities('AutoReply', {}, 200);
  const list = Array.isArray(rules) ? rules : (rules.results || rules.data || []);

  return list
    .filter(r => r.enabled !== false)
    .filter(r => !r.team_phone_id || r.team_phone_id === teamPhoneId)
    .sort((a, b) => (a.priority || 10) - (b.priority || 10));
}

module.exports = {
  createEntity,
  updateEntity,
  queryEntities,
  getEntity,
  getTeamPhones,
  clearPhoneCache,
  findTeamPhoneByNumber,
  findContactByPhone,
  getActiveAutoReplies
};
