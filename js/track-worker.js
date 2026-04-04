/**
 * Web Worker for track generation — runs off the main thread to prevent UI freezing.
 *
 * Receives: { imageDataArrays, colorMap, enabledColors, qualityLevel, imageOffsets, imageScales, xOffset, yOffset }
 *   - imageDataArrays: [{ data: Uint8ClampedArray, width, height }, ...]
 * Posts back:
 *   - { type: 'progress', percent, objectCount, imageIndex, totalImages }
 *   - { type: 'complete', code, objectCount }
 *   - { type: 'error', message }
 */

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

self.onmessage = function (e) {
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

        // Absolute maximum objects across all images — very high because
        // we use adaptive step to prevent runaway counts
        const ABSOLUTE_MAX = 500000;

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

            // Density-based adaptive step — estimate how many objects
            // this image will produce, and increase step until it fits
            // within the budget so the ENTIRE image is processed.
            const maxBudget = [200000, 120000, 60000, 30000][qualityLevel - 1];
            const budgetRemaining = Math.max(maxBudget - totalObjects, 10000);

            const estimated = estimateNonWhitePixels(imgData, step);
            const estAtStep = Math.ceil(estimated / (step * step));
            if (estAtStep > budgetRemaining) {
                const neededFactor = Math.sqrt(estAtStep / budgetRemaining);
                step = Math.max(step, Math.ceil(step * neededFactor));
            }

            // Cap step so we don't skip everything
            step = Math.min(step, Math.max(Math.floor(Math.min(imgData.width, imgData.height) / 8), 1));

            // ── Process pixels ──────────────────────────────────────────
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

                    if (totalObjects > ABSOLUTE_MAX) {
                        // Graceful stop — image is already mostly done
                        self.postMessage({ type: 'progress', percent: 100, objectCount: totalObjects, imageIndex: imgIdx, totalImages });
                        self.postMessage({ type: 'complete', code: track.code, objectCount: totalObjects });
                        return;
                    }

                    const trackX = ((x - imgData.width / 2) * scale + offset.x + xOffset) * 2;
                    const trackY = ((y - imgData.height / 2) * scale + offset.y + yOffset) * 2;

                    switch (match.name) {
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

        // Done
        self.postMessage({ type: 'progress', percent: 100, objectCount: totalObjects, imageIndex: totalImages - 1, totalImages });
        self.postMessage({ type: 'complete', code: track.code, objectCount: totalObjects });

    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
