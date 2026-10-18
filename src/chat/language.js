const LANGUAGE_NAMES = Object.freeze({
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  vi: 'Vietnamese',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
  hi: 'Hindi',
  pt: 'Portuguese',
  de: 'German',
  it: 'Italian',
});

const HINTS = Object.freeze({
  es: /\b(hola|gracias|que|qué|como|cómo|esto|esa|ese|juego|jugada|vamos|bueno|bien|porque|por qué|también|pero|muy|una|uno|quiero|puedes)\b/i,
  fr: /\b(bonjour|salut|merci|quoi|comment|jeu|jouer|bien|très|avec|mais|pourquoi|encore|cette|ça|peux|peut)\b/i,
  vi: /\b(xin chào|cảm ơn|không|được|trò chơi|hay quá|đẹp|mình|bạn|vậy|gì|này|đó|với|cho|một)\b/i,
  pt: /\b(olá|obrigado|obrigada|como|jogo|jogada|muito|isso|essa|esse|vamos|porque|também|você|vocês|bom|boa)\b/i,
  de: /\b(hallo|danke|wie|spiel|gut|sehr|warum|das|die|der|und|aber|noch|kannst|kann|was)\b/i,
  it: /\b(ciao|grazie|come|gioco|bella|bello|molto|questo|questa|perché|anche|puoi|bene|ma|che)\b/i,
});

const VIETNAMESE_MARKS = /[ăâđêôơưạảãấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏõốồổỗộớờởỡợụủũứừửữựỳỷỹỵ]/i;
const SPANISH_MARKS = /[ñ¿¡]/i;
const FRENCH_MARKS = /[àâçéèêëîïôûùüÿœæ]/i;
const PORTUGUESE_MARKS = /[ãõçáàâéêíóôú]/i;
const GERMAN_MARKS = /[äöüß]/i;
const ITALIAN_MARKS = /[àèéìíîòóùú]/i;

const TRADITIONAL_MARKERS = /[體國學會這個來時點開關歡愛龍門讓為與萬麼說話見現長車書電腦網實氣後發]/;
const SIMPLIFIED_MARKERS = /[体国学会这个来时点开关欢爱龙门让为与万么说话见现长车书电脑网实气后发]/;

function countMatches(text, regex) {
  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
  const re = new RegExp(regex.source, flags);
  return [...String(text || '').matchAll(re)].length;
}

