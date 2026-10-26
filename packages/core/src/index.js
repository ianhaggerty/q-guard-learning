// Public API of the simulation core. The core has no DOM dependencies and runs both in
// the browser and under Node (see test/).

export { GRID, METRES_PER_PIXEL, EXPLORER_RADIUS, WALL_THICKNESS, CHAIR_SIZE } from './scale.js';
export { MATERIAL, MATERIAL_NAMES, COLORS, RGB, toRGBA, materialsFromRGBA } from './materials.js';
export { fillRect, floodFill, traceLine } from './raster.js';
export { MAX_FLOORS, normalizeMap, ensureMap, createBlankMap, addFloor } from './map.js';
export { snap, brushBounds, paintGrid, gridLine, gridRect } from './grid.js';
export { defaultValue, valueAt, hasCustomValue, selectionRect, assignValue, valueSummary } from './values.js';
export {
  STAIR_FLIGHT_LENGTH, STAIR_FLIGHT_WIDTH, STAIR_RETURN_WIDTH, STAIR_LANDING_DEPTH, STAIR_STYLE, STAIR_GEOMETRY,
  connectsFloor, stairSize, worldToStair, stairToWorld, stairContains, stairClearance, stairFlightLength,
  returnLanes, stairCrossing, validateStair, addStair, removeStair,
} from './stairs.js';
export {
  CHAIR_SEAT_HEIGHT, chairContains, isChairSpotClear, validateChair, addChair, removeChair, pruneChairs, chairFront,
} from './chairs.js';
export { MAX_STARTS, validateStart, setStart, removeStart } from './starts.js';
export { eraseAt } from './eraser.js';
export { groupDoors } from './doors.js';
export { isGridAligned, alignGrid } from './migrations.js';
export { encodeMap, decodeMap, cloneMap, MIN_MAP_SIZE, MAX_MAP_SIZE } from './serialization.js';
export { DIRECTIONS, LOOK_OFFSETS, isBackwardLook, headingVector, eccentricityDegrees } from './facing.js';
export { FIELD_OF_VIEW, DETECTION_PEAK, DETECTION_HALF_RANGE, detectionChance } from './detection.js';
export { BODY_MASS_KG, ACTIVITIES, EnergyTracker, kcalPerMinute } from './energy.js';
export { EVENT_RATE, EventSimulation } from './events.js';
export { ProbabilityField, updateUnresolvedMean } from './probability.js';
export { SIGHT_CACHE_BYTES, SightCache } from './sight.js';
export { Explorer } from './explorer.js';
export { World } from './world.js';
