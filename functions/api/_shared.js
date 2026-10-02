const MAX_BODY = 64 * 1024;

export function safeText(value, max = 500) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
    : '';
}

export async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY) throw new Error('BODY_TOO_LARGE');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('BODY_TOO_LARGE');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error('BAD_JSON'); }
}

export function response(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

export async function loadTools(request) {
  const url = new URL('/data/tools.json', request.url);
  const result = await fetch(url);
  if (!result.ok) throw new Error('CATALOG_UNAVAILABLE');
  return result.json();
}

export function publicTool(tool) {
  if (!tool) return null;
  const { affiliate, licenseStatus, sourceType, ...safe } = tool;
  return safe;
}

export function problemFrom(text = '') {
  const s = text.toLowerCase();
  const map = [
    [['estimate','quote','proposal','bid'], 'slow-estimates'],
    [['invoice','bookkeep','accounting','expense'], 'bookkeeping'],
    [['call','phone','answering','missed'], 'missed-calls'],
    [['lead','customer','follow up','follow-up'], 'lead-follow-up'],
    [['schedule','appointment','booking'], 'appointment-booking'],
    [['social','content','marketing','post'], 'content-production'],
    [['repetitive','manual','copy and paste','data entry'], 'repetitive-work']
  ];
  for (const [words, problem] of map) if (words.some(w => s.includes(w))) return problem;
  return 'general';
}

export function recommend(all, answers) {
  const text = [answers.problem, answers.industry, answers.current, answers.goal].filter(Boolean).join(' ');
  const problem = problemFrom(text);
  const industry = safeText(answers.industry, 80).toLowerCase().replace(/\s+/g, '-') || 'general';
  const budget = Number(answers.budget || 0);
  const scored = all.filter(t => t.verification === 'verified').map(t => {
    let score = 0;
    if (t.problems.includes(problem)) score += 45;
    if (t.industries.includes(industry) || t.industries.includes('general')) score += 20;
    if (t.freeTier) score += 8;
    if (budget && Number((t.price.match(/\d+/) || ['9999'])[0]) <= budget) score += 15;
    if (answers.goal && t.features.some(f => answers.goal.toLowerCase().includes(f.split(' ')[0]))) score += 5;
    score += Math.max(0, 7 - Math.min(7, Math.floor((Date.now() - new Date(t.verifiedAt).getTime()) / 86400000)));
    return { ...t, score };
  }).sort((a, b) => b.score - a.score).slice(0, 3);
  return { problem, results: scored, source: 'local-matching' };
}

export async function aiDiagnose(answers, verifiedTools, env) {
  if (!env.OPENAI_API_KEY) return null;
  const catalog = verifiedTools.map(t => ({
    id:t.id, name:t.name, description:t.description, category:t.category,
    problems:t.problems, industries:t.industries, features:t.features,
    integrations:t.integrations, price:t.price, difficulty:t.difficulty,
    freeTier:t.freeTier, url:t.url, verifiedAt:t.verifiedAt
  }));
  const instructions = `You are ForgeAI, a business software diagnosis assistant. Diagnose the user's operational problem and recommend only tools present in the supplied VERIFIED catalog. Never invent a feature, price, integration, URL, or tool. If the catalog lacks a strong fit, say so. Affiliate relationships are irrelevant to ranking. Return concise JSON with keys: diagnosis (string), bottlenecks (array of strings), recommendations (array of objects with toolId, why, caveats), nextStep (string).`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const result = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || 'gpt-5.6-luna',
        instructions,
        input: JSON.stringify({ answers, verifiedCatalog: catalog }),
        store: false
      }),
      signal: controller.signal
    });
    if (!result.ok) throw new Error(`AI provider returned ${result.status}`);
    const data = await result.json();
    const text = safeText(data.output_text, 8000);
    const parsed = JSON.parse(text);
    const ids = new Set(verifiedTools.map(t => t.id));
    parsed.recommendations = Array.isArray(parsed.recommendations)
      ? parsed.recommendations.filter(x => ids.has(x?.toolId)).slice(0, 3)
      : [];
    return { ...parsed, source: 'ai+verified-catalog' };
  } finally {
    clearTimeout(timer);
  }
}
