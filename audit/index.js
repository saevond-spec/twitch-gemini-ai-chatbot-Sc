// audit/index.js
import { writeAuditEntry } from './logger.js';

/**
 * A chat message was sent to a channel.
 */
export function messageSent({ channel, targetUser, trigger, message, remainingTokens }) {
  writeAuditEntry('MSG_SENT', {
    channel,
    targetUser: targetUser || null,
    trigger: trigger || 'unknown',
    messageSnippet: message?.slice(0, 80),
    remainingTokens,
  });
}

/**
 * IRC PONG received.
 */
export function ircPong(latencyMs, note = null) {
  writeAuditEntry('IRC_PONG', {
    latencyMs: latencyMs ?? null,
    note,
  });
}

/**
 * Helix API call completed.
 */
export function helixApi({ endpoint, method, status, durationMs, bodySnippet }) {
  writeAuditEntry('HELIX_API', {
    endpoint,
    method,
    status,
    durationMs,
    bodySnippet: bodySnippet?.slice(0, 100),
  });
}

/**
 * General error / warning.
 */
export function error({ message, stack, context }) {
  writeAuditEntry('ERROR', {
    message: message?.slice(0, 200),
    stack: stack?.slice(0, 300),
    context,
  }, 'error');
}

/**
 * Any other custom action not covered above.
 */
export function custom(action, details) {
  writeAuditEntry(action, details);
}
