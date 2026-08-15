// ai.js — server-side AI client for match analysis.
// Same Gemini-primary / Groq-fallback pattern as the JuanAi frontend,
// but running on the server so it can work in the background without
// a browser tab open.
//
// MULTI-KEY ROTATION: both GEMINI_KEY and GROQ_KEY support multiple
// comma-separated keys, same pattern as FDORG_KEY (footballData.js) and
// ODDSAPIIO_KEY (realOdds.js). This was added after a real production bug:
// putting a comma-separated key LIST into what used to be a single-key
// field caused every single request to send the whole joined string as one
// invalid key, which both providers correctly rejected with 401 — every
// analysis failed until this was built. Each key in the list is now parsed
// separately and rotated independently on failure.

const realOdds = require('./realOdds');

const GEMINI_KEYS = (process.env.GEMINI_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
const GROQ_KEYS = (process.env.GROQ_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
const GEMINI_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash']; // both confirmed live/current as of this build — the previous list (gemini-2.0-flash, gemini-1.5-flash) were BOTH shut down by Google (2.0-flash on June 1 2026, all 1.5 models earlier), which is why every call was 404ing. If these ever start 404ing too, check https://ai.google.dev/gemini-api/docs/models for the current model list before assuming it's a quota issue.
const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']; // migrated from llama-3.3-70b-versatile / llama-3.1-8b-instant — Groq is decommissioning both on August 16, 2026 (official deprecation notice, console.groq.com/docs/deprecations). These are Groq's own recommended replacements for each respective model's role (120b ≈ the old 70b "versatile" primary, 20b ≈ the old 8b "instant" fallback). Response shape is unchanged — GPT-OSS keeps any reasoning content in a separate `reasoning` field, not mixed into `message.content`, so callGroq's existing parsing needed no changes. NOTE: these free-tier models have a considerably lower daily request cap (1,000/day combined per Groq's published free-tier table) than the old llama-3.1-8b-instant had (14,400/day) — worth keeping in mind if Groq-side rate-limiting increases after this migration; that's a genuine capacity change, not a bug.
const GROQ_VISION_MODEL = 'llama-3.2-11b-vision-preview';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Independent rotation state per key, per provider — a bad/exhausted key on
// one provider never affects the other, and within a provider, each key's
// own cooldown is tracked separately.
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000; // 429 = genuinely temporary, retry after this
const AUTH_FAILURE_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 401 = key is invalid/revoked/unauthorized — this does NOT fix itself by waiting, so give it a long cooldown rather than retrying a permanently-broken key every 15 min forever (which was the actual bug: a single bad key among several good ones kept cycling back into rotation and failing repeatedly, making the whole pool look perpetually stuck even when other keys were fine)
const geminiKeyState = GEMINI_KEYS.map(key => ({ key, blockedUntil: 0 }));
const groqKeyState = GROQ_KEYS.map(key => ({ key, blockedUntil: 0 }));
let nextGeminiKeyIndex = 0;
let nextGroqKeyIndex = 0;

function pickAvailableKey(keyState, nextIndexRef) {
  const now = Date.now();
  for (let i = 0; i < keyState.length; i++) {
    const idx = (nextIndexRef.value + i) % keyState.length;
    if (now >= keyState[idx].blockedUntil) {
      nextIndexRef.value = (idx + 1) % keyState.length;
      return keyState[idx];
    }
  }
  return null;
}

async function callGemini(model, systemPrompt, userPrompt, maxTokens) {
  const idxRef = { value: nextGeminiKeyIndex };
  const state = pickAvailableKey(geminiKeyState, idxRef);
  nextGeminiKeyIndex = idxRef.value;
  if (!state) throw new Error('All ' + geminiKeyState.length + ' Gemini key(s) currently blocked/cooling down');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${state.key}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: maxTokens || 2048, temperature: 0.7 }
    })
  });
  if (!resp.ok) {
    // 401 (invalid/unauthorized key) is very likely PERMANENT — waiting
    // won't fix a genuinely bad key, so give it a long cooldown instead of
    // retrying it every 15 minutes forever. 429 (rate limited) genuinely
    // is temporary, so it gets the short cooldown. Tracking WHY a key is
    // blocked (not just that it is) lets /api/status show something
    // actionable instead of just "blocked" with no explanation.
    if (resp.status === 401) {
      state.blockedUntil = Date.now() + AUTH_FAILURE_COOLDOWN_MS;
      state.blockedReason = '401 Unauthorized — this key is likely invalid, revoked, or lacks API access. Check it directly at https://aistudio.google.com/apikey';
    } else if (resp.status === 429) {
      state.blockedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      state.blockedReason = '429 Rate limited — temporary, will retry automatically';
    }
    throw new Error('Gemini HTTP ' + resp.status);
  }
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('Gemini: no content in response');
  const txt = parts.map(p => p.text || '').join('').trim();
  if (!txt) throw new Error('Gemini: empty text');
  return txt;
}

