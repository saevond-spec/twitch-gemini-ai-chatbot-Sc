
import client from 'prom-client';
const register = new client.Registry();
client.collectDefaultMetrics({ register });
export const metrics = {
  messagesReceived: new client.Counter({ name: 'messages_received_total', help: 'Total messages received' }),
  messagesSent: new client.Counter({ name: 'messages_sent_total', help: 'Total messages sent' }),
  aiCalls: new client.Counter({ name: 'ai_calls_total', help: 'Total AI calls' }),
  aiErrors: new client.Counter({ name: 'ai_errors_total', help: 'Total AI errors' }),
  aiLatency: new client.Histogram({ name: 'ai_latency_seconds', help: 'AI latency in seconds', buckets: [0.1, 0.5, 1, 2, 5] }),
  tokenUsage: new client.Counter({ name: 'ai_tokens_used_total', help: 'Total tokens used' }),
  queueDepth: new client.Gauge({ name: 'queue_depth', help: 'Number of jobs in queue' }),
  activeViewers: new client.Gauge({ name: 'active_viewers', help: 'Active viewers count' }),
  ircReconnects: new client.Counter({ name: 'irc_reconnects_total', help: 'Total IRC reconnection attempts' }),
  eventsubReconnects: new client.Counter({ name: 'eventsub_reconnects_total', help: 'Total EventSub reconnection attempts' }),
  viewerWelcomes: new client.Counter({ name: 'viewer_welcomes_total', help: 'Proactive first-chat welcomes sent' }),
  proactiveWelcomesSuppressed: new client.Counter({ name: 'proactive_welcomes_suppressed_total', help: 'Proactive welcomes suppressed during chat bursts' }),
  followPrompts: new client.Counter({ name: 'follow_prompts_total', help: 'Soft follow invitations sent' }),
  followEvents: new client.Counter({ name: 'follow_events_total', help: 'Twitch follow events observed' }),
  viewerOptOuts: new client.Counter({ name: 'viewer_opt_outs_total', help: 'Viewers opting out of proactive bot conversation' }),
};
register.registerMetric(metrics.messagesReceived);
register.registerMetric(metrics.messagesSent);
register.registerMetric(metrics.aiCalls);
register.registerMetric(metrics.aiErrors);
register.registerMetric(metrics.aiLatency);
register.registerMetric(metrics.tokenUsage);
register.registerMetric(metrics.queueDepth);
register.registerMetric(metrics.activeViewers);
register.registerMetric(metrics.ircReconnects);
register.registerMetric(metrics.eventsubReconnects);
register.registerMetric(metrics.viewerWelcomes);
register.registerMetric(metrics.proactiveWelcomesSuppressed);
register.registerMetric(metrics.followPrompts);
register.registerMetric(metrics.followEvents);
register.registerMetric(metrics.viewerOptOuts);
export function getMetrics() { return register.metrics(); }
