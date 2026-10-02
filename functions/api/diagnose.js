import { aiDiagnose, loadTools, publicTool, readJson, recommend, response, safeText } from './_shared.js';

export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const answers = {
      problem: safeText(body.problem, 700),
      industry: safeText(body.industry, 80),
      current: safeText(body.current, 500),
      goal: safeText(body.goal, 500),
      budget: Math.max(0, Math.min(100000, Number(body.budget) || 0))
    };
    if (!answers.problem) return response({ error: 'Tell us what is going wrong.' }, 400);
    const verified = (await loadTools(context.request)).filter(t => t.verification === 'verified');
    let result = null;
    try { result = await aiDiagnose(answers, verified, context.env); } catch { result = null; }
    if (!result) result = recommend(verified, answers);
    if (result.results) result.results = result.results.map(publicTool);
    if (result.recommendations) {
      result.recommendations = result.recommendations.map(item => ({
        ...item,
        tool: publicTool(verified.find(t => t.id === item.toolId))
      }));
    }
    return response(result);
  } catch (error) {
    return response({ error: error.message === 'BODY_TOO_LARGE' ? 'Request too large.' : 'Invalid request.' }, 400);
  }
}
