
import { ConversationBrain } from './conversation.js';
import { ModerationBrain } from './moderation.js';
import { CoachBrain } from './coach.js';
import { AnalystBrain } from './analyst.js';
export const brains = {
  conversation: ConversationBrain,
  moderation: ModerationBrain,
  coach: CoachBrain,
  analyst: AnalystBrain,
};
export const defaultBrain = 'conversation';
export function getBrain(name) {
  const BrainClass = brains[name];
  if (!BrainClass) return brains[defaultBrain];
  return BrainClass;
}
