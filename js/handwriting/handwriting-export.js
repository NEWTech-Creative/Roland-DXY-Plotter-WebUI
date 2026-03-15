/**
 * Handwriting Export Module
 */
class HandwritingExport {
    /**
     * Converts laid out handwriting into an SVG string.
     * @param {Array} result - Output from layout engine
     * @param {Object} options - { pageWidth, pageHeight }
     * @returns {string} - SVG content
     */
    toSVG(result, options) {
        const { pageWidth = 210, pageHeight = 297 } = options;
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pageWidth}mm" height="${pageHeight}mm" viewBox="0 0 ${pageWidth} ${pageHeight}">\n`;
        svg += `  <g fill="none" stroke="black" stroke-width="0.3" stroke-linecap="round" stroke-linejoin="round">\n`;

        for (const glyph of result) {
            if (!glyph.strokes || glyph.strokes.length === 0) continue;

            const pathData = glyph.strokes.map(stroke => {
                if (stroke.length === 0) return "";
                const gx = glyph.x || 0;
                const gy = glyph.y || 0;
                const d = stroke.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${(gx + pt.x).toFixed(2)} ${(gy + pt.y).toFixed(2)}`).join(' ');
                return `<path d="${d}" />`;
            }).join('\n    ');

            svg += `    ${pathData}\n`;
        }

        svg += `  </g>\n</svg>`;
        return svg;
    }

    /**
     * Converts laid out handwriting into the application's internal vector object format.
     * @param {Array} result - Output from layout engine
     * @returns {Object} - Group object compatible with canvas.js
     */
    toVectorObject(result) {
        const children = [];

        for (const glyph of result) {
            if (!glyph.strokes || glyph.strokes.length === 0) continue;

            glyph.strokes.forEach(stroke => {
                if (stroke.length < 2) return;
                children.push({
                    type: 'polyline',
                    points: stroke.map(pt => ({
                        x: glyph.x + pt.x,
                        y: glyph.y + pt.y
                    }))
                });
            });
        }

        return {
            id: 'hw-' + Date.now(),
            type: 'group',
            source: 'handwriting',
            name: 'Generated Handwriting',
            children: children,
            x: 0,
            y: 0,
            pen: 1
        };
    }
}

if (typeof module !== 'undefined') module.exports = HandwritingExport;
