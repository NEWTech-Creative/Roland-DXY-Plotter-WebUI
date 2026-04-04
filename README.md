# Roland DXY Plotter Web UI

Browser-based Roland DXY plotter controller and creative HPGL workflow for the Roland DXY-1100, DXY-1200, and DXY-1300 series.

This project is a modern Roland DXY controller that combines drawing tools, HPGL generation, live preview, motion simulation, handwriting generation, image-to-vector conversion, and USB serial streaming in one web interface. It is designed for people searching for a Roland DXY web UI, Roland DXY controller, HPGL plotter software, or a browser-based pen plotter workflow using a CH340 USB-to-serial adapter.

Live site: [Click here](https://newtech-creative.github.io/Roland-DXY-Plotter-WebUI/)

![Roland DXY Web Interface](DXY_Web_connect.jpg)

Created by NEWTech Creative.

## Roland DXY Controller Features

- Connects to a Roland DXY plotter through a USB-to-serial CH340 adapter
- Creates and edits vector artwork directly in the browser
- Streams HPGL to the machine over serial
- Exports HPGL files for plotting later
- Simulates motion and previews pen paths before plotting
- Generates handwriting-style vector text
- Converts images into vector toolpaths
- Applies repeat patterns and bucket-style fill patterns to closed regions

## Main Features

### Roland Plotter Control

- Roland DXY connection panel with baud-rate setup
- Machine jog controls
- Command log with queue and position readout
- Live `Run`, `Hold`, and `Cancel` controls

### Drawing and Editing

- Select, text, shape, and node-edit tools
- Rectangle, circle, line, and vector path support
- Layered pen/color workflow
- Pattern generation and grouped artwork handling

### Fill and Pattern Tools

- Paint bucket tool for filling closed regions with line art
- Pattern options including lines, crosshatch, curves, circles, topography, Japanese patterns, worms, pixel wave, and zigzag
- Pen layer, spacing, angle, and grouping controls

### Handwriting Generator

- Print, cursive, architect, and plotter styles
- Adjustable slant, messiness, line spacing, height, and character spacing
- Preview, export, and add-to-bed workflow

### Image to Vector

- Contour and tracing workflows
- Fill-gap generation
- Path style controls for curves or straight-line output
- SVG and raster-based creative vector conversion options

### HPGL Preview and Output

- Visualiser with pen layers and crosshair preview
- Motion simulation with multiple speed multipliers
- HPGL export for Roland-compatible workflows
- Optional use of DXY internal curve handling

## Hardware Notes

This interface is designed around Roland DXY pen plotters and is intended to work with a USB-to-serial CH340 adapter.

Compatible search terms and hardware phrases people commonly use include:

- Roland DXY controller
- Roland DXY-1100 controller
- Roland DXY-1200 controller
- Roland DXY-1300 controller
- Roland DXY plotter software
- HPGL plotter controller
- pen plotter web interface
- CH340 Roland DXY adapter

The app also includes a startup/setup help reference for DIP switch configuration in:

- [References/Dip switch setup.svg](C:/Users/myles/OneDrive/NEWTech/Roland/WEB interface v2/References/Dip switch setup.svg)

## Use the Roland DXY Web UI

The easiest way to use the app is through the live GitHub Pages build:

[https://newtech-creative.github.io/Roland-DXY-Plotter-WebUI/](https://newtech-creative.github.io/Roland-DXY-Plotter-WebUI/)

For the best experience, use a Chromium-based browser with Web Serial support, then connect your CH340 serial adapter and use the `Connect USB Serial` button.

## Search-Friendly Summary

If you want a modern Roland DXY controller in the browser, this project provides a web-based HPGL workflow for Roland DXY plotters. It is useful for controlling older Roland DXY machines, creating pen plotter artwork, importing logos and vector graphics, generating handwriting, and sending HPGL through a CH340 USB serial connection.

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

## Compatibility

Built primarily for:

- Roland DXY-1100
- Roland DXY-1200
- Roland DXY-1300
- Other Roland DXY series plotters
- Web Serial capable desktop browsers
- Creative plotting workflows using HPGL

## Current Status

This is an actively evolving creative tool. Features and behavior are still being refined, especially around:

- advanced fill pattern behavior
- handwriting style tuning
- live streaming behavior on different serial adapters
- imported vector edge cases

## Roadmap Ideas

- More refined handwriting alphabets and styles
- Additional plotter-safe fill and hatch strategies
- Better project import/export options
- More machine presets and hardware setup helpers
- Further optimization for large or complex plots

## Credits

Created by NEWTech Creative

- YouTube: [https://www.youtube.com/@NEWTechCreative](https://www.youtube.com/@NEWTechCreative)
- Support: [https://paypal.me/NEWTechCreative](https://paypal.me/NEWTechCreative)
