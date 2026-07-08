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

function formatForm(form, teamName) {
  if (!form || !form.length) return teamName + ': recent form data unavailable';
  const line = form.map(function(m) { return m.result + ' (' + m.score + ' vs ' + m.opponent + ', ' + m.venue + ')'; }).join(', ');
  return teamName + ' last ' + form.length + ': ' + line;
}

function formatH2H(h2h) {
  if (!h2h || !h2h.numberOfMatches) return 'No head-to-head history available.';
  let line = 'Last ' + h2h.numberOfMatches + ' meetings: home side won ' + h2h.homeTeamWins +
    ', away side won ' + h2h.awayTeamWins + ', ' + h2h.draws + ' draws.';
  if (h2h.recentMatches && h2h.recentMatches.length) {
    line += ' Recent results: ' + h2h.recentMatches.map(function(m) {
      return m.home + ' ' + m.score + ' ' + m.away + ' (' + m.competition + ')';
    }).join('; ') + '.';
  }
  return line;
}

function buildFootballPrompt(match, history) {
  const home = (match.homeTeam && match.homeTeam.name) || 'Home Team';
  const away = (match.awayTeam && match.awayTeam.name) || 'Away Team';
  const comp = (match.competition && match.competition.name) || 'Unknown League';
  const date = match.utcDate ? new Date(match.utcDate).toLocaleDateString() : 'Unknown Date';
  const status = match.status || 'SCHEDULED';

  let historyBlock = '';
  if (history) {
    historyBlock = '\n\nREAL HISTORICAL DATA (from football-data.org, use this as your primary evidence):\n'
      + '- Head-to-head: ' + formatH2H(history.h2h) + '\n'
      + '- ' + formatForm(history.homeForm, home) + '\n'
      + '- ' + formatForm(history.awayForm, away) + '\n'
      + 'Weigh this real data heavily — it reflects actual recent results, not just reputation.';
  } else {
    historyBlock = '\n\nNo real historical data could be fetched for this match (API limit or lookup failure) — '
      + 'fall back to your general knowledge of these teams, but flag lower confidence accordingly.';
  }

  return `Analyze this football match and generate professional betting odds.

Match: ${home} vs ${away}
Competition: ${comp}
Date: ${date}
Status: ${status}${historyBlock}

Using the real historical data above (form, head-to-head record) plus your knowledge of squad quality, home advantage, and league context, generate realistic fair odds and predictions grounded in that evidence rather than reputation alone.

Return ONLY this JSON (no other text, no markdown):
{"homeWin":1.85,"draw":3.40,"awayWin":4.20,"over25":1.72,"under25":2.10,"btts":1.68,"bttsNo":2.15,"dc_home_draw":1.22,"dc_home_away":1.30,"dc_draw_away":1.95,"prediction":"Home Win","confidence":68,"risk":"Medium","valueBet":"Over 2.5 Goals","xgHome":1.8,"xgAway":0.9,"analysis":"Brief 1-2 sentence professional analysis referencing the actual form/H2H data used"}`;
}

