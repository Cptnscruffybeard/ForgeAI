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
  if (new TextEncoder().encode(text).length > MAX_BODY) throw new Error('BODY_TOO_LARGE');
  if (!text) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('BAD_JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('BAD_JSON');
  return parsed;
}

export function response(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

export async function loadTools(context) {
  const url = new URL('/data/tools.json', context.request.url);
  const result = context.env?.ASSETS ? await context.env.ASSETS.fetch(url) : await fetch(url);
  if (!result.ok) throw new Error('CATALOG_UNAVAILABLE');
  const tools = await result.json();
  if (!Array.isArray(tools)) throw new Error('CATALOG_UNAVAILABLE');
  return tools;
}

export function publicTool(tool) {
  if (!tool) return null;
  const { affiliate, licenseStatus, sourceType, score, ...safe } = tool;
  return safe;
}

const PROBLEM_KEYWORDS = [
  [['estimate', 'quote', 'proposal', 'bid'], 'slow-estimates'],
  [['invoice', 'bookkeep', 'accounting', 'expense'], 'bookkeeping'],
  [['call', 'phone', 'answering', 'missed'], 'missed-calls'],
  [['lead', 'customer', 'follow up', 'follow-up'], 'lead-follow-up'],
  [['schedule', 'appointment', 'booking'], 'appointment-booking'],
  [['social', 'content', 'marketing', 'post'], 'content-production'],
  [['repetitive', 'manual', 'copy and paste', 'data entry'], 'repetitive-work']
];

export const PROBLEM_LABELS = {
  'lead-follow-up': 'lead follow-up',
  'slow-estimates': 'estimating and proposals',
  'missed-calls': 'missed calls',
  bookkeeping: 'bookkeeping',
  'appointment-booking': 'appointment scheduling',
  'content-production': 'content production',
  'repetitive-work': 'repetitive admin work',
  general: 'the workflow you described'
};

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keywordPattern = word => new RegExp(`\\b${escapeRegex(word)}`, 'i');

export function problemFrom(text = '') {
  for (const [words, problem] of PROBLEM_KEYWORDS) {
    if (words.some(w => keywordPattern(w).test(text))) return problem;
  }
  return 'general';
}

export function priceValue(price) {
  const match = String(price || '').replace(/,/g, '').match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : Infinity;
}

export function recommend(all, answers) {
  const text = [answers.problem, answers.industry, answers.current, answers.goal].filter(Boolean).join(' ');
  const problem = problemFrom(text);
  const industry = safeText(answers.industry, 80).toLowerCase().replace(/\s+/g, '-') || 'general';
  const budget = Number(answers.budget || 0);
  const goal = safeText(answers.goal, 500).toLowerCase();
  const scored = all.filter(t => t.verification === 'verified').map(t => {
    const problems = t.problems || [];
    const industries = t.industries || [];
    const features = t.features || [];
    let score = 0;
    if (problems.includes(problem)) score += 45;
    if (industries.includes(industry) || industries.includes('general')) score += 20;
    if (t.freeTier) score += 8;
    if (budget && priceValue(t.price) <= budget) score += 15;
    if (goal && features.some(f => goal.includes(String(f).split(' ')[0].toLowerCase()))) score += 5;
    const ageDays = Math.floor((Date.now() - new Date(t.verifiedAt).getTime()) / 86400000);
    if (Number.isFinite(ageDays)) score += Math.max(0, 7 - Math.min(7, Math.max(0, ageDays)));
    return { ...t, score };
  }).sort((a, b) => b.score - a.score).slice(0, 3);
  return {
    problem,
    diagnosis: `Your bottleneck looks like ${PROBLEM_LABELS[problem]}.`,
    bottlenecks: [
      problem === 'general' ? 'We need more signal to identify the exact bottleneck.' : `Primary issue: ${PROBLEM_LABELS[problem]}`,
      'Matches shown only from the verified catalog.'
    ],
    results: scored,
    source: 'local-matching'
  };
}

export function extractOutputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .filter(item => item?.type === 'message' && Array.isArray(item.content))
    .flatMap(item => item.content)
    .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

export function sanitizeDiagnosis(parsed, verifiedTools) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI returned non-object JSON');
  const ids = new Set(verifiedTools.map(t => t.id));
  const recommendations = Array.isArray(parsed.recommendations)
    ? parsed.recommendations
      .filter(x => x && ids.has(x.toolId))
      .slice(0, 3)
      .map(x => ({
        toolId: x.toolId,
        why: safeText(x.why, 600),
        caveats: Array.isArray(x.caveats)
          ? x.caveats.map(c => safeText(c, 300)).filter(Boolean).slice(0, 5)
          : safeText(x.caveats, 600)
      }))
    : [];
  return {
    diagnosis: safeText(parsed.diagnosis, 600),
    bottlenecks: Array.isArray(parsed.bottlenecks)
      ? parsed.bottlenecks.map(b => safeText(b, 200)).filter(Boolean).slice(0, 6)
      : [],
    recommendations,
    nextStep: safeText(parsed.nextStep, 600),
    source: 'ai+verified-catalog'
  };
}

export async function aiDiagnose(answers, verifiedTools, env) {
  if (!env?.OPENAI_API_KEY) return null;
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
        text: { format: { type: 'json_object' } },
        store: false
      }),
      signal: controller.signal
    });
    if (!result.ok) throw new Error(`AI provider returned ${result.status}`);
    const data = await result.json();
    return sanitizeDiagnosis(JSON.parse(extractOutputText(data)), verifiedTools);
  } finally {
    clearTimeout(timer);
  }
}
