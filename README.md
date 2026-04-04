# Trazify

A professional image-to-FreeRiderHD track converter with advanced algorithms and optimized performance. Enhanced version with improved UI/UX, real-time previews, and support for complex images.

## Features

- **Real-time Preview** — See your track layout as you adjust spawn points and zoom levels
- **Advanced Image Processing** — Intelligent color quantization with support for all FreeRiderHD object types
- **WebAssembly Acceleration** — Rust-compiled WASM module for high-performance pixel classification with automatic JS fallback
- **Web Worker Processing** — Off-thread track generation prevents UI freezing on large images
- **Optimized Performance** — Handles large and complex images with adaptive downsampling
- **Professional Interface** — Dark theme with smooth animations and intuitive controls
- **Multi-Image Support** — Load up to 5 images with individual positioning and scaling
- **Pinch-to-Zoom** — Full touch gesture support for mobile devices
- **Accessible** — Semantic HTML, ARIA labels, and keyboard navigable

## Usage

1. Upload one or more images (PNG, JPG, GIF, WebP, BMP — validated via magic bytes)
2. Adjust the spawn point position by dragging the canvas
3. Use mouse wheel or pinch gesture to zoom in/out
4. Select which object types to include in the Objects panel
5. Choose your quality level (Ultra High, High, Medium, or Low)
6. Press **Generate** to create your track code
7. Copy the code and paste it into FreeRiderHD!

## Architecture

```
index.html                   Main entry point (semantic HTML5)
├── css/style.css            All styling, responsive breakpoints
├── js/
│   ├── frhd.js              FreeRiderHD track encoding/decoding library
│   ├── app.js               Main application logic (UI, canvas, worker management)
│   └── track-worker.js      Web Worker for off-thread image processing
│       └── pixel_processor.wasm   Rust-compiled WASM for pixel classification
├── assets/
│   └── TrazifyLogo.png      Application logo
├── wasm/
│   └── pixel-processor/     Rust source for the WASM module
│       ├── Cargo.toml
│       ├── src/lib.rs
│       └── build.sh
└── manifest.json            PWA manifest
```

### Data Flow

1. **Image Upload** → Files are validated (magic bytes), converted to Blob URLs, and rendered on the canvas
2. **Generate** → Image data is extracted from canvas, transferred to a Web Worker via Transferable Objects
3. **Worker Processing** → The worker uses WASM (or JS fallback) to classify each pixel and build the track
4. **Progress** → Worker posts progress messages back to the main thread for UI updates
5. **Complete** → Final track code is returned and displayed in the output textarea

### Key Design Decisions

- **No build system** — Static files served directly for simplicity and zero-config deployment
- **Blob URLs over Data URLs** — Reduced memory overhead (~33% savings) for loaded images
- **HashMap-optimized line merging** — The worker's `FrhdTrack` uses endpoint maps for O(1) line segment merging
- **Adaptive quality** — Step size is automatically adjusted based on image size and pixel density
- **Graceful WASM degradation** — Falls back to pure JS if WASM fails to load

## Building the WASM Module

Prerequisites: [Rust](https://rustup.rs/) with the `wasm32-unknown-unknown` target.

```bash
# Install the WASM target (one-time setup)
rustup target add wasm32-unknown-unknown

# Build the module
cd wasm/pixel-processor
cargo build --target wasm32-unknown-unknown --release

# Or use the build script
./build.sh
```

The compiled binary is output to `js/pixel_processor.wasm` (~11 KB, optimized with LTO and symbol stripping).

## Development

No build step needed for HTML/CSS/JS — just serve the directory with any static file server:

```bash
# Using Python
python3 -m http.server 8000

# Using Node.js
npx serve .
```

Then open `http://localhost:8000` in your browser.

## Credits

- **Image Processing Library**: [frhd.js](https://github.com/ObeyLordGoomy/frhd.js/tree/master) by ObeyLordGoomy
- **Original Concept**: [IMG2FRHD](https://github.com/Logboy2000/IMG2FRHD) by Logboy2000
- **Enhanced & Maintained**: E1H

---

*Trazify — Transform your creativity into FreeRiderHD tracks*
