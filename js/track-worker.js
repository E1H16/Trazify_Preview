/**
 * Web Worker for track generation — runs off the main thread to prevent UI freezing.
 *
 * Receives: { imageDataArrays, colorMap, enabledColors, qualityLevel, imageOffsets, imageScales, xOffset, yOffset }
 *   - imageDataArrays: [{ data: Uint8ClampedArray, width, height }, ...]
 * Posts back:
 *   - { type: 'progress', percent, objectCount, imageIndex, totalImages }
 *   - { type: 'complete', code, objectCount }
 *   - { type: 'error', message }
 *
 * Uses WebAssembly (pixel_processor.wasm) for accelerated pixel classification
 * when available, with automatic fallback to pure JavaScript.
 */

// ─── WebAssembly loader ─────────────────────────────────────────────────────

let wasm = null;

const wasmReady = (async () => {
    try {
        const resp = await fetch('pixel_processor.wasm');
        if (!resp.ok) throw new Error(resp.statusText);
        const bytes = await resp.arrayBuffer();
        const { instance } = await WebAssembly.instantiate(bytes);
        wasm = instance.exports;
    } catch (_) {
        wasm = null; // JS fallback
    }
})();

// ─── Optimized FrhdTrack (HashMap-based addLine) ────────────────────────────

class FrhdTrack {
    constructor() {
        this.physicsLines = [];
        this.sceneryLines = [];
        this.powerups = {
            targets: [],
            slowmos: [],
            bombs: [],
            checkpoints: [],
            antigravities: [],
            boosts: [],
            gravities: [],
            teleporters: []
        };
        this.vehicles = {
            heli: [],
            truck: [],
            balloon: [],
            blob: []
        };
        // HashMap for O(1) endpoint merging
        this._startMap = { physics: new Map(), scenery: new Map() };
        this._endMap   = { physics: new Map(), scenery: new Map() };
    }

    // ── Key helper ──────────────────────────────────────────────────────────
    _key(x, y) { return x + ',' + y; }

    // ── Optimised addLine using endpoint maps ───────────────────────────────
    addLine(type, line) {
        if (line.length % 2 === 1) line.pop();
        if (line.length < 4) return;
        if (type !== 'physics' && type !== 'scenery') type = 'physics';

        const startMap = this._startMap[type];
        const endMap   = this._endMap[type];

        const lsx = line[0], lsy = line[1];                             // line-start
        const lex = line[line.length - 2], ley = line[line.length - 1]; // line-end

        // Try merge with existing segment whose END matches our START
        const endKey = this._key(lsx, lsy);
        const existingByEnd = endMap.get(endKey);
        if (existingByEnd) {
            // existingByEnd ends where our new line starts → append
            const seg = existingByEnd;
            this._removeFromMaps(type, seg);
            line.splice(0, 2);                       // remove duplicate junction point
            const merged = seg.concat(line);
            this._insertSegment(type, merged);
            return;
        }

        // Try merge with existing segment whose START matches our END
        const startKey = this._key(lex, ley);
        const existingByStart = startMap.get(startKey);
        if (existingByStart) {
            const seg = existingByStart;
            this._removeFromMaps(type, seg);
            seg.splice(0, 2);
            const merged = line.concat(seg);
            this._insertSegment(type, merged);
            return;
        }

        // No merge — just insert
        this._insertSegment(type, line);
    }

    _insertSegment(type, seg) {
        this[type + 'Lines'].push(seg);
        this._startMap[type].set(this._key(seg[0], seg[1]), seg);
        this._endMap[type].set(this._key(seg[seg.length - 2], seg[seg.length - 1]), seg);
    }

    _removeFromMaps(type, seg) {
        const lines = this[type + 'Lines'];
        const idx = lines.indexOf(seg);
        if (idx !== -1) lines.splice(idx, 1);
        this._startMap[type].delete(this._key(seg[0], seg[1]));
        this._endMap[type].delete(this._key(seg[seg.length - 2], seg[seg.length - 1]));
    }

    addPhysicsLine() {
        const args = Array.from(arguments);
        if (args.length % 2 === 1) args.pop();
        if (args.length < 4) return;
        this.addLine('physics', args);
    }

    addSceneryLine() {
        const args = Array.from(arguments);
        if (args.length % 2 === 1) args.pop();
        if (args.length < 4) return;
        this.addLine('scenery', args);
    }