// Builds a LIVE re-pricing prompt — this is what fixes odds staying frozen
// at pre-match numbers after kickoff (e.g. a team already down 0-1 still
// showing as the pre-match favorite). Unlike buildFootballPrompt, this does
// NOT lean on head-to-head/pre-match form — what matters now is the actual
// score, time elapsed, and time remaining, the same way a real bookmaker's
// in-play odds move as a game develops.
function buildLivePrompt(match, liveState, previousOdds) {
  const home = (match.homeTeam && match.homeTeam.name) || 'Home Team';
  const away = (match.awayTeam && match.awayTeam.name) || 'Away Team';
  const comp = (match.competition && match.competition.name) || 'Unknown League';
  const minute = liveState.minute != null ? liveState.minute : '?';
  const hg = liveState.homeGoals != null ? liveState.homeGoals : 0;
  const ag = liveState.awayGoals != null ? liveState.awayGoals : 0;
  const statusLabel = liveState.status === 'PAUSED' ? 'Half-time / Paused' : 'In Play';

  let priorBlock = '';
  if (previousOdds && previousOdds.homeWin) {
    priorBlock = `\n\nPRE-MATCH ODDS FOR REFERENCE (do not just repeat these — they reflected the situation BEFORE kickoff, and must shift to reflect what has actually happened so far):\nHome ${previousOdds.homeWin} / Draw ${previousOdds.draw} / Away ${previousOdds.awayWin}`;
  }

  return `Re-price this LIVE, in-progress football match based on what has actually happened so far — this is an in-play odds update, not a pre-match prediction.

Match: ${home} vs ${away}
Competition: ${comp}
Match status: ${statusLabel}, minute ${minute}
CURRENT SCORE: ${home} ${hg} - ${ag} ${away}${priorBlock}

Re-price the odds to reflect the CURRENT game state:
- If a team is leading, their win odds must shorten (lower number = more likely) roughly in proportion to the goal difference and how much time is left. A 1-0 lead at minute 85 is much safer than a 1-0 lead at minute 10 — reflect that.
- If it's goalless or level, weight the draw and both win markets based on time remaining and which side has been dominant, not pre-match reputation.
- Over/under goal lines must account for goals ALREADY scored plus realistic further scoring given time left (e.g. if it's already 2-1 with 20 minutes left, Over 2.5 should already be very short since 3 goals have been scored).
- BTTS should reflect whether both teams have already scored, or how likely the team with 0 goals is to score in the time remaining.
- Confidence should generally be HIGHER than pre-match confidence once there's real in-game evidence (a scoreline), not lower.

Return ONLY this JSON (no other text, no markdown):
{"homeWin":1.85,"draw":3.40,"awayWin":4.20,"over25":1.72,"under25":2.10,"btts":1.68,"bttsNo":2.15,"dc_home_draw":1.22,"dc_home_away":1.30,"dc_draw_away":1.95,"prediction":"Home Win","confidence":68,"risk":"Medium","valueBet":"Over 2.5 Goals","xgHome":1.8,"xgAway":0.9,"analysis":"Brief 1-2 sentence analysis referencing the current score/minute and why the odds moved"}`;
}

// ── Margin/overround — turns the AI's "fair" probability estimate into
// bookmaker-style priced odds with a real structural edge, the same way a
// real book never offers true 50/50 on a coin flip (they'd offer something
// like 1.91/1.91, which pays out less than 100% of implied probability).
// This is deterministic math, not something we ask the AI to reason about —
// LLMs are unreliable at precise arithmetic under instruction, and margin
// application needs to be exact and auditable.

const DEFAULT_MARGIN = parseFloat(process.env.ODDS_MARGIN || '0.06'); // 6% overround by default — adjust via env var

// Converts one group of "fair" odds (e.g. [homeWin, draw, awayWin]) into
// margin-adjusted odds. Each fair odd is first converted to an implied
// probability (1/odd), the probabilities are scaled up so they sum to
// (1 + margin) instead of 1, then converted back to odds. This spreads the
// margin proportionally across all outcomes in the group, matching how real
// books build overround into a market rather than just shortening everything
// by a flat amount.
function applyMarginToGroup(oddsArr, margin) {
  const probs = oddsArr.map(o => (o && o > 1) ? 1 / o : null);
  if (probs.some(p => p === null)) return oddsArr; // missing data — leave untouched rather than guess
  const fairSum = probs.reduce((a, b) => a + b, 0);
  if (fairSum <= 0) return oddsArr;
  // Scale so the group's implied probabilities sum to (1 + margin) instead of 1.
  const scale = (1 + margin) / fairSum;
  return probs.map(p => {
    const marginedProb = p * scale;
    return marginedProb > 0 ? Math.round((1 / marginedProb) * 100) / 100 : null;
  });
}

