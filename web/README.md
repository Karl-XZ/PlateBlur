# PlateBlur Web

This directory contains the browser workstation for PlateBlur.

Included features:

- Image upload and batch redaction
- Built-in sample library for bundled photos and a ready-made video clip
- Editable plate candidate boxes
- Blur, mosaic, solid, and brand watermark styles
- Video current-frame detection
- Manual timeline track points
- Frame-by-frame video watermark processing with progress feedback
- Local browser history and settings persistence

## Run Locally

Use a local HTTP server:

1. `cd /Users/applemima111/Desktop/car/PlateBlur/web`
2. `python3 -m http.server 4174`
3. Open `http://127.0.0.1:4174`

## Structure

- `index.html`: main workstation shell
- `src/app.js`: browser-side logic for image/video processing
- `src/styles/*.css`: layout and visual styles
