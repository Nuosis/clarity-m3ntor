import { dimensions, steps, categoricalScale } from './questions.mjs';

export function validateRatings(ratings) {
  for (const key of dimensions) {
    const value = ratings?.[key];
    if (!categoricalScale.some(item => item.category === value?.category)) throw new Error(`Provide a categorical assessment for ${key}.`);
    if (!Number.isInteger(value?.score) || value.score < 1 || value.score > 10 || !value.rationale?.trim()) throw new Error(`Provide a 1–10 integer rating and rationale for ${key}.`);
  }
}

export function coachReport(a) {
  // USER-AUTHORIZED — Marcus, November 15, 2026: only non-sensitive data is
  // shared with Coach. Never serialize the local assessment or CONTEXT.md.
  const report = a.shareableReport;
  if (report?.privacyReviewed !== true) throw new Error('The local harness must prepare and review a non-sensitive report before sharing.');
  validateRatings(report.ratings);
  if (!report.summary?.trim()) throw new Error('A non-sensitive report summary is required.');
  const sections = steps.map(step => {
    const text = report.sections?.[step.id];
    if (!text?.trim()) throw new Error(`The non-sensitive report needs a ${step.title} section.`);
    return { section: step.id, title: step.title, text };
  });
  return {
    type: 'clarity_coach.pom_agency_report@2',
    assessmentId: a.id,
    revisionId: report.revisionId,
    status: 'submitted for coaching; recommendations are draft',
    summary: report.summary,
    sections,
    ratings: Object.fromEntries(dimensions.map(key => [key, { category: report.ratings[key].category, score: report.ratings[key].score, rationale: report.ratings[key].rationale }])),
  };
}
