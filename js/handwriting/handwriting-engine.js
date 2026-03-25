/**
 * Handwriting Engine
 * Orchestrates Library, Variation, Layout, and Export.
 */
class HandwritingEngine {
    constructor() {
        this.library = null;
        this.variation = null;
        this.layout = null;
        this.export = null;
    }

    init(library) {
        this.library = library;
        this.variation = new HandwritingVariation();
        this.layout = new HandwritingLayout();
        this.export = new HandwritingExport();
    }

    /**
     * Generates handwriting vectors from text.
     * @param {string} text 
     * @param {Object} options - { seed, slant, messiness, characterHeight, lineSpacing, pageWidth, pageHeight }
     * @returns {Array} - Laid out glyphs with applied variation
     */
    generate(text, options) {
        if (!this.library) return [];

        const style = options.style || 'print';
        const usesConnectedScript = style === 'cursive';
        const glyphLibrary = this.library[style] || this.library['print'];
        const h = options.characterHeight || 6;

        this.variation.setSeed(options.seed || 1234);

        // 1. Layout the text (calculates mm positions)
        const layoutResult = this.layout.layout(text, glyphLibrary, this.variation, options);

        let finalStrokes = [];
        let currentWordStroke = null;
        let lastY = -1;
        let lastMainStroke = null;

        // 2. Process glyphs
        for (const glyph of layoutResult) {
            // Detect breaks (space or line change)
            const isNewLine = lastY !== -1 && Math.abs(glyph.y - lastY) > 1.0;
            const isSpace = glyph.char === ' ' || !glyph.strokes || glyph.strokes.length === 0;

            if (isNewLine || isSpace) {
                if (currentWordStroke) {
                    finalStrokes.push({ strokes: [currentWordStroke], x: 0, y: 0 });
                    currentWordStroke = null;
                }
                lastMainStroke = null;
                if (glyph.char === ' ') {
                    finalStrokes.push({ char: ' ', strokes: [], x: glyph.x, y: glyph.y });
                    lastY = glyph.y;
                    continue;
                }
            }

            // Apply variation in NORMALIZED space (0-1)
            // variation.apply returns points scaled by `characterHeight`
            const variedStrokes = this.variation.apply(glyph.strokes, {
                slant: options.slant,
                messiness: options.messiness,
                characterHeight: h,
                style,
                glyphChar: glyph.char
            });

            // Offset by glyph position (already in mm)
            const absoluteStrokes = variedStrokes.map(s => s.map(pt => ({
                x: glyph.x + pt.x,
                y: glyph.y + pt.y
            })));

            if (usesConnectedScript && absoluteStrokes.length > 0) {
                if ((options.characterSpacing || 0) < 0) {
                    absoluteStrokes[0] = this._compressCursiveEntry(
                        absoluteStrokes[0],
                        options.characterSpacing || 0,
                        h
                    );
                }
                if (!currentWordStroke) {
                    currentWordStroke = [...absoluteStrokes[0]];
                } else {
                    const connector = this._buildCursiveConnector(lastMainStroke, absoluteStrokes[0], h);
                    if (connector.length > 1) currentWordStroke.push(...connector);
                    currentWordStroke.push(...absoluteStrokes[0]);
                }
                lastMainStroke = absoluteStrokes[0];
                // Any extra strokes (dots, crosses) are added separately
                for (let i = 1; i < absoluteStrokes.length; i++) {
                    finalStrokes.push({ strokes: [absoluteStrokes[i]], x: 0, y: 0 });
                }
            } else {
                finalStrokes.push({ char: glyph.char, strokes: absoluteStrokes, x: 0, y: 0 });
                lastMainStroke = null;
            }

            lastY = glyph.y;
        }

        // Push last word
        if (currentWordStroke) {
            finalStrokes.push({ strokes: [currentWordStroke], x: 0, y: 0 });
        }

        return finalStrokes;
    }

    _buildCursiveConnector(prevStroke, nextStroke, characterHeight) {
        if (!prevStroke || !nextStroke || prevStroke.length === 0 || nextStroke.length === 0) return [];

        const prev = prevStroke[prevStroke.length - 1];
        const next = nextStroke[0];
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const joinThreshold = characterHeight * 0.62;

        if (dx <= 0 || dx > joinThreshold * 1.45 || Math.abs(dy) > joinThreshold * 0.7) return [];

        const lift = Math.min(characterHeight * 0.09, Math.abs(dx) * 0.1);
        return [
            {
                x: prev.x + dx * 0.35,
                y: prev.y - lift
            },
            {
                x: prev.x + dx * 0.7,
                y: next.y - lift * 0.2
            }
        ];
    }

    _compressCursiveEntry(stroke, characterSpacing, characterHeight) {
        if (!stroke || stroke.length < 2 || characterSpacing >= 0) return stroke;

        const start = stroke[0];
        const overlap = Math.abs(characterSpacing);
        const joinWindow = Math.max(characterHeight * 0.36, overlap * 1.8);
        const compression = Math.min(0.6, overlap / Math.max(0.1, characterHeight * 0.8));

        return stroke.map((pt, index) => {
            if (index === 0) return pt;

            const dx = pt.x - start.x;
            if (dx <= 0 || dx >= joinWindow) return pt;

            const taper = 1 - (dx / joinWindow);
            const scale = Math.max(0.12, 1 - (compression * taper));

            return {
                ...pt,
                x: start.x + (dx * scale)
            };
        });
    }
}

if (typeof module !== 'undefined') module.exports = HandwritingEngine;