    addStar(x, y)          { this.powerups.targets.push([x, y]); }
    addSlowmo(x, y)        { this.powerups.slowmos.push([x, y]); }
    addBomb(x, y)          { this.powerups.bombs.push([x, y]); }
    addCheckpoint(x, y)    { this.powerups.checkpoints.push([x, y]); }
    addAntigravity(x, y)   { this.powerups.antigravities.push([x, y]); }
    addBoost(x, y, a)      { this.powerups.boosts.push([x, y, (a || 0) % 360]); }
    addGravity(x, y, a)    { this.powerups.gravities.push([x, y, (a || 0) % 360]); }
    addTeleporter(x, y, x1, y1) { this.powerups.teleporters.push([x, y, x1, y1]); }

    addVehicle(x, y, type, time) {
        if (typeof type === 'string') {
            type = type.toLowerCase();
            if (!['heli','truck','balloon','blob'].includes(type)) type = 'heli';
        } else {
            if (type > 4) type = 1;
            type = ['heli','truck','balloon','blob'][type - 1];
        }
        this.vehicles[type] = [x, y, time || 10];
    }

    get code() {
        const code = [[], [], []];

        for (const line of this.physicsLines) {
            code[0].push(line.map(p => p.toString(32)).join(' '));
        }
        for (const line of this.sceneryLines) {
            code[1].push(line.map(p => p.toString(32)).join(' '));
        }

        const pLookup = {
            targets: 'T', slowmos: 'S', bombs: 'O', checkpoints: 'C',
            antigravities: 'A', boosts: 'B', gravities: 'G', teleporters: 'W'
        };
        const vLookup = { heli: 1, truck: 2, balloon: 3, blob: 4 };

        for (const pType in this.powerups) {
            const set = this.powerups[pType];
            if (set.length === 0) continue;
            for (const p of set) {
                const data = p.filter(v => v !== undefined).map(v => v.toString(32));
                code[2].push(pLookup[pType] + ' ' + data.join(' '));
            }
        }
        for (const vType in this.vehicles) {
            const v = this.vehicles[vType];
            if (!v || v.length === 0) continue;
            code[2].push('V ' + v[0].toString(32) + ' ' + v[1].toString(32) + ' ' + vLookup[vType] + ' ' + v[2].toString(32));
        }
        return code.join('#');
    }
}

// ─── Pre-calculated color lookup table ──────────────────────────────────────

function buildColorLookup(colorMap, enabledColors) {
    const lookup = [];
    for (const hex in colorMap) {
        if (!enabledColors[hex]) continue;
        lookup.push({
            hex: hex,
            name: colorMap[hex],
            r: parseInt(hex.slice(1, 3), 16),
            g: parseInt(hex.slice(3, 5), 16),
            b: parseInt(hex.slice(5, 7), 16)
        });
    }
    return lookup;
}

function getClosestColor(r, g, b, lookup) {
    let closest = null;
    let minDist = Infinity;
    for (let i = 0; i < lookup.length; i++) {
        const c = lookup[i];
        const d = (r - c.r) * (r - c.r) + (g - c.g) * (g - c.g) + (b - c.b) * (b - c.b);
        if (d < minDist) {
            minDist = d;
            closest = c;
        }
    }
    return closest;
}

// ─── Quick sampling to estimate non-white pixel density ─────────────────────

function estimateNonWhitePixels(imgData, sampleStep) {
    let nonWhite = 0;
    let sampled  = 0;
    const step = Math.max(sampleStep, 4);

    for (let y = 0; y < imgData.height; y += step) {
        for (let x = 0; x < imgData.width; x += step) {
            const idx = (y * imgData.width + x) * 4;
            const a = imgData.data[idx + 3];
            if (a === 0) { sampled++; continue; }
            const bright = (imgData.data[idx] + imgData.data[idx + 1] + imgData.data[idx + 2]) / 3;
            sampled++;
            if (bright <= 240) nonWhite++;
        }
    }
    if (sampled === 0) return 0;
    const ratio = nonWhite / sampled;
    const totalPixelsAtStep1 = Math.ceil(imgData.width / 1) * Math.ceil(imgData.height / 1);
    return Math.round(ratio * totalPixelsAtStep1);
}

// ─── Main message handler ───────────────────────────────────────────────────

