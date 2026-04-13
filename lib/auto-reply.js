/**
 * Auto-reply engine
 * Matches incoming messages against AutoReply rules and returns the first match
 */

const base44 = require('./base44');

/**
 * Check if current time is within business hours
 */
function isBusinessHours(teamPhone) {
  if (!teamPhone.business_hours_start || !teamPhone.business_hours_end) return true;

  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const currentTime = hours * 60 + minutes;

  const [startH, startM] = teamPhone.business_hours_start.split(':').map(Number);
  const [endH, endM] = teamPhone.business_hours_end.split(':').map(Number);
  const startTime = startH * 60 + (startM || 0);
  const endTime = endH * 60 + (endM || 0);

  return currentTime >= startTime && currentTime <= endTime;
}

/**
 * Check if a rule's schedule allows it to fire right now
 */
function isRuleActive(rule, teamPhone) {
  if (!rule.schedule || rule.schedule === 'Always') return true;

  const inBizHours = isBusinessHours(teamPhone);

  if (rule.schedule === 'Business Hours Only') return inBizHours;
  if (rule.schedule === 'After Hours Only') return !inBizHours;

  return true;
}

/**
 * Test if an incoming message matches a rule's trigger
 */
function matchesTrigger(rule, messageBody) {
  const body = (messageBody || '').toLowerCase().trim();
  const keywords = (rule.trigger_keywords || []).map(k => k.toLowerCase().trim());

  switch (rule.trigger_type) {
    case 'Exact Match':
      return keywords.some(kw => body === kw);

    case 'Contains':
      return keywords.some(kw => body.includes(kw));

    case 'Keyword Match':
      // Any keyword appears as a standalone word
      return keywords.some(kw => {
        const regex = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i');
        return regex.test(body);
      });

    case 'Regex':
      return keywords.some(kw => {
        try {
          return new RegExp(kw, 'i').test(body);
        } catch (e) {
          return false;
        }
      });

    case 'Any Message':
      return body.length > 0;

    case 'After Hours':
      // This is handled by schedule check, always matches message-wise
      return true;

    case 'Missed Call':
      // Special type — handled in voice route, not here
      return false;

    default:
      return false;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the first matching auto-reply rule for an incoming message
 * Returns { rule, response_message } or null
 */
async function findMatchingRule(teamPhoneId, teamPhone, messageBody) {
  const rules = await base44.getActiveAutoReplies(teamPhoneId);

  for (const rule of rules) {
    // Check schedule
    if (!isRuleActive(rule, teamPhone)) continue;

    // Check trigger match
    if (matchesTrigger(rule, messageBody)) {
      return {
        rule,
        response_message: rule.response_message
      };
    }
  }

  return null;
}

/**
 * Get after-hours message for a team phone (separate from auto-reply rules)
 */
function getAfterHoursMessage(teamPhone) {
  if (!teamPhone.after_hours_message) return null;
  if (isBusinessHours(teamPhone)) return null;
  return teamPhone.after_hours_message;
}

module.exports = {
  findMatchingRule,
  getAfterHoursMessage,
  isBusinessHours,
  matchesTrigger
};
