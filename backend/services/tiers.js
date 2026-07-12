/**
 * Chatbot capability tiers — gates study-tool features per project.
 *
 * Separate from backend/plans.js, which gates usage volume (messages,
 * storage, project count) by billing plan. This gates *which features*
 * a chatbot has, independent of what the owner is paying for.
 *
 * Tiers are cumulative: medium includes everything basic has, advanced
 * includes everything medium has.
 */
const TIERS = ['basic', 'medium', 'advanced'];

const FEATURES_BY_TIER = {
  basic: {
    referencedImages: false,
    videoRecommendations: false,
    slides: false,
    quizzes: false,
    flashcards: false,
    progressTracking: false,
  },
  medium: {
    referencedImages: true,
    videoRecommendations: true,
    slides: true,
    quizzes: false,
    flashcards: false,
    progressTracking: false,
  },
  advanced: {
    referencedImages: true,
    videoRecommendations: true,
    slides: true,
    quizzes: true,
    flashcards: true,
    progressTracking: true,
  },
};

/** Returns the feature-flag object for a tier, defaulting to 'basic' for unknown values. */
function featuresFor(tier) {
  return FEATURES_BY_TIER[tier] || FEATURES_BY_TIER.basic;
}

function isValidTier(tier) {
  return TIERS.includes(tier);
}

/** True if `tier` is at or above `min` in the basic → medium → advanced order. */
function meetsTier(tier, min) {
  const ti = TIERS.indexOf(tier);
  const mi = TIERS.indexOf(min);
  if (ti === -1 || mi === -1) return false;
  return ti >= mi;
}

module.exports = { TIERS, featuresFor, isValidTier, meetsTier };