self.onmessage = async function (e) {
    // Ensure Wasm has finished loading (or failing) before processing
    await wasmReady;

    try {
        const {
            imageDataArrays,   // [{ data, width, height }, ...]
            colorMap,
            enabledColors,
            qualityLevel,
            imageOffsets,
            imageScales,
            xOffset,
            yOffset
        } = e.data;

        const colorLookup = buildColorLookup(colorMap, enabledColors);
        if (colorLookup.length === 0) {
            self.postMessage({ type: 'error', message: 'No object types enabled.' });
            return;
        }

        const track = new FrhdTrack();
        let totalObjects = 0;
        const totalImages = imageDataArrays.length;

        // Maximum total track objects across all images before stopping.
        // High because adaptive step already prevents runaway counts.
        const MAX_TOTAL_OBJECTS = 500000;

        // Build flat RGB array for the color palette (used by both Wasm and JS paths)
        const colorNames = colorLookup.map(c => c.name);
        const colorsFlat = new Uint8Array(colorLookup.length * 3);
        for (let i = 0; i < colorLookup.length; i++) {
            colorsFlat[i * 3]     = colorLookup[i].r;
            colorsFlat[i * 3 + 1] = colorLookup[i].g;
            colorsFlat[i * 3 + 2] = colorLookup[i].b;
        }

        for (let imgIdx = 0; imgIdx < totalImages; imgIdx++) {
            const imgData = imageDataArrays[imgIdx];
            const offset  = imageOffsets[imgIdx] || { x: 0, y: 0 };
            const scale   = imageScales[imgIdx]  || 1.0;

            // ── Adaptive step: guarantee full image coverage ────────────
            let step = qualityLevel; // 1 = Ultra … 4 = Low

            // Size-based minimum step
            if (imgData.width > 1500 || imgData.height > 1500) step = Math.max(step, 2);
            if (imgData.width > 3000 || imgData.height > 3000) step = Math.max(step, 3);
            if (imgData.width > 5000 || imgData.height > 5000) step = Math.max(step, 4);

            // Density-based adaptive step
            const maxBudget = [200000, 120000, 60000, 30000][qualityLevel - 1];
            const budgetRemaining = Math.max(maxBudget - totalObjects, 10000);

            let estimated;
            if (wasm) {
                // Use Wasm for density estimation
                const pixelSize = imgData.data.length;
                const pxPtr = wasm.wasm_alloc(pixelSize);
                new Uint8Array(wasm.memory.buffer, pxPtr, pixelSize).set(imgData.data);
                estimated = wasm.estimate_density(pxPtr, imgData.width, imgData.height, step);
                wasm.wasm_dealloc(pxPtr, pixelSize);
            } else {
                estimated = estimateNonWhitePixels(imgData, step);
            }

            const estAtStep = Math.ceil(estimated / (step * step));
            if (estAtStep > budgetRemaining) {
                const neededFactor = Math.sqrt(estAtStep / budgetRemaining);
                step = Math.max(step, Math.ceil(step * neededFactor));
            }

            // Cap step so we don't skip everything
            step = Math.min(step, Math.max(Math.floor(Math.min(imgData.width, imgData.height) / 8), 1));

            // ── Process pixels ──────────────────────────────────────────
            if (wasm) {
                // ─── Wasm path: batch rows for progress reporting ───────
                const ROWS_PER_BATCH = 100;
                const pixelSize  = imgData.data.length;
                const colorsSize = colorsFlat.length;
                const maxPerBatch = Math.ceil(imgData.width / step) * ROWS_PER_BATCH;
                const resultSize = maxPerBatch * 3 * 8; // 3 × f64 per result

                // Allocate Wasm memory for pixel data, colors, and results
                const pxPtr  = wasm.wasm_alloc(pixelSize);
                const clrPtr = wasm.wasm_alloc(colorsSize);
                const resPtr = wasm.wasm_alloc(resultSize);

                // Copy pixel data and color palette into Wasm memory
                new Uint8Array(wasm.memory.buffer, pxPtr, pixelSize).set(imgData.data);
                new Uint8Array(wasm.memory.buffer, clrPtr, colorsSize).set(colorsFlat);

                const halfW = imgData.width / 2;
                const halfH = imgData.height / 2;
                const combinedOffX = offset.x + xOffset;
                const combinedOffY = offset.y + yOffset;
                const totalRows = Math.ceil(imgData.height / step);
                let rowsDone = 0;
                const progressInterval = Math.max(Math.floor(totalRows / 50), 1);
                let hitMax = false;

                for (let yStart = 0; yStart < imgData.height && !hitMax; yStart += ROWS_PER_BATCH * step) {
                    const yEnd = Math.min(yStart + ROWS_PER_BATCH * step, imgData.height);

                    const count = wasm.process_pixels(
                        pxPtr, imgData.width, imgData.height, step,
                        yStart, yEnd,
                        clrPtr, colorLookup.length,
                        scale, halfW, halfH, combinedOffX, combinedOffY,
                        resPtr, maxPerBatch
                    );

                    // Read results — re-create view in case memory grew
                    const results = new Float64Array(wasm.memory.buffer, resPtr, count * 3);

                    for (let i = 0; i < count * 3; i += 3) {
                        const colorIdx = results[i];
                        const trackX   = results[i + 1];
                        const trackY   = results[i + 2];

                        totalObjects++;
                        if (totalObjects > MAX_TOTAL_OBJECTS) {
                            break;
                        }

                        addResultToTrack(track, colorNames[colorIdx], trackX, trackY);
                    }

                    // Progress reporting
                    const batchRows = Math.ceil((yEnd - yStart) / step);
                    rowsDone += batchRows;
                    if (rowsDone % progressInterval < batchRows || hitMax) {
                        const imgProgress = Math.min(rowsDone / totalRows, 1);
                        const overallPercent = Math.round(((imgIdx + imgProgress) / totalImages) * 100);
                        self.postMessage({
                            type: 'progress',
                            percent: overallPercent,
                            objectCount: totalObjects,
                            imageIndex: imgIdx,
                            totalImages: totalImages
                        });
                    }
                }

                // Free Wasm memory
                wasm.wasm_dealloc(pxPtr, pixelSize);
                wasm.wasm_dealloc(clrPtr, colorsSize);
                wasm.wasm_dealloc(resPtr, resultSize);

                if (hitMax) {
                    self.postMessage({ type: 'progress', percent: 100, objectCount: totalObjects, imageIndex: imgIdx, totalImages });
                    self.postMessage({ type: 'complete', code: track.code, objectCount: totalObjects });
                    return;
                }

            } else {
                // ─── JS fallback path (original logic) ──────────────────
                const totalRows = Math.ceil(imgData.height / step);
                let rowsDone = 0;
                const progressInterval = Math.max(Math.floor(totalRows / 50), 1);

                for (let y = 0; y < imgData.height; y += step) {
                    for (let x = 0; x < imgData.width; x += step) {
                        const idx = (y * imgData.width + x) * 4;
                        const alpha = imgData.data[idx + 3];
                        if (alpha === 0) continue;

                        const r = imgData.data[idx];
                        const g = imgData.data[idx + 1];
                        const b = imgData.data[idx + 2];

                        if ((r + g + b) / 3 > 240) continue;

                        const match = getClosestColor(r, g, b, colorLookup);
                        if (!match) continue;

                        totalObjects++;

                        if (totalObjects > MAX_TOTAL_OBJECTS) {
                            self.postMessage({ type: 'progress', percent: 100, objectCount: totalObjects, imageIndex: imgIdx, totalImages });
                            self.postMessage({ type: 'complete', code: track.code, objectCount: totalObjects });
                            return;
                        }

                        const trackX = ((x - imgData.width / 2) * scale + offset.x + xOffset) * 2;
                        const trackY = ((y - imgData.height / 2) * scale + offset.y + yOffset) * 2;

                        addResultToTrack(track, match.name, trackX, trackY);
                    }

                    rowsDone++;
                    if (rowsDone % progressInterval === 0) {
                        const imgProgress = rowsDone / totalRows;
                        const overallPercent = Math.round(((imgIdx + imgProgress) / totalImages) * 100);
                        self.postMessage({
                            type: 'progress',
                            percent: overallPercent,
                            objectCount: totalObjects,
                            imageIndex: imgIdx,
                            totalImages: totalImages
                        });
                    }
                }
            }
        }

        // Done
        self.postMessage({ type: 'progress', percent: 100, objectCount: totalObjects, imageIndex: totalImages - 1, totalImages });
        self.postMessage({ type: 'complete', code: track.code, objectCount: totalObjects });

    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};

// ─── Shared helper: add a classified pixel to the track ─────────────────────

function addResultToTrack(track, colorName, trackX, trackY) {
    switch (colorName) {
        case 'White (Strongly recommended)': break;
        case 'PhysicsLine':
            track.addPhysicsLine(trackX, trackY, trackX + 2, trackY + 2);
            break;
        case 'SceneryLine':
            track.addSceneryLine(trackX, trackY, trackX + 2, trackY + 2);
            break;
        case 'Bomb':          track.addBomb(trackX, trackY);          break;
        case 'Gravity':       track.addGravity(trackX, trackY);       break;
        case 'Star':          track.addStar(trackX, trackY);          break;
        case 'Boost':         track.addBoost(trackX, trackY);         break;
        case 'Antigravity':   track.addAntigravity(trackX, trackY);   break;
        case 'Checkpoint':    track.addCheckpoint(trackX, trackY);    break;
        case 'Teleporter':
            track.addTeleporter(trackX, trackY, trackX + 2, trackY + 2);
            break;
        case 'Helicopter':    track.addVehicle(trackX, trackY, 'heli');    break;
        case 'Truck':         track.addVehicle(trackX, trackY, 'truck');   break;
        case 'Balloon':       track.addVehicle(trackX, trackY, 'balloon'); break;
        case 'Blob':          track.addVehicle(trackX, trackY, 'blob');    break;
    }
}
