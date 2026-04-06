/**
 * Trazify — Main application logic.
 * Handles UI, canvas rendering, image loading, and Web Worker management.
 */

const outputField = document.getElementById('outputField');
const previewCanvas = document.getElementById('previewCanvas');
const sidebar = document.getElementById('sidebar');
const settingsContainer = document.getElementById('settingsContainer');
const generalSettings = document.getElementById('generalSettings');

const colorMap = {
    '#FFFFFF': 'White (Strongly recommended)',
    '#0C0C0C': 'PhysicsLine',
    '#9F9F9F': 'SceneryLine',
    '#C7231D': 'Bomb',
    '#346BB8': 'Gravity',
    '#FBE615': 'Star',
    '#8DCC28': 'Boost',
    '#07FAF3': 'Antigravity',
    '#776FE1': 'Checkpoint',
    '#DC45EC': 'Teleporter',
};

let trackString = '';
let imageData = null;
let loadedImages = [];   // {src, name, objectUrl, isSvg}
let imageObjects = [];   // Image objects for rendering
let imageOffsets = [];    // [{x, y}, ...] for each image
let imageScales = [];     // [1.0, 0.5, ...] scale per image
let currentImageIndex = 0;

// Settings
let xOffset = 0;
let yOffset = 0;
let previewZoom = 1;
let qualityLevel = 2;   // 1=Ultra, 2=High, 3=Medium, 4=Low
const enabledColors = {
    '#FFFFFF': false,
    '#0C0C0C': false,
    '#9F9F9F': false,
    '#C7231D': false,
    '#346BB8': false,
    '#FBE615': false,
    '#8DCC28': false,
    '#07FAF3': false,
    '#776FE1': false,
    '#DC45EC': false,
};

// Drag state
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartOffsetX = 0;
let dragStartOffsetY = 0;

// Pinch-to-zoom state
let lastPinchDist = 0;
let isPinching = false;

// Worker management
let currentWorker = null;
let workerTimeout = null;
const WORKER_TIMEOUT_MS = 300000; // 5 minutes
const LARGE_CODE_DISPLAY_LIMIT = 200000; // Characters above which textarea display is truncated

// ─── Image file validation ─────────────────────────────────────────────────

/** Valid image magic bytes signatures */
const IMAGE_SIGNATURES = [
    { bytes: [0x89, 0x50, 0x4E, 0x47], type: 'image/png' },       // PNG
    { bytes: [0xFF, 0xD8, 0xFF],        type: 'image/jpeg' },      // JPEG
    { bytes: [0x47, 0x49, 0x46, 0x38],  type: 'image/gif' },       // GIF
    { bytes: [0x42, 0x4D],              type: 'image/bmp' },       // BMP
];

/** WebP uses RIFF container — requires checking bytes at offset 8-11 for 'WEBP' marker */
const WEBP_RIFF_HEADER = [0x52, 0x49, 0x46, 0x46];
const WEBP_MARKER = [0x57, 0x45, 0x42, 0x50]; // 'WEBP' at offset 8

/** Maximum canvas dimension when rendering SVGs at scaled resolution */
const SVG_MAX_RENDER_DIM = 8192;

/**
 * Checks whether a file is an SVG by reading its first bytes as text
 * and looking for an `<svg` tag. SVGs loaded via <img> are sandboxed
 * (no script execution), so this is safe.
 * @param {File} file - The file to check
 * @returns {Promise<boolean>} Whether the file appears to be a valid SVG
 */
function isSvgFile(file) {
    return new Promise(function(resolve) {
        // SVG files are XML text; check the first 1 KB for an <svg tag
        var reader = new FileReader();
        reader.onload = function(e) {
            var text = e.target.result;
            resolve(/<svg[\s>/]/i.test(text));
        };
        reader.onerror = function() {
            resolve(false);
        };
        reader.readAsText(file.slice(0, 1024));
    });
}

/**
 * Validates an image file by checking its magic bytes (raster) or XML content (SVG).
 * @param {File} file - The file to validate
 * @returns {Promise<{valid: boolean, isSvg: boolean}>} Validation result
 */
