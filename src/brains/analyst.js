const ANALYSIS_WORDS = /\b(why|how|what happened|good play|bad play|mistake|decision|timing|position|positioning|rotate|rotation|parry|dodge|counter|punish|clutch|angle|flank|heal|reload|push|retreat|strategy|strat|analy[sz]e|explain)\b/i;

export class AnalystBrain {
  static getConfig() {
    return {
      systemPrompt: `You are SweatyClanker's live gaming analyst.
Be concise, sharp, and useful for Twitch chat.
You do NOT have direct vision of gameplay unless explicit structured context says otherwise.
Never claim you saw a play that you only inferred from chat.
Separate evidence from inference: say "chat makes it sound like..." or "likely..." when uncertain.
For a meaningful moment, explain at most three things: the key decision, why it mattered, and the best alternative or next adjustment.
Prefer timing, positioning, resource use, matchup, risk/reward, and team coordination over generic hype.
Keep replies to 1-3 short sentences and sound conversational, not like a lecture.`,
      temperature: 0.35,
      maxTokens: 360,
    };
  }
  static async processResponse(reply) { return reply; }


  static async score({ message, context = {} }) {
    const text = String(message || '');
    const directAnalysis = ANALYSIS_WORDS.test(text);
    const question = /\?/.test(text) || /^\s*(why|how|what|was|is|did|should)\b/i.test(text);
    const moment = context.moment || {};

    let score = 12;
    if (directAnalysis) score += 52;
    if (question) score += 12;
    if (moment.analytical) score += 22;
    if (moment.hot) score += 12;
    score = Math.min(100, score);

    return {
      score,
      confidence: directAnalysis ? 0.94 : (moment.analytical ? 0.82 : 0.45),
      priority: 1.7,
      cost: 1,
    };
  }
}
