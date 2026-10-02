import { aiDiagnose, loadTools, publicTool, readJson, recommend, response, safeText } from './_shared.js';

export async function onRequestPost(context) {
  let body;
  try {
    body = await readJson(context.request);
  } catch (error) {
    return error.message === 'BODY_TOO_LARGE'
      ? response({ error: 'Request too large.' }, 413)
      : response({ error: 'Invalid request.' }, 400);
  }
  const answers = {
    problem: safeText(body.problem, 700),
    industry: safeText(body.industry, 80),
    current: safeText(body.current, 500),
    goal: safeText(body.goal, 500),
    budget: Math.max(0, Math.min(100000, Number(body.budget) || 0))
  };
  if (!answers.problem) return response({ error: 'Tell us what is going wrong.' }, 400);
  let verified;
  try {
    verified = (await loadTools(context)).filter(t => t.verification === 'verified');
  } catch {
    return response({ error: 'Directory unavailable.' }, 503);
  }
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
}