function validateImageFile(file) {
    return new Promise(function(resolve) {
        var reader = new FileReader();
        reader.onload = function(e) {
            var arr = new Uint8Array(e.target.result);
            // Check standard raster signatures
            var isValid = IMAGE_SIGNATURES.some(function(sig) {
                return sig.bytes.every(function(byte, i) {
                    return arr[i] === byte;
                });
            });
            // Check WebP: RIFF header at offset 0 + 'WEBP' marker at offset 8
            if (!isValid && arr.length >= 12) {
                var isRiff = WEBP_RIFF_HEADER.every(function(byte, i) { return arr[i] === byte; });
                var isWebp = WEBP_MARKER.every(function(byte, i) { return arr[8 + i] === byte; });
                isValid = isRiff && isWebp;
            }
            if (isValid) {
                resolve({ valid: true, isSvg: false });
            } else {
                // Not a recognised raster format — check for SVG
                isSvgFile(file).then(function(svg) {
                    resolve({ valid: svg, isSvg: svg });
                });
            }
        };
        reader.onerror = function() {
            resolve({ valid: false, isSvg: false });
        };
        reader.readAsArrayBuffer(file.slice(0, 12));
    });
}

// ─── Canvas event handlers ──────────────────────────────────────────────────

previewCanvas.addEventListener('mousedown', function(event) {
    isDragging = true;
    previewCanvas.classList.add('dragging');
    const rect = previewCanvas.getBoundingClientRect();
    dragStartX = event.clientX - rect.left;
    dragStartY = event.clientY - rect.top;
    dragStartOffsetX = xOffset;
    dragStartOffsetY = yOffset;
});

previewCanvas.addEventListener('mousemove', function(event) {
    if (isDragging) {
        updateOffsetDrag(event);
    }
});

previewCanvas.addEventListener('mouseup', function() {
    isDragging = false;
    previewCanvas.classList.remove('dragging');
});

previewCanvas.addEventListener('mouseleave', function() {
    isDragging = false;
    previewCanvas.classList.remove('dragging');
});

// Touch events with pinch-to-zoom support
previewCanvas.addEventListener('touchstart', function(event) {
    event.preventDefault();

    if (event.touches.length === 2) {
        // Pinch-to-zoom start
        isPinching = true;
        isDragging = false;
        lastPinchDist = getPinchDistance(event.touches);
    } else if (event.touches.length === 1 && !isPinching) {
        // Single touch drag
        const touch = event.touches[0];
        isDragging = true;
        const rect = previewCanvas.getBoundingClientRect();
        dragStartX = touch.clientX - rect.left;
        dragStartY = touch.clientY - rect.top;
        dragStartOffsetX = xOffset;
        dragStartOffsetY = yOffset;
    }
}, { passive: false });

previewCanvas.addEventListener('touchmove', function(event) {
    event.preventDefault();

    if (event.touches.length === 2 && isPinching) {
        // Pinch-to-zoom
        const newDist = getPinchDistance(event.touches);
        if (lastPinchDist > 0) {
            const scale = newDist / lastPinchDist;
            previewZoom = Math.max(0.4, Math.min(3, previewZoom * scale));
            updateAndClearPreviewCanvas();
        }
        lastPinchDist = newDist;
    } else if (isDragging && event.touches.length === 1) {
        const touch = event.touches[0];
        const rect = previewCanvas.getBoundingClientRect();
        const currentX = touch.clientX - rect.left;
        const currentY = touch.clientY - rect.top;
        const deltaX = (currentX - dragStartX) / previewZoom;
        const deltaY = (currentY - dragStartY) / previewZoom;
        xOffset = dragStartOffsetX + Math.round(deltaX);
        yOffset = dragStartOffsetY + Math.round(deltaY);
        updateAndClearPreviewCanvas();
    }
}, { passive: false });

previewCanvas.addEventListener('touchend', function(event) {
    if (event.touches.length < 2) {
        isPinching = false;
        lastPinchDist = 0;
    }
    if (event.touches.length === 0) {
        isDragging = false;
    }
});

/**
 * Calculates distance between two touch points for pinch-to-zoom.
 * @param {TouchList} touches
 * @returns {number}
 */
function getPinchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

// Resize handling with ResizeObserver
if (typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(function() {
        updateAndClearPreviewCanvas();
    });
    resizeObserver.observe(previewCanvas);
} else {
    let resizeTimeout;
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(updateAndClearPreviewCanvas, 50);
    });
}

// ─── Toast notifications ────────────────────────────────────────────────────

/**
 * Shows a toast notification.
 * @param {string} message - The message to display
 * @param {string} [type='info'] - Toast type: 'info', 'success', 'warning', 'error'
 */