// Applies margin across every market group in an odds object, and records
// what was done for transparency/auditing — never silently repriced without
// a trace of the original AI "fair" numbers.
function applyMargin(rawOdds, margin) {
  const m = margin != null ? margin : DEFAULT_MARGIN;
  const fair = {
    homeWin: rawOdds.homeWin, draw: rawOdds.draw, awayWin: rawOdds.awayWin,
    over25: rawOdds.over25, under25: rawOdds.under25,
    btts: rawOdds.btts, bttsNo: rawOdds.bttsNo,
    dc_home_draw: rawOdds.dc_home_draw, dc_home_away: rawOdds.dc_home_away, dc_draw_away: rawOdds.dc_draw_away
  };

  const [homeWin, draw, awayWin] = applyMarginToGroup([rawOdds.homeWin, rawOdds.draw, rawOdds.awayWin], m);
  const [over25, under25] = applyMarginToGroup([rawOdds.over25, rawOdds.under25], m);
  const [btts, bttsNo] = applyMarginToGroup([rawOdds.btts, rawOdds.bttsNo], m);
  // Double chance odds are derived from the 1X2 group's margined probabilities,
  // not margined independently — otherwise you'd double-apply the edge and
  // the three DC markets (which overlap 1X2 combinations) would be
  // internally inconsistent with the main match-result market.
  const dc = deriveDoubleChanceFromMargined(homeWin, draw, awayWin);

  return Object.assign({}, rawOdds, {
    homeWin, draw, awayWin, over25, under25, btts, bttsNo,
    dc_home_draw: dc.home_draw, dc_home_away: dc.home_away, dc_draw_away: dc.draw_away,
    fairOdds: fair,        // the AI's original pre-margin estimate, kept for auditing
    marginApplied: m       // e.g. 0.06 = 6% overround
  });
}

function deriveDoubleChanceFromMargined(homeWin, draw, awayWin) {
  const pHome = homeWin ? 1 / homeWin : 0;
  const pDraw = draw ? 1 / draw : 0;
  const pAway = awayWin ? 1 / awayWin : 0;
  const safe = (p) => p > 0 ? Math.round((1 / p) * 100) / 100 : null;
  return {
    home_draw: safe(pHome + pDraw),
    home_away: safe(pHome + pAway),
    draw_away: safe(pDraw + pAway)
  };
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

async function analyzeMatch(match, history, liveState) {
  const isLiveRepricing = !!liveState;
  const prompt = isLiveRepricing
    ? buildLivePrompt(match, liveState, match.aiOdds)
    : buildFootballPrompt(match, history);

  const systemPrompt = isLiveRepricing
    ? 'You are an expert in-play football odds trader. Re-price the match based STRICTLY on the current score, minute, and time remaining provided — do not just restate pre-match odds. Return ONLY valid JSON with the exact structure requested. No other text.'
    : 'You are an expert football analyst and odds compiler. Analyze the match using the real historical data provided and return ONLY valid JSON with the exact structure requested. No other text.';

  const raw = await aiOnce(systemPrompt, prompt, 1200);
  const rawOdds = parseAiOdds(raw);
  if (!rawOdds) throw new Error('Could not parse AI response as valid odds JSON');

  // Apply bookmaker-style margin — this is what actually gives the platform
  // a structural edge, distinct from the AI's raw "fair" probability guess.
  // See applyMargin() above for why this is deterministic code, not
  // something asked of the AI itself.
  const odds = applyMargin(rawOdds, DEFAULT_MARGIN);

  odds.aiGenerated = true; // always explicit — never presented as real market odds
  odds.usedRealHistory = !!history; // transparency: was this grounded in real data or model knowledge only
  odds.isLiveRepriced = isLiveRepricing; // transparency: were these odds updated based on live score/minute
  if (isLiveRepricing) {
    odds.liveAt = { minute: liveState.minute, homeGoals: liveState.homeGoals, awayGoals: liveState.awayGoals, capturedAt: Date.now() };
  }
  return odds;
}

module.exports = { analyzeMatch, aiOnce, applyMargin, DEFAULT_MARGIN };