// ── Streaming variants, for the chat-proxy route (server.js's
// /api/chat/stream) ──────────────────────────────────────────────────
// These return the raw fetch Response (not parsed text) so the server
// route can pipe the provider's own SSE stream straight through to the
// browser byte-for-byte — no need to re-parse and re-emit the stream
// format server-side, which would be extra complexity for no benefit
// since the frontend already knows how to parse each provider's SSE
// shape. Same key rotation/cooldown state as the non-streaming
// callGemini/callGroq above — a key blocked for one still counts as
// blocked for the other, since it's the same underlying key.

async function streamGeminiRaw(model, systemPrompt, contents, maxTokens, temperature) {
  const idxRef = { value: nextGeminiKeyIndex };
  const state = pickAvailableKey(geminiKeyState, idxRef);
  nextGeminiKeyIndex = idxRef.value;
  if (!state) throw new Error('All ' + geminiKeyState.length + ' Gemini key(s) currently blocked/cooling down');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${state.key}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens || 8192, temperature: temperature != null ? temperature : 0.7 }
    })
  });
  if (!resp.ok) {
    if (resp.status === 401) { state.blockedUntil = Date.now() + AUTH_FAILURE_COOLDOWN_MS; state.blockedReason = '401 Unauthorized'; }
    else if (resp.status === 429) { state.blockedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS; state.blockedReason = '429 Rate limited'; }
    const errText = await resp.text().catch(() => '');
    const err = new Error('Gemini HTTP ' + resp.status + ': ' + errText);
    err.status = resp.status;
    throw err;
  }
  return resp; // caller (server.js) pipes resp.body straight to the client
}

async function streamGroqRaw(model, messages, maxTokens, temperature) {
  const idxRef = { value: nextGroqKeyIndex };
  const state = pickAvailableKey(groqKeyState, idxRef);
  nextGroqKeyIndex = idxRef.value;
  if (!state) throw new Error('All ' + groqKeyState.length + ' Groq key(s) currently blocked/cooling down');

  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.key },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens || 4096,
      temperature: temperature != null ? temperature : 0.7,
      stream: true
    })
  });
  if (!resp.ok) {
    if (resp.status === 401) { state.blockedUntil = Date.now() + AUTH_FAILURE_COOLDOWN_MS; state.blockedReason = '401 Unauthorized'; }
    else if (resp.status === 429) { state.blockedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS; state.blockedReason = '429 Rate limited'; }
    const errText = await resp.text().catch(() => '');
    const err = new Error('Groq HTTP ' + resp.status + ': ' + errText);
    err.status = resp.status;
    throw err;
  }
  return resp;
}

async function callGroq(model, systemPrompt, userPrompt, maxTokens) {
  const idxRef = { value: nextGroqKeyIndex };
  const state = pickAvailableKey(groqKeyState, idxRef);
  nextGroqKeyIndex = idxRef.value;
  if (!state) throw new Error('All ' + groqKeyState.length + ' Groq key(s) currently blocked/cooling down');

  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.key },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: maxTokens || 2048,
      temperature: 0.7
    })
  });
  if (!resp.ok) {
    if (resp.status === 401) {
      state.blockedUntil = Date.now() + AUTH_FAILURE_COOLDOWN_MS;
      state.blockedReason = '401 Unauthorized — this key is likely invalid, revoked, or lacks API access. Check it directly at https://console.groq.com/keys';
    } else if (resp.status === 429) {
      state.blockedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      state.blockedReason = '429 Rate limited — temporary, will retry automatically';
    }
    throw new Error('Groq HTTP ' + resp.status);
  }
  const data = await resp.json();
  const txt = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!txt || !txt.trim()) throw new Error('Groq: empty response');
  return txt.trim();
}

