/**
 * Handwriting Layout Engine
 * Handles word wrapping and baseline positioning.
 */
class HandwritingLayout {
    constructor() {
        this.pageWidth = 210;
        this.pageHeight = 297;
        this.characterHeight = 6;
        this.lineSpacing = 10;
    }

    /**
     * Lays out text into a sequence of positioned glyph variants.
     * @param {string} text - The input text
     * @param {Object} library - The Glyph Library
     * @param {Object} variation - The Variation engine (to pick variants)
     * @param {Object} options - { pageWidth, pageHeight, characterHeight, lineSpacing }
     * @returns {Array} - Array of { strokes, x, y }
     */
    layout(text, library, variation, options) {
        this.pageWidth = options.pageWidth || 210;
        this.pageHeight = options.pageHeight || 297;
        this.characterHeight = options.characterHeight || 6;
        this.lineSpacing = options.lineSpacing || 10;
        const style = options.style || 'print';
        const isCursive = style === 'cursive';

        const words = text.split(/(\s+)/);
        const result = [];

        let currentX = 0;
        let baselineY = this.characterHeight * 1.0; // Initial baseline
        let lastVariantIndices = {}; // track per character to avoid repeats

        for (const word of words) {
            if (word === '\n') {
                baselineY += this.lineSpacing;
                currentX = 0;
                if (baselineY > this.pageHeight) break;
                continue;
            }

            // Calculate word width
            let wordWidth = 0;
            const wordGlyphs = [];

            for (const char of word) {
                const variants = library[char] || library['?'] || [];
                const { stroke, index } = variation.pickVariant(variants, lastVariantIndices[char]);
                lastVariantIndices[char] = index;

                // Character width is max X in normalized coords (0-1) * charHeight
                // Plus some kerning (0.2 * charHeight) + characterSpacing (mm)
                const baseKerning = isCursive ? 0.26 : 0.2;
                const charWidth = (this.getCharWidth(stroke) + baseKerning) * this.characterHeight + (options.characterSpacing || 0);

                wordGlyphs.push({
                    char,
                    stroke,
                    width: charWidth
                });
                wordWidth += charWidth;
            }

            // Wrap if necessary
            if (currentX + wordWidth > this.pageWidth && currentX > 0) {
                baselineY += this.lineSpacing;
                currentX = 0;
            }

            if (baselineY > this.pageHeight) break;

            // Add glyphs to result
            for (const glyph of wordGlyphs) {
                result.push({
                    strokes: glyph.stroke,
                    x: currentX,
                    y: baselineY
                });
                currentX += glyph.width;
            }
        }

        return result;
    }

    getCharWidth(strokes) {
        if (!strokes || strokes.length === 0) return 0.5; // space or empty
        let maxX = 0;
        strokes.forEach(stroke => {
            stroke.forEach(pt => {
                if (pt.x > maxX) maxX = pt.x;
            });
        });
        return maxX || 0.5;
    }
}

if (typeof module !== 'undefined') module.exports = HandwritingLayout;
