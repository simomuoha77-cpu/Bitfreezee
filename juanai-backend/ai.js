// ai.js — server-side AI client for match analysis.
//
// IMPORTANT CHANGE: the AI no longer invents odds from "its knowledge of the
// teams". That produced plausible-looking numbers with no connection to a
// real market -- not correct odds, just guesses.
//
// Now the flow is: oddsData.js fetches REAL bookmaker odds first. The AI's
// job is to analyze those real odds -- explain the market's view, flag value,
// give a confidence read -- the way a professional analyst writes a match
// preview around a real bookmaker's board. If no real odds exist yet for a
// match, the AI is not called at all; the match is simply marked as
// "odds not yet posted", never backfilled with invented numbers.

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
      generationConfig: { maxOutputTokens: maxTokens || 2048, temperature: 0.6 }
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
      temperature: 0.6
    })
  });
  if (!resp.ok) throw new Error('Groq HTTP ' + resp.status);
  const data = await resp.json();
  const txt = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!txt || !txt.trim()) throw new Error('Groq: empty response');
  return txt.trim();
}

// Tries Gemini models first, then Groq models. Throws only if everything fails --
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

// Builds a prompt around REAL odds already fetched from a real bookmaker
// (see oddsData.js). The AI is asked to interpret this real market, not
// invent one.
function buildAnalysisPrompt(match, realOdds) {
  const home = (match.homeTeam && match.homeTeam.name) || 'Home Team';
  const away = (match.awayTeam && match.awayTeam.name) || 'Away Team';
  const comp = (match.competition && match.competition.name) || 'Unknown League';
  const date = match.utcDate ? new Date(match.utcDate).toLocaleDateString() : 'Unknown Date';

  return `You are analyzing a REAL bookmaker's odds board for an upcoming football match. These odds are real market prices from ${realOdds.source}, not estimates -- treat them as ground truth for what the market thinks.

Match: ${home} vs ${away}
Competition: ${comp}
Date: ${date}

Real bookmaker odds (${realOdds.source}):
1X2: Home ${realOdds.homeWin} / Draw ${realOdds.draw} / Away ${realOdds.awayWin}
Over/Under 2.5: Over ${realOdds.over25 ?? 'n/a'} / Under ${realOdds.under25 ?? 'n/a'}
BTTS: Yes ${realOdds.btts ?? 'n/a'} / No ${realOdds.bttsNo ?? 'n/a'}
Double Chance: 1X ${realOdds.dc_home_draw ?? 'n/a'} / 12 ${realOdds.dc_home_away ?? 'n/a'} / X2 ${realOdds.dc_draw_away ?? 'n/a'}

Your job: read what this real market is pricing in, and write a short professional analyst's take -- like a match preview a paid tipster service would publish next to real odds. Do NOT invent different odds. Use the numbers given. Base your prediction and confidence on what these real prices imply (convert to implied probability if useful), plus sound football reasoning about the teams and competition context.

Return ONLY this JSON (no other text, no markdown):
{"prediction":"Home Win","confidence":68,"risk":"Medium","valueBet":"Over 2.5 Goals","analysis":"Brief 2-3 sentence professional analysis of what the market is saying and where the value might be, grounded in the real odds above"}`;
}

function parseAiAnalysis(text) {
  if (!text) return null;
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(clean.substring(start, end + 1));
    if (!obj.prediction || !obj.analysis) return null;
    obj.confidence = parseInt(obj.confidence) || 60;
    return obj;
  } catch (e) { return null; }
}

// Combines real bookmaker odds with an AI-written analysis layered on top.
// realOdds must come from oddsData.js (getRealOdds) -- this function does not
// fetch odds itself, so callers control that flow and can skip analysis
// entirely when no real odds exist yet for a match.
async function analyzeMatch(match, realOdds) {
  if (!realOdds) {
    throw new Error('No real odds available for this match yet -- cannot analyze without a real market to read');
  }

  const prompt = buildAnalysisPrompt(match, realOdds);
  const raw = await aiOnce(
    'You are a professional football betting analyst writing preview commentary for real bookmaker odds. You never invent odds -- you only interpret real prices given to you. Return ONLY valid JSON with the exact structure requested. No other text.',
    prompt,
    900
  );
  const analysis = parseAiAnalysis(raw);
  if (!analysis) throw new Error('Could not parse AI response as valid analysis JSON');

  return Object.assign({}, realOdds, analysis, {
    aiGenerated: false,       // the odds are real
    aiAnalysisGenerated: true // only the commentary is AI-written
  });
}

module.exports = { analyzeMatch, aiOnce };
