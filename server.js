import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const VERSION = '0.5.0';
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const MAX_BODY = 64 * 1024;
const RATE_WINDOW = 60_000;
const RATE_LIMIT = 60;
const rate = new Map();
let writeQueue = Promise.resolve();

const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Cache-Control': 'no-store'
};

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(DATA, file), 'utf8')); }
  catch { return fallback; }
}
async function writeJson(file, value) {
  const target = path.join(DATA, file);
  const temp = `${target}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temp, target);
  });
  return writeQueue;
}
async function tools() { return readJson('tools.json', []); }
function json(res, status, payload, requestId) {
  res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'X-Request-ID': requestId || crypto.randomUUID() });
  res.end(JSON.stringify(payload));
}
function safeText(v, max=500) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0,max) : ''; }
function rateLimited(ip) {
  const now = Date.now(); const old = rate.get(ip);
  if (rate.size > 10_000) for (const [key, entry] of rate) if (now - entry.start > RATE_WINDOW) rate.delete(key);
  if (!old || now - old.start > RATE_WINDOW) { rate.set(ip, {start:now,count:1}); return false; }
  old.count++; return old.count > RATE_LIMIT;
}
async function body(req) {
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk); }
  if (!size) return {};
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('BAD_JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('BAD_JSON');
  return parsed;
}
function problemFrom(text='') {
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
  for (const [words, p] of map) if (words.some(w => s.includes(w))) return p;
  return 'general';
}
function recommend(all, answers) {
  const text = [answers.problem, answers.industry, answers.current, answers.goal].filter(Boolean).join(' ');
  const problem = problemFrom(text);
  const industry = safeText(answers.industry, 80).toLowerCase().replace(/\s+/g,'-') || 'general';
  const budget = Number(answers.budget || 0);
  const scored = all.filter(t => t.verification === 'verified').map(t => {
    let score = 0;
    if (t.problems.includes(problem)) score += 45;
    if (t.industries.includes(industry) || t.industries.includes('general')) score += 20;
    if (t.freeTier) score += 8;
    if (budget && Number((t.price.match(/\d+/)||['9999'])[0]) <= budget) score += 15;
    if (answers.goal && t.features.some(f => answers.goal.toLowerCase().includes(f.split(' ')[0]))) score += 5;
    score += Math.max(0, 7 - Math.min(7, Math.floor((Date.now() - new Date(t.verifiedAt).getTime()) / 86400000)));
    return {...t, score};
  }).sort((a,b)=>b.score-a.score).slice(0,3);
  return {problem, results: scored, source:'local-matching'};
}
function adminAuthorized(req) {
  if (!ADMIN_KEY || (NODE_ENV === 'production' && ADMIN_KEY.length < 24)) return false;
  const supplied = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const expected = Buffer.from(ADMIN_KEY);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
async function audit(event, req, extra={}) {
  const list = await readJson('audit.json', []);
  list.push({ id: crypto.randomUUID(), event, ip: req.socket.remoteAddress || 'unknown', at: new Date().toISOString(), ...extra });
  await writeJson('audit.json', list.slice(-5000));
}
function publicTool(t) {
  if (!t) return null;
  const { affiliate, licenseStatus, sourceType, ...safe } = t;
  return safe;
}
function outputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  if (!Array.isArray(data?.output)) return '';
  return data.output.filter(item => item?.type === 'message' && Array.isArray(item.content)).flatMap(item => item.content).filter(part => part?.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('');
}
async function aiDiagnose(answers, verifiedTools) {
  if (!OPENAI_API_KEY) return null;
  const catalog = verifiedTools.map(t => ({ id:t.id, name:t.name, description:t.description, category:t.category, problems:t.problems, industries:t.industries, features:t.features, integrations:t.integrations, price:t.price, difficulty:t.difficulty, freeTier:t.freeTier, url:t.url, verifiedAt:t.verifiedAt }));
  const system = `You are ForgeAI, a business software diagnosis assistant. Diagnose the user's operational problem, ask no more questions in this response, and recommend only tools present in the supplied VERIFIED catalog. Never invent a feature, price, integration, URL, or tool. If the catalog lacks a strong fit, say so. Affiliate relationships are irrelevant to ranking. Return concise JSON with keys: diagnosis (string), bottlenecks (array of strings), recommendations (array of objects with toolId, why, caveats), nextStep (string).`;
  const input = JSON.stringify({answers, verifiedCatalog:catalog});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method:'POST', headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:OPENAI_MODEL,instructions:system,input,text:{format:{type:'json_object'}},store:false}), signal:controller.signal
    });
    if (!r.ok) throw new Error(`AI provider returned ${r.status}`);
    const data = await r.json();
    const text = safeText(outputText(data), 8000);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI returned non-object JSON');
    parsed.bottlenecks = Array.isArray(parsed.bottlenecks) ? parsed.bottlenecks.map(x=>safeText(x,200)).filter(Boolean).slice(0,6) : [];
    const ids = new Set(verifiedTools.map(t=>t.id));
    parsed.recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations.filter(x=>ids.has(x?.toolId)).slice(0,3) : [];
    return { ...parsed, source:'ai+verified-catalog' };
  } finally { clearTimeout(timer); }
}
async function discover(req, res, requestId) {
  if (!adminAuthorized(req)) return json(res, 401, {error:'Unauthorized'}, requestId);
  const b = await body(req);
  const url = safeText(b.url, 300);
  if (!/^https:\/\//i.test(url)) return json(res, 400, {error:'Only HTTPS source URLs are accepted.'}, requestId);
  const sourceType = safeText(b.sourceType, 60);
  const licenseStatus = safeText(b.licenseStatus, 100);
  if (!['licensed-api','open-license','vendor-permission'].includes(sourceType)) return json(res, 400, {error:'Source type must establish permission to reuse data.'}, requestId);
  if (!licenseStatus) return json(res, 400, {error:'License/permission status is required.'}, requestId);
  const item = {
    id: `discovered-${crypto.randomUUID()}`,
    name: safeText(b.name, 100), description: safeText(b.description, 600), url,
    category: safeText(b.category, 80), problems: Array.isArray(b.problems)?b.problems.map(x=>safeText(x,60)).slice(0,20):[],
    industries: Array.isArray(b.industries)?b.industries.map(x=>safeText(x,60)).slice(0,20):['general'],
    features: Array.isArray(b.features)?b.features.map(x=>safeText(x,80)).slice(0,30):[],
    integrations: Array.isArray(b.integrations)?b.integrations.map(x=>safeText(x,80)).slice(0,30):[],
    price: safeText(b.price,80), difficulty: safeText(b.difficulty,30), freeTier: !!b.freeTier,
    verification:'unverified', verifiedAt:null, sourceType, licenseStatus, affiliate:false, discoveredAt:new Date().toISOString()
  };
  if (!item.name || !item.description) return json(res,400,{error:'Name and description are required.'},requestId);
  const current = await tools(); current.push(item); await writeJson('tools.json', current);
  await audit('tool.discovered', req, {toolId:item.id, sourceType, licenseStatus});
  return json(res, 201, {ok:true, item}, requestId);
}
async function api(req,res,url,requestId) {
  if (rateLimited(req.socket.remoteAddress || 'unknown')) return json(res,429,{error:'Too many requests. Try again shortly.'},requestId);
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res,200,{ok:true,aiConfigured:Boolean(OPENAI_API_KEY),version:VERSION},requestId);
  if (req.method === 'GET' && url.pathname === '/api/tools') {
    const all = await tools(); const q=safeText(url.searchParams.get('q'),100).toLowerCase(); const cat=safeText(url.searchParams.get('category'),80); const ind=safeText(url.searchParams.get('industry'),80).toLowerCase();
    const out=all.filter(t=>t.verification==='verified').filter(t=>!q || [t.name,t.description,t.category,...t.problems,...t.features].join(' ').toLowerCase().includes(q)).filter(t=>!cat||t.category===cat).filter(t=>!ind||t.industries.includes(ind)||t.industries.includes('general')).map(publicTool);
    return json(res,200,{tools:out},requestId);
  }
  if (req.method === 'POST' && url.pathname === '/api/diagnose') {
    try {
      const b=await body(req); const answers={problem:safeText(b.problem,700),industry:safeText(b.industry,80),current:safeText(b.current,500),goal:safeText(b.goal,500),budget:Math.max(0,Math.min(100000,Number(b.budget)||0))};
      if(!answers.problem) return json(res,400,{error:'Tell us what is going wrong.'},requestId);
      const verified = (await tools()).filter(t=>t.verification==='verified');
      let r = null;
      try { r = await aiDiagnose(answers, verified); } catch (e) { await audit('ai.fallback', req, {reason:e.message.slice(0,120)}); }
      if (!r) r = recommend(verified,answers);
      if (r.results) r.results = r.results.map(publicTool);
      if (r.recommendations) r.recommendations = r.recommendations.map(x=>({ ...x, tool:publicTool(verified.find(t=>t.id===x.toolId)) }));
      return json(res,200,r,requestId);
    } catch(e) { return json(res,e.message==='BODY_TOO_LARGE'?413:400,{error:'Invalid request.'},requestId); }
  }
  if (req.method === 'POST' && url.pathname === '/api/feedback') {
    try { const b=await body(req); const feedback={id:crypto.randomUUID(),toolId:safeText(b.toolId,100),outcome:['yes','partial','no'].includes(b.outcome)?b.outcome:'unknown',createdAt:new Date().toISOString()}; const list=await readJson('feedback.json',[]); list.push(feedback); await writeJson('feedback.json',list); return json(res,201,{ok:true},requestId); } catch { return json(res,400,{error:'Invalid request.'},requestId); }
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/discover') return discover(req,res,requestId).catch(e => json(res,e.message==='BODY_TOO_LARGE'?413:400,{error:'Invalid request.'},requestId));
  return json(res,404,{error:'Not found'},requestId);
}
async function serve(req,res,requestId) {
  let file;
  try { file = decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/, '') || 'index.html'; }
  catch { return json(res,400,{error:'Bad path'},requestId); }
  const publicRoot = path.resolve(PUBLIC); const target = path.resolve(PUBLIC, file);
  if (!target.startsWith(publicRoot + path.sep)) return json(res,403,{error:'Forbidden'},requestId);
  try { const data=await fs.readFile(target); const ext=path.extname(target); const type={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.json':'application/json'}[ext]||'application/octet-stream'; res.writeHead(200,{...securityHeaders,'Content-Type':type,'Cache-Control': (ext==='.html'||ext==='.webmanifest'||ext==='.js')?'no-store':'public, max-age=3600','X-Request-ID':requestId}); res.end(data); } catch { json(res,404,{error:'Not found'},requestId); }
}
if (NODE_ENV === 'production' && !ADMIN_KEY) console.error('SECURITY: ADMIN_KEY must be set in production.');
const server=http.createServer(async (req,res)=>{ const requestId=crypto.randomUUID(); try { const u=new URL(req.url,`http://${req.headers.host||'localhost'}`); if(u.pathname.startsWith('/api/')) return await api(req,res,u,requestId); return await serve(req,res,requestId); } catch { return json(res,500,{error:'Internal server error',requestId},requestId); } });
server.listen(PORT,()=>console.log(`ForgeAI v${VERSION} listening on http://localhost:${PORT}`));
