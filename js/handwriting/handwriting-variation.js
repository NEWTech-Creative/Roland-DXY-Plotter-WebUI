/**
 * Handwriting Variation Module
 * Handles seeded randomness and procedural distortion.
 */

/**
 * Seeded random generator (Mulberry32)
 * @param {number} seed 
 * @returns {function} random function
 */
function mulberry32(seed) {
    return function () {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

class HandwritingVariation {
    constructor(seed = 1234) {
        this.setSeed(seed);
    }

    setSeed(seed) {
        this.seed = (seed === undefined || seed === null) ? 1234 : seed;
        this.random = mulberry32(this.seed);
    }

    /**
     * Applies variation to a set of strokes.
     * @param {Array} strokes - Array of points
     * @param {Object} options - { slant, messiness, characterHeight }
     * @returns {Array} - Transformed strokes
     */
    apply(strokes, options) {
        const { slant = 0, messiness = 0, characterHeight = 6, style = 'print' } = options;
        const isCursive = style === 'cursive';

        // Remap messiness for better control
        const effectiveSlant = isCursive ? Math.max(-8, Math.min(12, slant)) : slant;
        const m = (messiness || 0) * (isCursive ? 0.06 : 0.15);

        // Character-level drift
        const charDriftX = (this.random() - 0.5) * m * (isCursive ? 0.35 : 0.8);
        const charDriftY = (this.random() - 0.5) * m * (isCursive ? 0.2 : 0.4);

        const processedStrokes = strokes.map(stroke => {
            if (stroke.length === 0) return stroke;

            // 1. Initial point distribution & slant/jitter
            let varied = stroke.map(pt => {
                // Lean right for positive slant: shift top (y=0) right, baseline (y=1) stays
                const slantOffset = (1.0 - pt.y) * (effectiveSlant / 45);

                const jitterX = (this.random() - 0.5) * m * (isCursive ? 0.18 : 0.5);
                const jitterY = (this.random() - 0.5) * m * (isCursive ? 0.14 : 0.5);

                return {
                    x: (pt.x + slantOffset + charDriftX + jitterX) * characterHeight,
                    y: (pt.y + charDriftY + jitterY) * characterHeight
                };
            });

            // 2. Chaikin smoothing to remove angularity
            if (varied.length > 2) {
                varied = this.smooth(varied, isCursive ? 1 : 2);
            }

            return varied;
        });

        return processedStrokes;
    }

    /**
     * Chaikin's smoothing algorithm
     * @param {Array} points 
     * @param {number} iterations 
     * @returns {Array} smoothed points
     */
    smooth(points, iterations) {
        if (iterations <= 0 || points.length < 3) return points;

        let current = points;
        for (let i = 0; i < iterations; i++) {
            let next = [];
            // Keep start point
            next.push(current[0]);

            for (let j = 0; j < current.length - 1; j++) {
                const p0 = current[j];
                const p1 = current[j + 1];

                // Q = 3/4 p0 + 1/4 p1
                // R = 1/4 p0 + 3/4 p1
                const q = {
                    x: 0.75 * p0.x + 0.25 * p1.x,
                    y: 0.75 * p0.y + 0.25 * p1.y
                };
                const r = {
                    x: 0.25 * p0.x + 0.75 * p1.x,
                    y: 0.25 * p0.y + 0.75 * p1.y
                };

                next.push(q);
                next.push(r);
            }

            // Keep end point
            next.push(current[current.length - 1]);
            current = next;
        }
        return current;
    }

    /**
     * Picks a random variant of a character from the library.
     * @param {Array} variants 
     * @param {number} lastVariantIndex 
     * @returns {Object} { stroke, index }
     */
    pickVariant(variants, lastVariantIndex = -1) {
        if (!variants || variants.length === 0) return { stroke: [], index: -1 };
        if (variants.length === 1) return { stroke: variants[0], index: 0 };

        let idx;
        do {
            idx = Math.floor(this.random() * variants.length);
        } while (idx === lastVariantIndex && variants.length > 1);

        return { stroke: variants[idx], index: idx };
    }
}

if (typeof module !== 'undefined') module.exports = HandwritingVariation;
