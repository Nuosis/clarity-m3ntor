import { dimensions, categoricalScale } from './questions.mjs';

export function validateRatings(ratings) {
  for (const key of dimensions) {
    const value = ratings?.[key];
    if (!categoricalScale.some(item => item.category === value?.category)) throw new Error(`Provide a categorical assessment for ${key}.`);
    if (!Number.isInteger(value?.score) || value.score < 1 || value.score > 10 || !value.rationale?.trim()) throw new Error(`Provide a 1–10 integer rating and rationale for ${key}.`);
  }
}
