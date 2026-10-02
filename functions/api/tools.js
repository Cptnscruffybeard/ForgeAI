import { loadTools, publicTool, response, safeText } from './_shared.js';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const q = safeText(url.searchParams.get('q'), 100).toLowerCase();
    const category = safeText(url.searchParams.get('category'), 80);
    const industry = safeText(url.searchParams.get('industry'), 80).toLowerCase();
    const all = await loadTools(context.request);
    const tools = all
      .filter(t => t.verification === 'verified')
      .filter(t => !q || [t.name, t.description, t.category, ...t.problems, ...t.features].join(' ').toLowerCase().includes(q))
      .filter(t => !category || t.category === category)
      .filter(t => !industry || t.industries.includes(industry) || t.industries.includes('general'))
      .map(publicTool);
    return response({ tools });
  } catch {
    return response({ error: 'Directory unavailable.' }, 500);
  }
}
