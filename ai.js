// ai.js — server-side AI client for match analysis.
// Same Gemini-primary / Groq-fallback pattern as the JuanAi frontend,
// but running on the server so it can work in the background without
// a browser tab open.

const GEMINI_KEY = process.env.GEMINI_KEY || '';
const GROQ_KEY = process.env.GROQ_KEY || '';
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash'];
const GROQ_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function callGemini(model, systemPrompt, userPrompt, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: maxTokens || 2048, temperature: 0.7 }
    })
  });
  if (!resp.ok) throw new Error('Gemini HTTP ' + resp.status);
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('Gemini: no content in response');
  const txt = parts.map(p => p.text || '').join('').trim();
  if (!txt) throw new Error('Gemini: empty text');
  return txt;
}

async function callGroq(model, systemPrompt, userPrompt, maxTokens) {
  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: maxTokens || 2048,
      temperature: 0.7
    })
  });
  if (!resp.ok) throw new Error('Groq HTTP ' + resp.status);
  const data = await resp.json();
  const txt = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!txt || !txt.trim()) throw new Error('Groq: empty response');
  return txt.trim();
}

// Tries Gemini models first, then Groq models. Throws only if everything fails —
// callers must treat a thrown error as "could not analyze this match right now",
// never fall back to fabricated data.
async function aiOnce(systemPrompt, userPrompt, maxTokens) {
  const errors = [];
  if (GEMINI_KEY) {
    for (const model of GEMINI_MODELS) {
      try { return await callGemini(model, systemPrompt, userPrompt, maxTokens); }
      catch (e) { errors.push(`gemini:${model}: ${e.message}`); }
    }
  }
  if (GROQ_KEY) {
    for (const model of GROQ_MODELS) {
      try { return await callGroq(model, systemPrompt, userPrompt, maxTokens); }
      catch (e) { errors.push(`groq:${model}: ${e.message}`); }
    }
  }
  throw new Error('All AI engines failed: ' + errors.join(' | '));
}

function buildFootballPrompt(match) {
  const home = (match.homeTeam && match.homeTeam.name) || 'Home Team';
  const away = (match.awayTeam && match.awayTeam.name) || 'Away Team';
  const comp = (match.competition && match.competition.name) || 'Unknown League';
  const date = match.utcDate ? new Date(match.utcDate).toLocaleDateString() : 'Unknown Date';
  const status = match.status || 'SCHEDULED';

  return `Analyze this football match and generate professional betting odds.

Match: ${home} vs ${away}
Competition: ${comp}
Date: ${date}
Status: ${status}

Using your knowledge of these teams (form, head-to-head, squad quality, home advantage, league position, recent results), generate realistic fair odds and predictions.

Return ONLY this JSON (no other text, no markdown):
{"homeWin":1.85,"draw":3.40,"awayWin":4.20,"over25":1.72,"under25":2.10,"btts":1.68,"bttsNo":2.15,"dc_home_draw":1.22,"dc_home_away":1.30,"dc_draw_away":1.95,"prediction":"Home Win","confidence":68,"risk":"Medium","valueBet":"Over 2.5 Goals","xgHome":1.8,"xgAway":0.9,"analysis":"Brief 1-2 sentence professional analysis explaining the prediction"}`;
}

function parseAiOdds(text) {
  if (!text) return null;
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(clean.substring(start, end + 1));
    if (!obj.homeWin || !obj.draw || !obj.awayWin) return null;
    ['homeWin', 'draw', 'awayWin', 'over25', 'under25', 'btts', 'bttsNo', 'dc_home_draw', 'dc_home_away', 'dc_draw_away']
      .forEach(k => { obj[k] = parseFloat(obj[k]) || null; });
    obj.confidence = parseInt(obj.confidence) || 60;
    return obj;
  } catch (e) { return null; }
}

async function analyzeMatch(match) {
  const prompt = buildFootballPrompt(match);
  const raw = await aiOnce(
    'You are an expert football analyst and odds compiler. Analyze the match and return ONLY valid JSON with the exact structure requested. No other text.',
    prompt,
    1200
  );
  const odds = parseAiOdds(raw);
  if (!odds) throw new Error('Could not parse AI response as valid odds JSON');
  odds.aiGenerated = true; // always explicit — never presented as real market odds
  return odds;
}

module.exports = { analyzeMatch, aiOnce };
