'use strict';
// Sandbox stand-in for an AI-intensive feature (M5 demo). No model is called: the summary is
// built from catalog data after a short delay. AI_SUMMARY_FAIL_RATE (0..1) injects failures so
// the "quota is given back when the work fails" path can be exercised.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateSummary(product) {
  await sleep(Number(process.env.AI_SUMMARY_DELAY_MS ?? 300));
  if (Math.random() < Number(process.env.AI_SUMMARY_FAIL_RATE || 0)) throw new Error('AI backend unavailable (injected failure)');
  const name = product.name || product.slug || product.id;
  return [
    `${name}: a self-paced course.`,
    `Key ideas: the fundamentals of ${name.toLowerCase()}, worked examples, and practice exercises.`,
    `Suggested pace: about ${Math.max(2, Math.round((product.priceCents || 1000) / 1000))} hours a week.`,
  ].join(' ');
}

module.exports = { generateSummary };