// Tries Gemini models first, then Groq models. Throws only if everything fails —
// callers must treat a thrown error as "could not analyze this match right now",
// never fall back to fabricated data.
async function aiOnce(systemPrompt, userPrompt, maxTokens) {
  if (!GEMINI_KEYS.length && !GROQ_KEYS.length) {
    throw new Error('No AI engine configured — set GEMINI_KEY and/or GROQ_KEY in your .env file (see .env.example). At least one is required to generate odds.');
  }

  // CRITICAL FIX: check whether ANY key across BOTH providers is actually
  // available BEFORE attempting any calls. The old code always tried every
  // Gemini model, then every Groq model, on every single match — meaning
  // one match's analysis could burn up to 4 real API calls (2 Gemini
  // models + 2 Groq models) even when the entire pool was already known to
  // be exhausted from the previous match's attempt a few seconds earlier.
  // With 6 matches/pass, that meant up to 24 real API calls every 90s, not
  // 6 — a 4x under-count that was the actual cause of the pool never
  // recovering despite reduced match-level pacing. Now we fail fast with
  // zero wasted calls once we already know nothing is available.
  const now = Date.now();
  const geminiAvailable = geminiKeyState.some(s => now >= s.blockedUntil);
  const groqAvailable = groqKeyState.some(s => now >= s.blockedUntil);
  if (!geminiAvailable && !groqAvailable) {
    throw new Error('All AI engines failed: entire key pool (Gemini + Groq) currently blocked/cooling down — skipping without wasting further calls');
  }

  const errors = [];
  if (GEMINI_KEYS.length && geminiAvailable) {
    for (const model of GEMINI_MODELS) {
      try { return await callGemini(model, systemPrompt, userPrompt, maxTokens); }
      catch (e) {
        errors.push(`gemini:${model}: ${e.message}`);
        // If that call just exhausted the last available Gemini key, stop
        // trying further Gemini models immediately rather than burning
        // another call against a now-guaranteed-blocked key.
        if (!geminiKeyState.some(s => Date.now() >= s.blockedUntil)) break;
      }
    }
  }
  if (GROQ_KEYS.length && groqAvailable) {
    for (const model of GROQ_MODELS) {
      try { return await callGroq(model, systemPrompt, userPrompt, maxTokens); }
      catch (e) {
        errors.push(`groq:${model}: ${e.message}`);
        if (!groqKeyState.some(s => Date.now() >= s.blockedUntil)) break;
      }
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

  // Tournaments played at neutral or semi-neutral venues (World Cup,
  // continental championships, etc) should NOT get the same home-advantage
  // weighting as a normal domestic league fixture — "home" in the fixture
  // list often just reflects which team is listed first, not which team is
  // actually playing on home soil. Treating a World Cup "home" team as if
  // they have a real crowd/travel advantage is a common, avoidable source
  // of unrealistic odds (e.g. skewing heavily toward the "home" side even
  // when the other team is clearly the stronger squad).
  const neutralVenueKeywords = ['world cup', 'euro', 'copa america', 'nations league', 'confederations cup', 'afcon', 'asian cup'];
  const isLikelyNeutralVenue = neutralVenueKeywords.some(kw => comp.toLowerCase().includes(kw));
  const venueNote = isLikelyNeutralVenue
    ? '\n\nIMPORTANT: This is a major international tournament match, very likely at a neutral or semi-neutral venue. Do NOT apply normal domestic-league home-advantage weighting just because one team is listed as "home" — that likely just reflects fixture-list order, not an actual home-crowd/travel advantage. Base your odds primarily on actual squad quality, current form, and tournament context instead.'
    : '';

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
Status: ${status}${venueNote}${historyBlock}

Using the real historical data above (form, head-to-head record) plus your knowledge of squad quality, home advantage (where genuinely applicable — see note above), and league context, generate realistic fair odds and predictions grounded in that evidence rather than reputation alone.

BEFORE finalizing your numbers, sanity-check them against BOTH squad reputation AND the real recent-form data above (when available) — this applies to every match, not just major tournaments: if one team is a widely-recognized stronger squad (reigning champion, significantly higher league position, better-resourced club) AND/OR has clearly better real recent form/head-to-head record from the data above, your odds should reflect that combined picture. A team that is both the more reputable side AND in better recent real form should not come out as a significant underdog (4.00+) against a clearly weaker, worse-form opponent (1.80 or shorter) without a specific, stated reason you can point to in the real data (e.g. the head-to-head record actually favors the "weaker" side, or their recent form data shows wins against the "stronger" side's recent opponents). If you can't point to a specific piece of the real data above that justifies an odds gap contradicting known team strength, revise the odds to better reflect the teams' actual relative strength instead of leaning on an unstated assumption.

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

HARD BOUNDS — these are non-negotiable, since violating them produces mathematically invalid or meaningless odds:
- NO odds value may ever be below 1.01. Real bookmaker odds are NEVER below 1.00 — an odd below 1.00 would mean guaranteed profit with zero risk, which no bookmaker ever offers, no matter how certain an outcome looks (red cards, late collapses, and injuries always keep some residual uncertainty). Even a near-certain outcome (e.g. a 3-0 lead in the 88th minute) should floor at roughly 1.01-1.03, not below.
- NO odds value should realistically exceed about 60-80 for any market, even a near-impossible comeback — extremely long prices still need to look like a real quoted number, not an arbitrary huge one.
- "valueBet" must name a market that is GENUINELY uncertain enough to represent value — never name a value bet on a market you've just priced as a near-certainty (e.g. don't say "Value Bet: Away Win" if you've also priced Away Win at 1.02, since there's no meaningful value in a bet that short). If every market is already a near-certainty given the scoreline, set valueBet to "None" rather than inventing a value bet that doesn't make sense.

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
      .forEach(k => {
        let v = parseFloat(obj[k]) || null;
        // Hard deterministic clamp — this is enforced in code, not left to
        // prompt instructions alone, because we saw the AI produce a real
        // 0.99 odd in production (mathematically invalid: any odd below
        // 1.00 implies guaranteed profit with zero risk, which no real
        // bookmaker ever offers, no matter how certain an outcome looks).
        // 1.01 floor, 80 ceiling — both sides of unrealistic.
        if (v !== null) v = Math.min(80, Math.max(1.01, v));
        obj[k] = v;
      });
    obj.confidence = parseInt(obj.confidence) || 60;
    return obj;
  } catch (e) { return null; }
}

// Builds a prompt for when we ALREADY have real market odds from SharpAPI —
// the AI's job here is narrower: add value-bet analysis and a confidence
// read on top of a REAL price, not invent one. This is the more honest path
// whenever real odds are available; see analyzeMatch() below for when this
// gets used vs the full buildFootballPrompt() fallback.
function buildValueBetPrompt(match, realOddsData, history) {
  const home = (match.homeTeam && match.homeTeam.name) || 'Home Team';
  const away = (match.awayTeam && match.awayTeam.name) || 'Away Team';
  const comp = (match.competition && match.competition.name) || 'Unknown League';

  let historyBlock = '';
  if (history) {
    historyBlock = '\n\nReal recent form/head-to-head:\n- ' + formatH2H(history.h2h)
      + '\n- ' + formatForm(history.homeForm, home)
      + '\n- ' + formatForm(history.awayForm, away);
  }

  return `Real bookmaker market odds for this match (via ${realOddsData.provider}, from ${realOddsData.sportsbook}):
${home} ${realOddsData.homeWin} / Draw ${realOddsData.draw} / ${away} ${realOddsData.awayWin}${historyBlock}

Competition: ${comp}

These are REAL market odds already, not something to reinvent. Your job is only to add value: identify whether there's a value bet (a market where the real odds look mispriced given the form/history), estimate implied probabilities from these real odds, and give a brief professional analysis. Do NOT invent different homeWin/draw/awayWin numbers — echo the real ones back exactly.

Return ONLY this JSON (no other text, no markdown):
{"homeWin":${realOddsData.homeWin},"draw":${realOddsData.draw},"awayWin":${realOddsData.awayWin},"over25":null,"under25":null,"btts":null,"bttsNo":null,"dc_home_draw":null,"dc_home_away":null,"dc_draw_away":null,"prediction":"Home Win","confidence":68,"risk":"Medium","valueBet":"Home Win looks undervalued given recent form","xgHome":null,"xgAway":null,"analysis":"Brief 1-2 sentence analysis of whether these real odds represent value given the form/history"}`;
}

// Deterministic sanity check — NOT a correction, just a flag for visibility.
// We don't have a reliable external "true team strength" source to check
// generated odds against, so rather than silently second-guessing the AI
// with another guess, this only catches an INTERNAL contradiction: if the
// AI is highly confident in a prediction, the predicted side's own odds
// shouldn't simultaneously look like a massive underdog price. That
// combination (high confidence + huge underdog price for the side it just
// picked) means the AI's own numbers disagree with its own prediction,
// which is worth surfacing regardless of which specific number is "right".
function flagInternalInconsistency(odds) {
  if (!odds.confidence || !odds.prediction) return odds;
  const predictedOdds = odds.prediction === 'Home Win' ? odds.homeWin
    : odds.prediction === 'Away Win' ? odds.awayWin
    : odds.draw;
  if (!predictedOdds) return odds;

  // High confidence (70%+) but the side it's confident about is priced as
  // a significant underdog (3.5+, i.e. under ~29% implied probability)
  // means the odds and the prediction are pulling in different directions.
  if (odds.confidence >= 70 && predictedOdds >= 3.5) {
    odds.consistencyWarning = 'AI stated ' + odds.confidence + '% confidence in "' + odds.prediction
      + '" but priced that same outcome at ' + predictedOdds + ' (a significant underdog price) — '
      + 'these are internally inconsistent. Treat this match\'s odds with extra caution.';
    console.warn('[ai] Internal inconsistency flagged: confidence=' + odds.confidence + '% but predictedOdds=' + predictedOdds + ' for prediction="' + odds.prediction + '"');
  }
  return odds;
}

async function analyzeMatch(match, history, liveState) {
  const isLiveRepricing = !!liveState;

  // Real market odds are only meaningful for pre-match analysis — SharpAPI's
  // free tier has a ~60s data delay, which is too slow to track a live
  // score the way the dedicated live-repricing prompt does. So live
  // re-pricing always stays on the AI path; only pre-match analysis tries
  // real odds first.
  let realOddsData = null;
  if (!isLiveRepricing) {
    const home = match.homeTeam && match.homeTeam.name;
    const away = match.awayTeam && match.awayTeam.name;
    if (home && away) {
      realOddsData = await realOdds.getRealOddsForMatch(home, away);
    }
  }

  const prompt = isLiveRepricing
    ? buildLivePrompt(match, liveState, match.aiOdds)
    : realOddsData
      ? buildValueBetPrompt(match, realOddsData, history)
      : buildFootballPrompt(match, history);

  const systemPrompt = isLiveRepricing
    ? 'You are an expert in-play football odds trader. Re-price the match based STRICTLY on the current score, minute, and time remaining provided — do not just restate pre-match odds. Return ONLY valid JSON with the exact structure requested. No other text.'
    : realOddsData
      ? 'You are an expert football betting analyst. You have been given REAL market odds — your job is to analyze them for value, not invent new numbers. Return ONLY valid JSON with the exact structure requested. No other text.'
      : 'You are an expert football analyst and odds compiler. Analyze the match using the real historical data provided and return ONLY valid JSON with the exact structure requested. No other text.';

  const raw = await aiOnce(systemPrompt, prompt, 1200);
  const rawOdds = parseAiOdds(raw);
  if (!rawOdds) throw new Error('Could not parse AI response as valid odds JSON');

  let odds;
  if (realOddsData) {
    // Real odds are the actual market price — apply margin on top of them
    // (same structural-edge logic as AI odds), but do NOT let the AI's
    // returned homeWin/draw/awayWin override the real ones, in case it
    // ignored the instruction to echo them back exactly.
    const realBase = Object.assign({}, rawOdds, {
      homeWin: realOddsData.homeWin,
      draw: realOddsData.draw,
      awayWin: realOddsData.awayWin
    });
    odds = applyMargin(realBase, DEFAULT_MARGIN);
    odds.isRealMarketOdds = true;
    odds.realOddsSource = realOddsData.sportsbook;
    odds.realOddsProvider = realOddsData.provider;
    odds.realOddsFetchedAt = realOddsData.fetchedAt;
    // REAL HANDICAP (added on request from a partner site that was
    // previously estimating this themselves from our 1X2 odds, since we
    // had no handicap field at all before this). Only ever present when
    // odds-api.io actually returned a Spread market for this match — see
    // realOdds.js's getFromOddsApiIo. There is no AI-estimated fallback
    // for this field by design: JuanAi never had a handicap estimate to
    // begin with, so leaving it null/absent when unavailable is more
    // honest than inventing one now, especially since partners already
    // have their own reasonable estimate to fall back on.
    if (realOddsData.handicap) {
      const [hHome, hAway] = applyMarginToGroup([realOddsData.handicap.home, realOddsData.handicap.away], DEFAULT_MARGIN);
      odds.handicap = {
        line: realOddsData.handicap.line,
        home: hHome,
        away: hAway,
        isRealMarketOdds: true
      };
    }
  } else {
    // Apply bookmaker-style margin — this is what actually gives the platform
    // a structural edge, distinct from the AI's raw "fair" probability guess.
    // See applyMargin() above for why this is deterministic code, not
    // something asked of the AI itself.
    odds = applyMargin(rawOdds, DEFAULT_MARGIN);
    odds.isRealMarketOdds = false;
    // Real odds don't need this check — they're a genuine market price, not
    // an AI guess that could internally contradict itself. Only flag
    // consistency issues for the AI-generated path.
    if (!isLiveRepricing) flagInternalInconsistency(odds);
  }

  odds.aiGenerated = !odds.isRealMarketOdds; // only true when the AI actually invented the price, not when it's just analyzing a real one
  odds.usedRealHistory = !!history; // transparency: was this grounded in real data or model knowledge only
  odds.isLiveRepriced = isLiveRepricing; // transparency: were these odds updated based on live score/minute
  if (isLiveRepricing) {
    odds.liveAt = { minute: liveState.minute, homeGoals: liveState.homeGoals, awayGoals: liveState.awayGoals, capturedAt: Date.now() };
  }
  return odds;
}

function getAiKeyPoolStatus() {
  const now = Date.now();
  function summarize(keyState) {
    return {
      totalKeys: keyState.length,
      availableKeys: keyState.filter(s => now >= s.blockedUntil).length,
      blockedKeys: keyState.filter(s => now < s.blockedUntil).map(s => ({
        keyPreview: s.key.slice(0, 8) + '...' + s.key.slice(-4), // widened from a plain 8-char prefix — Gemini's newer key format apparently shares a longer fixed prefix across genuinely different keys (confirmed: 11 separate-account keys all showed identical "AQ.Ab8RN..." with only 8 chars), so a prefix-only preview couldn't actually distinguish them. Adding the last 4 characters (which are far more likely to differ) makes this diagnostic actually useful for confirming keys are genuinely distinct rather than duplicates.
        reason: s.blockedReason || 'unknown',
        availableInMinutes: Math.ceil((s.blockedUntil - now) / 60000)
      }))
    };
  }
  return { gemini: summarize(geminiKeyState), groq: summarize(groqKeyState) };
}

module.exports = { analyzeMatch, aiOnce, applyMargin, DEFAULT_MARGIN, getAiKeyPoolStatus, streamGeminiRaw, streamGroqRaw, GEMINI_MODELS, GROQ_MODELS, GROQ_VISION_MODEL };