function showToast(message, type) {
    type = type || 'info';
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function() { toast.remove(); }, 3000);
}

// ─── Initialization ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
    // Add quality selector
    const qualityLabel = document.createElement('label');
    qualityLabel.style.display = 'flex';
    qualityLabel.style.alignItems = 'center';
    qualityLabel.style.gap = '0.618rem';
    const qualitySpan = document.createElement('span');
    qualitySpan.textContent = 'Quality: ';
    const qualitySelect = document.createElement('select');
    qualitySelect.id = 'qualitySelect';
    qualitySelect.style.flex = '1';

    var qualityOptions = [
        { value: '1', text: 'Ultra High (Slower, Best Detail)' },
        { value: '2', text: 'High (Balanced)', selected: true },
        { value: '3', text: 'Medium (Faster)' },
        { value: '4', text: 'Low (Fastest)' }
    ];
    qualityOptions.forEach(function(opt) {
        var optEl = document.createElement('option');
        optEl.value = opt.value;
        optEl.textContent = opt.text;
        if (opt.selected) optEl.selected = true;
        qualitySelect.appendChild(optEl);
    });

    qualitySelect.addEventListener('change', function() {
        qualityLevel = parseInt(qualitySelect.value, 10);
    });
    qualityLabel.appendChild(qualitySpan);
    qualityLabel.appendChild(qualitySelect);
    generalSettings.appendChild(qualityLabel);

    // Add objects list
    const objectsList = document.getElementById('objectsList');
    for (const color in colorMap) {
        const label = document.createElement('label');
        const span = document.createElement('span');
        span.textContent = colorMap[color];
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!enabledColors[color];
        input.addEventListener('change', function() {
            enabledColors[color] = input.checked;
        });
        label.appendChild(span);
        label.appendChild(input);
        objectsList.appendChild(label);
    }

    displayTrackCode();
    updateAndClearPreviewCanvas();
    
    // Add upload button listener
    const uploadButton = document.getElementById('uploadButton');
    if (uploadButton) {
        uploadButton.addEventListener('change', handleImageUpload);
    }

    // Add button event listeners (no inline onclick)
    var btnGenerate = document.getElementById('btnGenerate');
    var btnCopy = document.getElementById('btnCopy');
    var btnReset = document.getElementById('btnReset');
    var btnDownload = document.getElementById('btnDownload');
    if (btnGenerate) btnGenerate.addEventListener('click', genTrackFromImageData);
    if (btnCopy) btnCopy.addEventListener('click', copyToClipboard);
    if (btnReset) btnReset.addEventListener('click', resetProject);
    if (btnDownload) btnDownload.addEventListener('click', downloadTrackCode);
});

// ─── Canvas rendering ───────────────────────────────────────────────────────

/**
 * Updates the drag offset based on mouse event.
 * @param {MouseEvent} event
 */
function updateOffsetDrag(event) {
    const rect = previewCanvas.getBoundingClientRect();
    const currentX = event.clientX - rect.left;
    const currentY = event.clientY - rect.top;
    
    const deltaX = (currentX - dragStartX) / previewZoom;
    const deltaY = (currentY - dragStartY) / previewZoom;
    
    xOffset = dragStartOffsetX + Math.round(deltaX);
    yOffset = dragStartOffsetY + Math.round(deltaY);
    updateAndClearPreviewCanvas();
}

/**
 * Redraws the preview canvas with all loaded images and UI elements.
 */
