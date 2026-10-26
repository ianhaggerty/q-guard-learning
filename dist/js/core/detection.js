// How likely the explorer is to notice an event at a point. The curve and its 90 %
// maximum are simulation assumptions, not calibrated measurements.
//
//   P(1 s) = 0.9 × max(0, 1 − |eccentricity| / 100°) / (1 + distance / halfRange)
//
// Exposure over t seconds at fixed conditions combines as P(t) = 1 − (1 − P(1 s))^t,
// which is a constant hazard of −ln(1 − P(1 s)) per second.

/** Horizontal field of view in degrees (±100° around the facing direction). */
export const FIELD_OF_VIEW = 200;
export const DETECTION_PEAK = 0.9;
/** Distance in metres at which the probability halves. Adjustable while exploring. */
export const DETECTION_HALF_RANGE = 10;

/** One-second detection probability. There is no range cutoff. */
export function detectionChance(distanceMetres, eccentricityDegrees, halfRange = DETECTION_HALF_RANGE) {
  const valid = Number.isFinite(distanceMetres) && distanceMetres >= 0
    && Number.isFinite(eccentricityDegrees)
    && Number.isFinite(halfRange) && halfRange > 0;
  if (!valid) throw new Error('Invalid detection parameters.');
  const angularFactor = Math.max(0, 1 - Math.abs(eccentricityDegrees) / (FIELD_OF_VIEW / 2));
  return DETECTION_PEAK * angularFactor / (1 + distanceMetres / halfRange);
}

/** Constant per-second hazard equivalent to a one-second probability. */
export function hazardFromChance(chancePerSecond) {
  return -Math.log1p(-chancePerSecond);
}

/** Probability of detection over `seconds` of continuous exposure. */
export function chanceOverTime(chancePerSecond, seconds) {
  return -Math.expm1(seconds * Math.log1p(-chancePerSecond));
}
