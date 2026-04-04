# Roland DXY Plotter Web UI

Browser-based Roland DXY plotter controller and creative HPGL workflow for the Roland DXY-1100, DXY-1200, and DXY-1300 series.

This project is a modern Roland DXY controller that combines drawing tools, HPGL generation, live preview, motion simulation, handwriting generation, image-to-vector conversion, and USB serial streaming in one web interface.

## Live Site
👉 [Launch the WebUI](https://newtech-creative.github.io/Roland-DXY-Plotter-WebUI/)

![Roland DXY Web Interface](DXY_Web_connect.jpg)

Created by NEWTech Creative.

---

## Features

### Plotter Control
- Connect via USB-to-serial (CH340)
- Baud rate configuration
- Jog controls
- Command log with queue and position readout
- Run, Hold, and Cancel controls

### Drawing & Editing
- Vector drawing tools (line, rectangle, circle, path)
- Node editing
- Layered pen workflow
- Pattern generation tools

### Fill & Pattern Tools
- Bucket fill for closed regions
- Patterns: lines, crosshatch, curves, circles, topography, zigzag, etc.
- Adjustable spacing, angle, and grouping

### Handwriting Generator
- Multiple styles (print, cursive, architect, plotter)
- Adjustable spacing, slant, messiness
- Export or add directly to canvas

### Image to Vector
- Contour tracing
- Fill gap tools
- Curve or straight-line output
- SVG + raster workflows

### HPGL Output
- Visual preview with pen layers
- Motion simulation
- Export HPGL files
- Optional internal curve handling

---

## Hardware

Designed for:
- Roland DXY-1100
- Roland DXY-1200
- Roland DXY-1300

Uses:
- CH340 USB-to-serial adapter
- Web Serial (Chromium browsers)

---

## Getting Started

1. Open the live site  
2. Use a Chromium-based browser (Chrome, Edge)  
3. Click **Connect USB Serial**  
4. Select your CH340 device  
5. Start plotting  

---

## Project Structure


- [index.html](C:/Users/myles/OneDrive/NEWTech/Roland/WEB interface v2/index.html)  
  Main app layout and panels
- [css/main.css](C:/Users/myles/OneDrive/NEWTech/Roland/WEB interface v2/css/main.css)  
  Application styling
- [js/app.js](C:/Users/myles/OneDrive/NEWTech/Roland/WEB interface v2/js/app.js)  
  App bootstrapping and settings
- [js/ui.js](C:/Users/myles/OneDrive/NEWTech/Roland/WEB interface v2/js/ui.js)  
  UI control wiring and panel behavior
- [js/canvas.js](C:/Users/myles/OneDrive/NEWTech/Roland/WEB interface v2/js/canvas.js)  
  Drawing engine, editing tools, simulation, bucket fill, and preview
- [js/serial.js](C:/Users/myles/OneDrive/NEWTech/Roland/WEB interface v2/js/serial.js)  
  Serial communication and live run logic
- [js/hpgl.js](C:/Users/myles/OneDrive/NEWTech/Roland/WEB interface v2/js/hpgl.js)  
  HPGL parsing, generation, and export
- [js/image-vector](C:/Users/myles/OneDrive/NEWTech/Roland/WEB interface v2/js/image-vector)  
  Image vectorisation tools
- [js/handwriting](C:/Users/myles/OneDrive/NEWTech/Roland/WEB interface v2/js/handwriting)  
  Handwriting generation tools


---

## Status

This is an actively evolving project.

Current focus:
- Fill pattern improvements
- Handwriting tuning
- Serial streaming stability
- Vector import handling

---

## Roadmap

- More handwriting styles
- Improved fill algorithms
- Project save/load system
- Additional plotter presets

---

## Credits

Created by NEWTech Creative

- YouTube: https://www.youtube.com/@NEWTechCreative  
- Support: [https://paypal.me/NEWTechCreative](https://paypal.me/NEWTechCreative)