function updateAndClearPreviewCanvas() {
    const ctx = previewCanvas.getContext('2d');
    previewCanvas.width = previewCanvas.clientWidth;
    previewCanvas.height = previewCanvas.clientHeight;
    
    const centerX = previewCanvas.width / 2;
    const centerY = previewCanvas.height / 2;
    
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    
    ctx.save();
    
    ctx.translate(centerX, centerY);
    ctx.scale(previewZoom, previewZoom);
    ctx.translate(-centerX, -centerY);
    
    if (imageObjects.length === 0) {
        // Placeholder message
        ctx.fillStyle = '#94a3b8';
        ctx.textAlign = 'center';
        ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, "Segoe UI"';
        ctx.fillText('Upload an image to get started', centerX, centerY - 10);
        ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI"';
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText('Drag & drop or use the upload button', centerX, centerY + 16);
    } else {
        // Draw all images with their offsets and scale
        imageObjects.forEach(function(imgObj, index) {
            const offset = imageOffsets[index] || { x: 0, y: 0 };
            const scale = imageScales[index] || 1.0;
            const scaledW = imgObj.width * scale;
            const scaledH = imgObj.height * scale;
            const imgX = centerX - scaledW / 2 + offset.x + xOffset;
            const imgY = centerY - scaledH / 2 + offset.y + yOffset;
            ctx.drawImage(imgObj, imgX, imgY, scaledW, scaledH);
        });

        // Draw spawn point marker
        ctx.beginPath();
        ctx.arc(centerX, centerY, 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 68, 68, 0.9)';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Crosshair
        const crossSize = 12;
        ctx.strokeStyle = 'rgba(255, 68, 68, 0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(centerX - crossSize, centerY);
        ctx.lineTo(centerX + crossSize, centerY);
        ctx.moveTo(centerX, centerY - crossSize);
        ctx.lineTo(centerX, centerY + crossSize);
        ctx.stroke();

        // Label
        ctx.textAlign = 'center';
        ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI"';
        ctx.fillStyle = '#1a1a1a';
        ctx.fillText('SPAWN (0,0)', centerX, centerY - 16);
    }
    
    ctx.restore();

    // Zoom indicator (drawn outside the zoom transform)
    const zoomText = Math.round(previewZoom * 100) + '%';
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI"';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.textAlign = 'right';
    ctx.fillText(zoomText, previewCanvas.width - 12, previewCanvas.height - 12);
}

// ─── Keyboard & wheel events ────────────────────────────────────────────────

let keysPressed = {};

document.addEventListener('keydown', function(event) {
    keysPressed[event.key] = true;
});

document.addEventListener('keyup', function(event) {
    keysPressed[event.key] = false;
});

previewCanvas.addEventListener('wheel', function(event) {
    event.preventDefault();
    const zoomFactor = 0.12;
    
    if (event.deltaY < 0) {
        previewZoom += zoomFactor;
    } else {
        previewZoom -= zoomFactor;
    }
    
    previewZoom = Math.max(0.4, Math.min(3, previewZoom));
    updateAndClearPreviewCanvas();
});

// ─── Clipboard ──────────────────────────────────────────────────────────────

/**
 * Copies the generated track string to the clipboard.
 */
function copyToClipboard() {
    if (!trackString) {
        showToast('No track code to copy. Generate one first.', 'warning');
        return;
    }
    navigator.clipboard.writeText(trackString)
        .then(function() {
            showToast('Track code copied to clipboard!', 'success');
        })
        .catch(function() {
            showToast('Copy failed. Try manually copying instead.', 'error');
        });
}

/**
 * Displays track code in the output textarea, truncating if too large to avoid freezing the browser.
 * @param {number} [objectCount] - Number of objects generated (omit for raw display)
 */
function displayTrackCode(objectCount) {
    var header = objectCount != null ? 'Track Generated!\nTotal Objects: ' + objectCount + '\n\n' : '';
    if (trackString.length > LARGE_CODE_DISPLAY_LIMIT) {
        var preview = trackString.substring(0, LARGE_CODE_DISPLAY_LIMIT);
        outputField.value = header + preview +
            '\n\n--- Track code truncated for display (' + trackString.length.toLocaleString() + ' characters total) ---' +
            '\nUse the Copy or Download button to get the full code.';
    } else {
        outputField.value = header + trackString;
    }
    updateDownloadButton();
}

/**
 * Downloads the current track code as a text file.
 */