function latinScore(text, code) {
  const hint = HINTS[code];
  if (!hint) return 0;
  const words = String(text || '').match(/[\p{L}']+/gu) || [];
  if (!words.length) return 0;
  let hits = 0;
  for (const word of words) {
    if (hint.test(word)) hits += 1;
    hint.lastIndex = 0;
  }
  return hits / Math.max(2, words.length);
}

export function detectLanguage(message, priorLanguage = null) {
  const text = String(message || '').trim();
  if (!text) return { code: priorLanguage || 'en', confidence: 0.2, source: 'prior-or-default' };

  const letters = text.match(/\p{L}/gu) || [];
  const letterCount = Math.max(1, letters.length);

  const kana = countMatches(text, /[\u3040-\u30ff]/u);
  const hangul = countMatches(text, /[\uac00-\ud7af]/u);
  const devanagari = countMatches(text, /[\u0900-\u097f]/u);
  const han = countMatches(text, /[\u3400-\u4dbf\u4e00-\u9fff]/u);

  if (kana / letterCount >= 0.12 || kana >= 2) {
    return { code: 'ja', confidence: 0.99, source: 'script' };
  }
  if (hangul / letterCount >= 0.18 || hangul >= 2) {
    return { code: 'ko', confidence: 0.99, source: 'script' };
  }
  if (devanagari / letterCount >= 0.18 || devanagari >= 2) {
    return { code: 'hi', confidence: 0.99, source: 'script' };
  }
  if (han / letterCount >= 0.25 || han >= 2) {
    const variant = TRADITIONAL_MARKERS.test(text)
      ? 'traditional'
      : (SIMPLIFIED_MARKERS.test(text) ? 'simplified' : null);
    return { code: 'zh', confidence: kana ? 0.7 : 0.96, source: 'script', variant };
  }

  if (VIETNAMESE_MARKS.test(text)) return { code: 'vi', confidence: 0.96, source: 'diacritics' };
  if (SPANISH_MARKS.test(text)) return { code: 'es', confidence: 0.95, source: 'diacritics' };
  if (GERMAN_MARKS.test(text)) return { code: 'de', confidence: 0.94, source: 'diacritics' };

  const markCandidates = [];
  if (FRENCH_MARKS.test(text)) markCandidates.push(['fr', latinScore(text, 'fr') + 0.25]);
  if (PORTUGUESE_MARKS.test(text)) markCandidates.push(['pt', latinScore(text, 'pt') + 0.22]);
  if (ITALIAN_MARKS.test(text)) markCandidates.push(['it', latinScore(text, 'it') + 0.18]);

  const lexical = ['es', 'fr', 'vi', 'pt', 'de', 'it']
    .map(code => [code, latinScore(text, code)])
    .concat(markCandidates)
    .sort((a, b) => b[1] - a[1]);

  if (lexical[0]?.[1] >= 0.34 && (!lexical[1] || lexical[0][1] - lexical[1][1] >= 0.08)) {
    return {
      code: lexical[0][0],
      confidence: Math.min(0.93, 0.62 + lexical[0][1]),
      source: 'lexical',
    };
  }

  if (priorLanguage && LANGUAGE_NAMES[priorLanguage]) {
    return { code: priorLanguage, confidence: 0.55, source: 'prior' };
  }

  return { code: 'en', confidence: 0.58, source: 'default' };
}

export function languageName(code) {
  return LANGUAGE_NAMES[code] || 'the viewer’s language';
}

export function languageInstruction(code) {
  const name = languageName(code);
  return [
    `LANGUAGE: Reply in ${name} because that is the viewer's current conversational language.`,
    'Mirror the viewer’s level of formality and keep the Twitch response natural.',
    'Do not translate their message back to them and do not mention language detection.',
    'If the viewer clearly switches languages, follow the language of their newest message.',
  ].join(' ');
}

const FALLBACKS = Object.freeze({
  en: {
    reflect: '🤖 I’m with you on that. Keep the read coming.',
    humor: '⚡ Okay, my chrome felt that one too.',
    analysisQ: '🤖 I’m on backup circuits, but I’m tracking it. What part of that play stood out most?',
    analysis: '🤖 Backup circuits say that looked like a timing/positioning moment worth watching.',
    prediction: '🤖 Quick prediction: next play goes clean or full chaos?',
    generic: '🤖 I’m here on backup circuits for a bit.',
  },
  es: {
    reflect: '🤖 Te sigo. Sigue contando.',
    humor: '⚡ Vale, hasta mi cromo sintió esa.',
    analysisQ: '🤖 Estoy con circuitos de respaldo, pero sigo la conversación. ¿Qué parte de esa jugada te llamó más la atención?',
    analysis: '🤖 Mis circuitos de respaldo dicen que ahí hubo algo interesante de timing o posicionamiento.',
    prediction: '🤖 Predicción rápida: ¿la próxima jugada sale limpia o puro caos?',
    generic: '🤖 Sigo aquí con los circuitos de respaldo.',
  },
  fr: {
    reflect: '🤖 Je te suis. Continue, je veux voir où tu vas.',
    humor: '⚡ OK, même mon chrome a senti celle-là.',
    analysisQ: '🤖 Je tourne sur les circuits de secours, mais je suis la discussion. Qu’est-ce qui t’a le plus marqué dans cette action ?',
    analysis: '🤖 Mes circuits de secours disent que le timing ou le placement mérite d’être regardé.',
    prediction: '🤖 Prédiction rapide : prochaine action propre ou chaos total ?',
    generic: '🤖 Je suis toujours là, sur les circuits de secours.',
  },
  vi: {
    reflect: '🤖 Tôi hiểu ý bạn. Cứ nói tiếp nhé.',
    humor: '⚡ Được rồi, đến lớp chrome của tôi cũng cảm nhận được pha đó.',
    analysisQ: '🤖 Tôi đang chạy bằng mạch dự phòng nhưng vẫn theo dõi cuộc trò chuyện. Pha đó có điểm nào làm bạn chú ý nhất?',
    analysis: '🤖 Mạch dự phòng của tôi cho rằng pha đó đáng xem lại về nhịp xử lý hoặc vị trí.',
    prediction: '🤖 Dự đoán nhanh: pha tiếp theo gọn gàng hay hỗn loạn hoàn toàn?',
    generic: '🤖 Tôi vẫn ở đây, đang chạy bằng mạch dự phòng.',
  },
  ja: {
    reflect: '🤖 なるほど、その読みはわかる。続きも聞かせて。',
    humor: '⚡ その展開、クロームの俺でも効いた。',
    analysisQ: '🤖 今は予備回路だけど会話は追えてる。あのプレイで一番気になったのはどこ？',
    analysis: '🤖 予備回路の分析だと、あれはタイミングかポジショニングが見どころだな。',
    prediction: '🤖 予想しよう。次は綺麗に決まる？それとも大カオス？',
    generic: '🤖 予備回路で稼働中だけど、ちゃんとここにいるよ。',
  },
  zh: {
    reflect: '🤖 我懂你的意思，继续说，我在听。',
    humor: '⚡ 好家伙，这一下连我的镀铬外壳都感受到了。',
    analysisQ: '🤖 我现在用备用电路运行，不过还跟得上聊天。刚才那波你觉得最关键的是哪一点？',
    analysis: '🤖 备用电路判断，那一波的时机或站位很值得回看。',
    prediction: '🤖 快速预测：下一波稳稳拿下，还是直接乱成一团？',
    generic: '🤖 我还在，只是暂时用备用电路运行。',
  },
  ko: {
    reflect: '🤖 무슨 말인지 알겠어. 계속 말해봐.',
    humor: '⚡ 오케이, 그건 내 크롬 장갑도 느꼈다.',
    analysisQ: '🤖 지금은 백업 회로로 돌고 있지만 대화는 따라가고 있어. 방금 플레이에서 뭐가 제일 눈에 띄었어?',
    analysis: '🤖 백업 회로 분석으로는 타이밍이나 포지셔닝이 핵심이었던 것 같아.',
    prediction: '🤖 빠른 예측: 다음 플레이는 깔끔하게 성공, 아니면 대혼돈?',
    generic: '🤖 아직 여기 있어. 잠깐 백업 회로로 작동 중이야.',
  },
  hi: {
    reflect: '🤖 समझ गया। अपनी बात जारी रखो, मैं सुन रहा हूँ।',
    humor: '⚡ ठीक है, वह तो मेरे क्रोम कवच तक महसूस हुआ।',
    analysisQ: '🤖 अभी बैकअप सर्किट पर हूँ, लेकिन बात पकड़ रहा हूँ। उस प्ले में तुम्हें सबसे अहम क्या लगा?',
    analysis: '🤖 बैकअप सर्किट के हिसाब से उस प्ले में टाइमिंग या पोज़िशनिंग देखने लायक थी।',
    prediction: '🤖 झटपट अनुमान: अगला प्ले साफ़ निकलेगा या पूरा हंगामा होगा?',
    generic: '🤖 मैं यहीं हूँ, बस फिलहाल बैकअप सर्किट पर चल रहा हूँ।',
  },
  pt: {
    reflect: '🤖 Tô contigo nessa. Continua a leitura.',
    humor: '⚡ Tá, até meu cromo sentiu essa.',
    analysisQ: '🤖 Estou nos circuitos de reserva, mas acompanhando. O que mais chamou sua atenção nessa jogada?',
    analysis: '🤖 Pelos circuitos de reserva, timing ou posicionamento parecem ter sido o ponto da jogada.',
    prediction: '🤖 Previsão rápida: próxima jogada limpa ou caos total?',
    generic: '🤖 Ainda estou aqui, só rodando nos circuitos de reserva.',
  },
  de: {
    reflect: '🤖 Verstanden. Erzähl weiter.',
    humor: '⚡ Okay, das hat sogar mein Chrom gespürt.',
    analysisQ: '🤖 Ich laufe gerade auf Ersatzschaltkreisen, aber ich folge dem Chat. Was war für dich der wichtigste Teil des Plays?',
    analysis: '🤖 Meine Ersatzschaltkreise sagen: Timing oder Positioning waren da wahrscheinlich entscheidend.',
    prediction: '🤖 Kurze Prognose: nächster Play sauber oder komplettes Chaos?',
    generic: '🤖 Ich bin noch da, gerade nur auf Ersatzschaltkreisen.',
  },
  it: {
    reflect: '🤖 Ti seguo. Continua pure.',
    humor: '⚡ Ok, quella l’ha sentita perfino il mio cromo.',
    analysisQ: '🤖 Sto andando con i circuiti di riserva, ma seguo la chat. Qual è stata la parte più importante di quella giocata per te?',
    analysis: '🤖 I circuiti di riserva dicono che timing o posizionamento erano la parte interessante.',
    prediction: '🤖 Previsione rapida: prossima giocata pulita o caos totale?',
    generic: '🤖 Sono ancora qui, solo con i circuiti di riserva.',
  },
});

export function localizedRetentionFallback({
  code = 'en',
  username = '',
  strategy = 'reflect',
  questionAllowed = true,
} = {}) {
  const locale = FALLBACKS[code] || FALLBACKS.en;
  const name = username ? `@${username} ` : '';
  let text;
  if (strategy === 'prediction' && questionAllowed) text = locale.prediction;
  else if (strategy === 'analysis') text = questionAllowed ? locale.analysisQ : locale.analysis;
  else if (strategy === 'humor') text = locale.humor;
  else text = locale.reflect;
  return name + text;
}

export function localizedGenericFallback({ code = 'en', username = '' } = {}) {
  const locale = FALLBACKS[code] || FALLBACKS.en;
  const name = username ? `@${username} ` : '';
  return name + locale.generic;
}

export const SUPPORTED_LANGUAGE_CODES = Object.freeze(Object.keys(LANGUAGE_NAMES));