function downloadTrackCode() {
    if (!trackString) {
        showToast('No track code to download. Generate one first.', 'warning');
        return;
    }
    var blob = new Blob([trackString], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'trazify-track.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
    showToast('Track code downloaded!', 'success');
}

/**
 * Shows or hides the download button based on whether a track code exists.
 */
function updateDownloadButton() {
    var btnDownload = document.getElementById('btnDownload');
    if (btnDownload) {
        btnDownload.style.display = trackString ? '' : 'none';
    }
}

// ─── Image upload and management ────────────────────────────────────────────

/**
 * Handles image file uploads with validation.
 * @param {Event} event - The file input change event
 */
async function handleImageUpload(event) {
    const files = event.target.files;
    
    if (files.length > 5) {
        showToast('Maximum 5 images per project. Only first 5 will be loaded.', 'warning');
    }
    
    const maxFiles = Math.min(files.length, 5);
    if (maxFiles === 0) return;
    
    // Validate all files first
    const filesToProcess = Array.from(files).slice(0, 5);
    const validFiles = [];
    
    for (let i = 0; i < filesToProcess.length; i++) {
        const file = filesToProcess[i];
        try {
            const result = await validateImageFile(file);
            if (result.valid) {
                validFiles.push({ file: file, index: i, isSvg: result.isSvg });
            } else {
                showToast('Invalid image file: ' + file.name, 'error');
            }
        } catch (err) {
            showToast('Failed to validate file: ' + file.name, 'error');
        }
    }

    if (validFiles.length === 0) {
        showToast('No valid image files found.', 'error');
        return;
    }
    
    // Clean up old object URLs
    revokeOldObjectUrls();
    
    loadedImages = new Array(validFiles.length);
    imageOffsets = new Array(validFiles.length);
    imageScales = new Array(validFiles.length);
    imageObjects = [];
    currentImageIndex = 0;
    let loadedCount = 0;
    
    validFiles.forEach(function(item, idx) {
        const file = item.file;
        // Use Blob URLs instead of Data URLs for better memory efficiency
        const objectUrl = URL.createObjectURL(file);
        
        loadedImages[idx] = {
            src: objectUrl,
            name: file.name,
            objectUrl: objectUrl,
            isSvg: item.isSvg || false
        };
        imageOffsets[idx] = { x: 0, y: 0 };
        imageScales[idx] = 1.0;
        loadedCount++;
        
        if (loadedCount === validFiles.length) {
            loadAllImages();
            buildImageGallery();
            updateImagePositioningUI();
        }
    });
}

/**
 * Revokes all existing Blob Object URLs to free memory.
 */
function revokeOldObjectUrls() {
    loadedImages.forEach(function(img) {
        if (img && img.objectUrl) {
            URL.revokeObjectURL(img.objectUrl);
        }
    });
}

/**
 * Loads all images from their URLs into Image objects for canvas rendering.
 */
function loadAllImages() {
    imageObjects = new Array(loadedImages.length);
    let loadedCount = 0;
    const totalImages = loadedImages.length;
    
    if (totalImages === 0) {
        imageData = null;
        updateAndClearPreviewCanvas();
        return;
    }
    
    loadedImages.forEach(function(imgItem, index) {
        const imgObj = new Image();
        imgObj.onload = function() {
            imageObjects[index] = imgObj;
            loadedCount++;
            if (loadedCount === totalImages) {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = imageObjects[0].width;
                canvas.height = imageObjects[0].height;
                ctx.drawImage(imageObjects[0], 0, 0);
                imageData = ctx.getImageData(0, 0, imageObjects[0].width, imageObjects[0].height);
                updateAndClearPreviewCanvas();
            }
        };
        imgObj.onerror = function() {
            showToast('Failed to load image: ' + imgItem.name, 'error');
        };
        imgObj.src = imgItem.src;
    });
}

/**
 * Builds the image positioning UI controls in the sidebar.
 */
function updateImagePositioningUI() {
    const imagesSection = document.getElementById('imagesSection');
    let positioningDiv = document.getElementById('imagePositioning');
    
    if (!positioningDiv) {
        positioningDiv = document.createElement('div');
        positioningDiv.id = 'imagePositioning';
        positioningDiv.className = 'section-divider';
        imagesSection.appendChild(positioningDiv);
    }
    
    // Clear children using DOM methods
    while (positioningDiv.firstChild) {
        positioningDiv.removeChild(positioningDiv.firstChild);
    }
    
    if (loadedImages.length < 1) {
        positioningDiv.style.display = 'none';
        return;
    }
    
    positioningDiv.style.display = 'block';
    const title = document.createElement('h3');
    title.textContent = 'Image Positioning';
    positioningDiv.appendChild(title);
    
    loadedImages.forEach(function(img, index) {
        const container = document.createElement('div');
        container.className = 'image-position-container';
        
        // Sanitize the file name for display (strip any non-printable characters)
        const safeName = img.name.replace(/[^\x20-\x7E]/g, '');
        
        const label = document.createElement('div');
        label.className = 'image-position-label';
        label.textContent = (index + 1) + '. ' + safeName;
        container.appendChild(label);
        
        const inputsRow = document.createElement('div');
        inputsRow.className = 'image-inputs-row';
        
        ['X', 'Y'].forEach(function(axis) {
            const inputLabel = document.createElement('label');
            inputLabel.className = 'image-axis-label';
            const axisSpan = document.createElement('span');
            axisSpan.textContent = axis + ' Position';
            axisSpan.className = 'image-axis-span';
            const input = document.createElement('input');
            input.type = 'number';
            input.value = imageOffsets[index][axis.toLowerCase()];
            input.setAttribute('aria-label', safeName + ' ' + axis + ' position');
            input.addEventListener('change', function() {
                imageOffsets[index][axis.toLowerCase()] = parseInt(input.value, 10);
                updateAndClearPreviewCanvas();
            });
            inputLabel.appendChild(axisSpan);
            inputLabel.appendChild(input);
            inputsRow.appendChild(inputLabel);
        });
        
        // Scale slider
        const scaleRow = document.createElement('div');
        scaleRow.className = 'image-scale-row';
        
        const scaleLabel = document.createElement('span');
        scaleLabel.textContent = 'Scale';
        scaleLabel.className = 'image-scale-label';
        
        const scaleSlider = document.createElement('input');
        scaleSlider.type = 'range';
        scaleSlider.min = '0.1';
        scaleSlider.max = '3';
        scaleSlider.step = '0.1';
        scaleSlider.value = imageScales[index] || 1.0;
        scaleSlider.style.flex = '1';
        scaleSlider.setAttribute('aria-label', safeName + ' scale');
        
        const scaleValue = document.createElement('span');
        scaleValue.textContent = (imageScales[index] || 1.0).toFixed(1) + 'x';
        scaleValue.className = 'image-scale-value';
        
        scaleSlider.addEventListener('input', function() {
            const val = parseFloat(scaleSlider.value);
            imageScales[index] = val;
            scaleValue.textContent = val.toFixed(1) + 'x';
            updateAndClearPreviewCanvas();
        });
        
        scaleRow.appendChild(scaleLabel);
        scaleRow.appendChild(scaleSlider);
        scaleRow.appendChild(scaleValue);
        container.appendChild(inputsRow);
        container.appendChild(scaleRow);
        positioningDiv.appendChild(container);
    });
}

/**
 * Builds the image gallery thumbnails in the sidebar.
 */
function buildImageGallery() {
    const imageGallery = document.getElementById('imageGallery');
    const imagesSection = document.getElementById('imagesSection');
    
    // Clear children using DOM methods
    while (imageGallery.firstChild) {
        imageGallery.removeChild(imageGallery.firstChild);
    }
    
    if (loadedImages.length < 1) {
        imagesSection.classList.remove('visible');
        return;
    }
    
    imagesSection.classList.add('visible');
    
    loadedImages.forEach(function(img, index) {
        const thumb = document.createElement('img');
        thumb.src = img.src;
        thumb.alt = img.name;
        thumb.className = 'image-thumbnail' + (index === currentImageIndex ? ' active' : '');
        thumb.addEventListener('click', function() {
            currentImageIndex = index;
            buildImageGallery();
        });
        imageGallery.appendChild(thumb);
    });
}

// ─── Color matching ─────────────────────────────────────────────────────────

/**
 * Finds the closest enabled color to the given RGB values.
 * @param {number} r - Red channel (0-255)
 * @param {number} g - Green channel (0-255)
 * @param {number} b - Blue channel (0-255)
 * @returns {string|null} The closest color hex string, or null
 */
function getClosestColor(r, g, b) {
    let closestColor = null;
    let closestDistanceSq = Infinity;
    for (const hex in colorMap) {
        if (!enabledColors[hex]) continue;
        const colorR = parseInt(hex.slice(1, 3), 16);
        const colorG = parseInt(hex.slice(3, 5), 16);
        const colorB = parseInt(hex.slice(5, 7), 16);
        const distanceSq = (r - colorR) * (r - colorR) +
            (g - colorG) * (g - colorG) +
            (b - colorB) * (b - colorB);
        if (distanceSq < closestDistanceSq) {
            closestDistanceSq = distanceSq;
            closestColor = hex;
        }
    }
    return closestColor;
}

// ─── Track generation with Web Worker ───────────────────────────────────────

/**
 * Cancels any in-progress track generation.
 */
function cancelGeneration() {
    if (currentWorker) {
        currentWorker.terminate();
        currentWorker = null;
    }
    if (workerTimeout) {
        clearTimeout(workerTimeout);
        workerTimeout = null;
    }
}

/**
 * Generates track code from the loaded images using a Web Worker.
 */
function genTrackFromImageData() {
    if (imageObjects.length === 0) {
        showToast('Please upload an image first', 'warning');
        return;
    }

    const anyColorEnabled = Object.values(enabledColors).some(function(v) { return v; });
    if (!anyColorEnabled) {
        showToast('Please enable at least one object type before generating.', 'warning');
        return;
    }

    // Cancel any in-progress generation
    cancelGeneration();

    const btnGenerate = document.getElementById('btnGenerate');
    const originalText = btnGenerate.textContent;
    btnGenerate.textContent = 'Processing...';
    btnGenerate.disabled = true;

    // Show progress bar
    const progressContainer = document.getElementById('progressContainer');
    const progressBarFill   = document.getElementById('progressBarFill');
    const progressText      = document.getElementById('progressText');
    const progressDetail    = document.getElementById('progressDetail');
    const progressBarTrack  = document.getElementById('progressBarTrack');
    progressContainer.classList.add('visible');
    progressBarFill.style.width = '0%';
    progressText.textContent = '0%';
    if (progressDetail) progressDetail.textContent = '';
    if (progressBarTrack) progressBarTrack.setAttribute('aria-valuenow', '0');

    outputField.value = 'Generating track code...\n\nQuality: ' + ['Ultra High', 'High', 'Medium', 'Low'][qualityLevel - 1];

    // Build image data arrays to send to worker, using Transferable Objects.
    // For SVG images with scale > 1, render at the target resolution so the
    // browser rasterises vectors at full quality instead of upscaling raster pixels.
    const imageDataArrays = [];
    const transferables = [];
    const effectiveScales = [];
    for (let i = 0; i < imageObjects.length; i++) {
        const imgObj = imageObjects[i];
        const scale  = imageScales[i] || 1.0;
        const isSvg  = loadedImages[i] && loadedImages[i].isSvg;

        const canvas = document.createElement('canvas');
        const ctx    = canvas.getContext('2d');

        if (isSvg && scale > 1) {
            // Render the SVG at the scaled resolution (capped for safety)
            const renderW = Math.min(Math.round(imgObj.width  * scale), SVG_MAX_RENDER_DIM);
            const renderH = Math.min(Math.round(imgObj.height * scale), SVG_MAX_RENDER_DIM);
            canvas.width  = renderW;
            canvas.height = renderH;
            ctx.drawImage(imgObj, 0, 0, renderW, renderH);
            // Scale already baked into resolution — tell the worker to use 1×
            effectiveScales.push(1.0);
        } else {
            canvas.width  = imgObj.width;
            canvas.height = imgObj.height;
            ctx.drawImage(imgObj, 0, 0);
            effectiveScales.push(scale);
        }

        const imgDataObj = ctx.getImageData(0, 0, canvas.width, canvas.height);
        imageDataArrays.push({
            data:   imgDataObj.data,
            width:  imgDataObj.width,
            height: imgDataObj.height
        });
        transferables.push(imgDataObj.data.buffer);
    }

    // Launch Web Worker
    currentWorker = new Worker('js/track-worker.js');

    // Set timeout for safety
    workerTimeout = setTimeout(function() {
        if (currentWorker) {
            currentWorker.terminate();
            currentWorker = null;
            outputField.value = 'Error: Track generation timed out. Try a lower quality setting or a simpler image.';
            showToast('Generation timed out after ' + (WORKER_TIMEOUT_MS / 1000) + ' seconds.', 'error');
            btnGenerate.textContent = originalText;
            btnGenerate.disabled = false;
            progressContainer.classList.remove('visible');
        }
    }, WORKER_TIMEOUT_MS);

    var messagePayload = {
        imageDataArrays: imageDataArrays,
        colorMap:        colorMap,
        enabledColors:   enabledColors,
        qualityLevel:    qualityLevel,
        imageOffsets:    imageOffsets,
        imageScales:     effectiveScales,
        xOffset:         xOffset,
        yOffset:         yOffset
    };

    // Use Transferable Objects for better performance
    currentWorker.postMessage(messagePayload, transferables);

    currentWorker.onmessage = function(e) {
        const msg = e.data;

        if (msg.type === 'progress') {
            const pct = Math.min(msg.percent, 100);
            progressBarFill.style.width = pct + '%';
            progressText.textContent = pct + '%';
            if (progressBarTrack) progressBarTrack.setAttribute('aria-valuenow', String(pct));
            if (progressDetail) {
                progressDetail.textContent = 'Processing image ' + (msg.imageIndex + 1) + ' of ' + msg.totalImages + ' · ' + msg.objectCount + ' objects';
            }
            outputField.value = 'Processing image ' + (msg.imageIndex + 1) + ' of ' + msg.totalImages +
                '...\nQuality: ' + ['Ultra High', 'High', 'Medium', 'Low'][qualityLevel - 1] +
                '\nTotal objects so far: ' + msg.objectCount;
        } else if (msg.type === 'complete') {
            clearTimeout(workerTimeout);
            workerTimeout = null;
            trackString = msg.code;
            displayTrackCode(msg.objectCount);
            btnGenerate.textContent = originalText;
            btnGenerate.disabled = false;
            progressBarFill.style.width = '100%';
            progressText.textContent = '100%';
            if (progressBarTrack) progressBarTrack.setAttribute('aria-valuenow', '100');
            if (progressDetail) progressDetail.textContent = 'Complete — ' + msg.objectCount + ' objects generated';
            setTimeout(function() { progressContainer.classList.remove('visible'); }, 1500);
            currentWorker.terminate();
            currentWorker = null;
        } else if (msg.type === 'error') {
            clearTimeout(workerTimeout);
            workerTimeout = null;
            outputField.value = 'Error: ' + msg.message;
            showToast('Generation failed: ' + msg.message, 'error');
            btnGenerate.textContent = originalText;
            btnGenerate.disabled = false;
            progressContainer.classList.remove('visible');
            currentWorker.terminate();
            currentWorker = null;
        }
    };

    currentWorker.onerror = function(err) {
        clearTimeout(workerTimeout);
        workerTimeout = null;
        outputField.value = 'Error: Failed to generate track code. Try a simpler image.';
        showToast('Generation failed. Check console for details.', 'error');
        btnGenerate.textContent = originalText;
        btnGenerate.disabled = false;
        progressContainer.classList.remove('visible');
        currentWorker.terminate();
        currentWorker = null;
    };
}

// ─── Project reset ──────────────────────────────────────────────────────────

/**
 * Resets the entire project state and UI.
 */
function resetProject() {
    try {
        // Cancel any in-progress generation
        cancelGeneration();

        // Revoke old object URLs
        revokeOldObjectUrls();

        // Clear all data
        trackString = '';
        imageData = null;
        loadedImages = [];
        imageObjects = [];
        imageOffsets = [];
        imageScales = [];
        currentImageIndex = 0;
        xOffset = 0;
        yOffset = 0;
        previewZoom = 1;
        qualityLevel = 2;
        
        // Reset UI
        if (outputField) {
            outputField.value = '';
        }
        updateDownloadButton();
        const qualitySelect = document.getElementById('qualitySelect');
        if (qualitySelect) qualitySelect.value = '2';
        
        const uploadBtn = document.getElementById('uploadButton');
        if (uploadBtn) uploadBtn.value = '';
        
        // Clear image gallery
        const imageGallery = document.getElementById('imageGallery');
        if (imageGallery) {
            while (imageGallery.firstChild) {
                imageGallery.removeChild(imageGallery.firstChild);
            }
        }
        
        const imagesSection = document.getElementById('imagesSection');
        if (imagesSection) {
            imagesSection.classList.remove('visible');
        }
        
        // Clear positioning
        const positioningDiv = document.getElementById('imagePositioning');
        if (positioningDiv) {
            while (positioningDiv.firstChild) {
                positioningDiv.removeChild(positioningDiv.firstChild);
            }
            positioningDiv.style.display = 'none';
        }

        // Hide progress
        const progressContainer = document.getElementById('progressContainer');
        if (progressContainer) {
            progressContainer.classList.remove('visible');
        }
        
        updateAndClearPreviewCanvas();
        showToast('Project reset successfully.', 'info');
    } catch (error) {
        // Fallback basic cleanup
        trackString = '';
        imageData = null;
        loadedImages = [];
        imageObjects = [];
        imageOffsets = [];
        imageScales = [];
        xOffset = 0;
        yOffset = 0;
        updateAndClearPreviewCanvas();
    }
}
