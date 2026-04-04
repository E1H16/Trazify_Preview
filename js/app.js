const outputField = document.getElementById('outputField')
const previewCanvas = document.getElementById('previewCanvas')
const sidebar = document.getElementById('sidebar')
const settingsContainer = document.getElementById('settingsContainer')
const generalSettings = document.getElementById('generalSettings')

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
    // '#F59322': 'Helicopter',
    // '#93D34E': 'Truck',
    // '#F02627': 'Balloon',
    // '#A683C4': 'Blob'
};

let trackString = ''
let imageData = null
let loadedImages = []  // {src, name}
let imageObjects = []  // Image objects for rendering
let imageOffsets = []  // [{x, y}, ...] for each image
let imageScales = []   // [1.0, 0.5, ...] scale per image
let currentImageIndex = 0

// Settings
let xOffset = 0
let yOffset = 0
let previewZoom = 1
let qualityLevel = 2  // 1=Ultra, 2=High, 3=Medium, 4=Low
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
    // '#F59322': false,
    // '#93D34E': false,
    // '#F02627': false,
    // '#A683C4': false
};

let isDragging = false
let dragStartX = 0
let dragStartY = 0
let dragStartOffsetX = 0
let dragStartOffsetY = 0

previewCanvas.addEventListener('mousedown', (event) => {
    isDragging = true;
    previewCanvas.style.cursor = 'grabbing';
    const rect = previewCanvas.getBoundingClientRect();
    dragStartX = event.clientX - rect.left;
    dragStartY = event.clientY - rect.top;
    dragStartOffsetX = xOffset;
    dragStartOffsetY = yOffset;
});

previewCanvas.addEventListener('mousemove', (event) => {
    if (isDragging) {
        updateOffsetDrag(event)
    }
});

previewCanvas.addEventListener('mouseup', () => {
    isDragging = false;
    previewCanvas.style.cursor = 'crosshair';
});

previewCanvas.addEventListener('mouseleave', () => {
    isDragging = false;
    previewCanvas.style.cursor = 'crosshair';
});

previewCanvas.addEventListener('touchstart', (event) => {
    event.preventDefault();
    const touch = event.touches[0];
    isDragging = true;
    const rect = previewCanvas.getBoundingClientRect();
    dragStartX = touch.clientX - rect.left;
    dragStartY = touch.clientY - rect.top;
    dragStartOffsetX = xOffset;
    dragStartOffsetY = yOffset;
}, { passive: false });

previewCanvas.addEventListener('touchmove', (event) => {
    event.preventDefault();
    if (isDragging) {
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

previewCanvas.addEventListener('touchend', () => {
    isDragging = false;
});

let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(updateAndClearPreviewCanvas, 50);
});



function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function init() {
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
    qualitySelect.innerHTML = `
        <option value="1">Ultra High (Slower)</option>
        <option value="2" selected>High (Balanced)</option>
        <option value="3">Medium (Faster)</option>
        <option value="4">Low (Fastest)</option>
    `;
    qualitySelect.addEventListener('change', () => {
        qualityLevel = parseInt(qualitySelect.value, 10);
    });
    qualityLabel.appendChild(qualitySpan);
    qualityLabel.appendChild(qualitySelect);
    generalSettings.appendChild(qualityLabel);

    // Add objects directly (no collapsible)
    const objectsList = document.getElementById('objectsList');
    for (const color in colorMap) {
        const label = document.createElement('label');
        const span = document.createElement('span');
        span.textContent = colorMap[color];
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!enabledColors[color];
        input.addEventListener('change', () => {
            enabledColors[color] = input.checked;
        });
        label.appendChild(span);
        label.appendChild(input);
        objectsList.appendChild(label);
    }

    outputField.value = trackString;
    updateAndClearPreviewCanvas();
    
    // Add upload button listener
    const uploadButton = document.getElementById('uploadButton');
    if (uploadButton) {
        uploadButton.addEventListener('change', handleImageUpload);
    }
}

function updateOffsetDrag(event) {
    const rect = previewCanvas.getBoundingClientRect();
    const currentX = event.clientX - rect.left;
    const currentY = event.clientY - rect.top;
    
    // Calcular delta del arrastre ajustado por zoom
    const deltaX = (currentX - dragStartX) / previewZoom;
    const deltaY = (currentY - dragStartY) / previewZoom;
    
    // Aplicar delta al offset inicial
    xOffset = dragStartOffsetX + Math.round(deltaX);
    yOffset = dragStartOffsetY + Math.round(deltaY);
    updateAndClearPreviewCanvas();
}

function updateAndClearPreviewCanvas() {
    const ctx = previewCanvas.getContext('2d');
    previewCanvas.width = previewCanvas.clientWidth;
    previewCanvas.height = previewCanvas.clientHeight;
    
    const centerX = previewCanvas.width / 2;
    const centerY = previewCanvas.height / 2;
    
    // Limpiar canvas con fondo blanco
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    
    ctx.save();
    
    // Aplicar zoom desde el centro
    ctx.translate(centerX, centerY);
    ctx.scale(previewZoom, previewZoom);
    ctx.translate(-centerX, -centerY);
    
    if (imageObjects.length === 0) {
        // Sin imagen - mostrar mensaje
        ctx.fillStyle = '#4a5568';
        ctx.textAlign = 'center';
        ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, "Segoe UI"';
        ctx.fillText('Upload an image to get started', centerX, centerY);
    } else {
        // Draw all images with their offsets and scale
        imageObjects.forEach((imgObj, index) => {
            const offset = imageOffsets[index] || { x: 0, y: 0 };
            const scale = imageScales[index] || 1.0;
            const scaledW = imgObj.width * scale;
            const scaledH = imgObj.height * scale;
            const imgX = centerX - scaledW / 2 + offset.x + xOffset;
            const imgY = centerY - scaledH / 2 + offset.y + yOffset;
            ctx.drawImage(imgObj, imgX, imgY, scaledW, scaledH);
        });

        // Draw spawn point marker (ORIGEN DEL TRACK)
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
    const zoomCtx = previewCanvas.getContext('2d');
    const zoomText = Math.round(previewZoom * 100) + '%';
    zoomCtx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI"';
    zoomCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    zoomCtx.textAlign = 'right';
    zoomCtx.fillText(zoomText, previewCanvas.width - 12, previewCanvas.height - 12);
}

let keysPressed = {};

document.addEventListener('keydown', (event) => {
    keysPressed[event.key] = true;
});

document.addEventListener('keyup', (event) => {
    keysPressed[event.key] = false;
});

previewCanvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const zoomFactor = 0.12;
    const oldZoom = previewZoom;
    
    if (event.deltaY < 0) {
        previewZoom += zoomFactor;
    } else {
        previewZoom -= zoomFactor;
    }
    
    // Límites estrictos para zoom: 0.4x a 3x
    previewZoom = Math.max(0.4, Math.min(3, previewZoom));
    updateAndClearPreviewCanvas();
});

function copyToClipboard() {
    navigator.clipboard.writeText(trackString)
        .then(() => {
            console.log('copied to clipboard')
            showToast('Track code copied to clipboard!', 'success')
        })
        .catch(err => {
            showToast('Copy failed. Try manually copying instead.', 'error')
        })
}

function handleImageUpload(event) {
    const files = event.target.files;
    
    // Limitar máximo 5 imágenes
    if (files.length > 5) {
        showToast('Maximum 5 images per project. Only first 5 will be loaded.', 'warning');
    }
    
    const maxFiles = Math.min(files.length, 5);
    if (maxFiles === 0) return;
    
    loadedImages = new Array(maxFiles);
    imageOffsets = new Array(maxFiles);
    imageScales = new Array(maxFiles);
    imageObjects = [];
    currentImageIndex = 0;
    let loadedCount = 0;
    
    Array.from(files).slice(0, 5).forEach((file, fileIndex) => {
        const reader = new FileReader();
        reader.onload = function (e) {
            // Preserve file order by index
            loadedImages[fileIndex] = {
                src: e.target.result,
                name: file.name
            };
            imageOffsets[fileIndex] = { x: 0, y: 0 };
            imageScales[fileIndex] = 1.0;
            loadedCount++;
            if (loadedCount === maxFiles) {
                loadAllImages();
                buildImageGallery();
                updateImagePositioningUI();
            }
        };
        reader.onerror = function() {
            console.error('Error reading file:', file.name);
            showToast('Failed to load image: ' + file.name, 'error');
        };
        reader.readAsDataURL(file);
    });
}

function loadAllImages() {
    imageObjects = new Array(loadedImages.length);
    let loadedCount = 0;
    const totalImages = loadedImages.length;
    
    if (totalImages === 0) {
        imageData = null;
        updateAndClearPreviewCanvas();
        return;
    }
    
    loadedImages.forEach((imgItem, index) => {
        const imgObj = new Image();
        imgObj.onload = function () {
            // Preserve order by using index, not push
            imageObjects[index] = imgObj;
            loadedCount++;
            if (loadedCount === totalImages) {
                // Use first image data for reference
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = imageObjects[0].width;
                canvas.height = imageObjects[0].height;
                ctx.drawImage(imageObjects[0], 0, 0);
                imageData = ctx.getImageData(0, 0, imageObjects[0].width, imageObjects[0].height);
                updateAndClearPreviewCanvas();
            }
        };
        imgObj.src = imgItem.src;
    });
}

function updateImagePositioningUI() {
    const imagesSection = document.getElementById('imagesSection');
    let positioningDiv = document.getElementById('imagePositioning');
    
    if (!positioningDiv) {
        positioningDiv = document.createElement('div');
        positioningDiv.id = 'imagePositioning';
        positioningDiv.style.borderTop = '1px solid rgba(255, 255, 255, 0.04)';
        positioningDiv.style.marginTop = '1rem';
        positioningDiv.style.paddingTop = '1rem';
        imagesSection.appendChild(positioningDiv);
    }
    
    positioningDiv.innerHTML = '';
    
    if (loadedImages.length < 1) {
        positioningDiv.style.display = 'none';
        return;
    }
    
    positioningDiv.style.display = 'block';
    const title = document.createElement('h3');
    title.textContent = 'Image Positioning';
    positioningDiv.appendChild(title);
    
    loadedImages.forEach((img, index) => {
        const container = document.createElement('div');
        container.className = 'image-position-container';
        
        const label = document.createElement('div');
        label.className = 'image-position-label';
        label.textContent = (index + 1) + '. ' + img.name;
        container.appendChild(label);
        
        const inputsRow = document.createElement('div');
        inputsRow.className = 'image-inputs-row';
        
        ['X', 'Y'].forEach((axis, axisIndex) => {
            const inputLabel = document.createElement('label');
            inputLabel.className = 'image-axis-label';
            const axisSpan = document.createElement('span');
            axisSpan.textContent = axis + ' Position';
            axisSpan.className = 'image-axis-span';
            const input = document.createElement('input');
            input.type = 'number';
            input.value = imageOffsets[index][axis.toLowerCase()];
            input.addEventListener('change', () => {
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
        
        const scaleValue = document.createElement('span');
        scaleValue.textContent = (imageScales[index] || 1.0).toFixed(1) + 'x';
        scaleValue.className = 'image-scale-value';
        
        scaleSlider.addEventListener('input', () => {
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

function buildImageGallery() {
    const imageGallery = document.getElementById('imageGallery');
    const imagesSection = document.getElementById('imagesSection');
    
    imageGallery.innerHTML = '';
    
    if (loadedImages.length < 1) {
        imagesSection.style.display = 'none';
        return;
    }
    
    imagesSection.style.display = 'block';
    
    loadedImages.forEach((img, index) => {
        const thumb = document.createElement('img');
        thumb.src = img.src;
        thumb.className = 'image-thumbnail' + (index === currentImageIndex ? ' active' : '');
        thumb.addEventListener('click', () => {
            currentImageIndex = index;
            buildImageGallery();
        });
        thumb.addEventListener('mouseenter', (e) => {
            if (index !== currentImageIndex) {
                e.target.classList.add('hover');
            }
        });
        thumb.addEventListener('mouseleave', (e) => {
            if (index !== currentImageIndex) {
                e.target.classList.remove('hover');
            }
        });
        imageGallery.appendChild(thumb);
    });
}



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

function genTrackFromImageData() {
    if (imageObjects.length === 0) {
        showToast('Please upload an image first', 'warning')
        return
    }

    const anyColorEnabled = Object.values(enabledColors).some(v => v);
    if (!anyColorEnabled) {
        showToast('Please enable at least one object type before generating.', 'warning');
        return;
    }

    const btnGenerate = document.querySelector('.primary-btn');
    const originalText = btnGenerate.textContent;
    btnGenerate.textContent = 'Processing...';
    btnGenerate.disabled = true;
    outputField.value = 'Generating track code...\n\nQuality: ' + ['Ultra High', 'High', 'Medium', 'Low'][qualityLevel - 1];

    processAllImages();

    function processAllImages() {
        try {
            const track = new FrhdTrack();
            let totalProcessedPixels = 0;
            let currentImageIdx = 0;
            
            // Process all images sequentially
            function processNextImage() {
                if (currentImageIdx >= imageObjects.length) {
                    // All images processed
                    completeProcessing(track, totalProcessedPixels);
                    return;
                }
                
                const imgObj = imageObjects[currentImageIdx];
                const imgOffset = imageOffsets[currentImageIdx] || { x: 0, y: 0 };
                
                // Create canvas and extract image data for this image
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = imgObj.width;
                canvas.height = imgObj.height;
                ctx.drawImage(imgObj, 0, 0);
                const currentImageData = ctx.getImageData(0, 0, imgObj.width, imgObj.height);
                
                // Process this image
                outputField.value = 'Processing image ' + (currentImageIdx + 1) + ' of ' + imageObjects.length + '...\nQuality: ' + ['Ultra High', 'High', 'Medium', 'Low'][qualityLevel - 1] + '\nTotal objects so far: ' + totalProcessedPixels;
                processImageChunked(track, currentImageData, imgOffset, currentImageIdx);
                
                function processImageChunked(trackObj, imgData, offset, imgIndex) {
                    // Downsampling determined by quality
                    let step = qualityLevel;  // 1=Ultra, 2=High, 3=Medium, 4=Low
                    
                    // Apply adaptive downsampling in addition to quality
                    if (imgData.width > 1500 || imgData.height > 1500) step = Math.max(step, 2);
                    if (imgData.width > 3000 || imgData.height > 3000) step = Math.max(step, 3);
                    if (imgData.width > 5000 || imgData.height > 5000) step = Math.max(step, 4);

                    let processedPixels = 0;
                    const CHUNK_SIZE = 50000;
                    let chunkPixelsProcessed = 0;
                    let yPos = 0;

                    function processNextChunk() {
                        const startTime = performance.now();
                        chunkPixelsProcessed = 0;
                        
                        while (yPos < imgData.height) {
                            for (let x = 0; x < imgData.width; x += step) {
                                const index = (yPos * imgData.width + x) * 4;
                                const alpha = imgData.data[index + 3];
                                if (alpha === 0) continue;
                                
                                const red = imgData.data[index];
                                const green = imgData.data[index + 1];
                                const blue = imgData.data[index + 2];
                                
                                // Skip only near-white pixels (brightness > 240)
                                // Lower values would skip valid game objects like Stars and Antigravity
                                const brightness = (red + green + blue) / 3;
                                if (brightness > 240) continue;
                                
                                const closestColor = getClosestColor(red, green, blue);
                                if (!closestColor) continue;
                                
                                processedPixels++;
                                totalProcessedPixels++;
                                chunkPixelsProcessed++;
                                
                                // Scale limit by quality: Ultra=120K, High=60K, Medium=30K, Low=15K
                                const maxObjects = [120000, 60000, 30000, 15000][qualityLevel - 1];
                                if (totalProcessedPixels > maxObjects) {
                                    outputField.value = 'Image too complex. Reduced detail for stability.\nTotal Objects: ' + totalProcessedPixels;
                                    completeProcessing(trackObj, totalProcessedPixels);
                                    return;
                                }

                                // Calculate track coordinates to match canvas preview
                                // Canvas draws pixel at: centerX - width/2 + offset.x + xOffset + x
                                // Spawn is at centerX (= track 0,0)
                                // So track position = (x - width/2 + offset.x + xOffset) * 2
                                const imgScale = imageScales[currentImageIdx] || 1.0;
                                const trackX = ((x - imgData.width / 2) * imgScale + offset.x + xOffset) * 2;
                                const trackY = ((yPos - imgData.height / 2) * imgScale + offset.y + yOffset) * 2;
                                
                                switch (colorMap[closestColor]) {
                                    case 'White (Strongly recommended)':
                                        break;
                                    case 'Bomb':
                                        trackObj.addBomb(trackX, trackY);
                                        break;
                                    case 'Gravity':
                                        trackObj.addGravity(trackX, trackY);
                                        break;
                                    case 'Helicopter':
                                        trackObj.addVehicle(trackX, trackY, 'heli');
                                        break;
                                    case 'Star':
                                        trackObj.addStar(trackX, trackY);
                                        break;
                                    case 'Boost':
                                        trackObj.addBoost(trackX, trackY);
                                        break;
                                    case 'Antigravity':
                                        trackObj.addAntigravity(trackX, trackY);
                                        break;
                                    case 'Checkpoint':
                                        trackObj.addCheckpoint(trackX, trackY);
                                        break;
                                    case 'Teleporter':
                                        trackObj.addTeleporter(trackX, trackY, (trackX + 2), (trackY + 2));
                                        break;
                                    case 'Truck':
                                        trackObj.addVehicle(trackX, trackY, 'truck');
                                        break;
                                    case 'Balloon':
                                        trackObj.addVehicle(trackX, trackY, 'balloon');
                                        break;
                                    case 'Blob':
                                        trackObj.addVehicle(trackX, trackY, 'blob');
                                        break;
                                    case 'PhysicsLine':
                                        trackObj.addPhysicsLine(trackX, trackY, (trackX + 2), (trackY + 2));
                                        break;
                                    case 'SceneryLine':
                                        trackObj.addSceneryLine(trackX, trackY, (trackX + 2), (trackY + 2));
                                        break;
                                }
                            }
                            
                            yPos += step;
                            
                            if (chunkPixelsProcessed >= CHUNK_SIZE) {
                                const elapsed = performance.now() - startTime;
                                setTimeout(processNextChunk, Math.max(10, 50 - elapsed));
                                return;
                            }
                        }
                        
                        // This image is done, move to next
                        currentImageIdx++;
                        setTimeout(processNextImage, 10);
                    }
                    
                    processNextChunk();
                }
            }
            
            processNextImage();
                    
        } catch (error) {
            console.error('Error generating track:', error);
            outputField.value = 'Error: Failed to generate track code. Try a simpler image.';
            btnGenerate.textContent = originalText;
            btnGenerate.disabled = false;
        }
    }
    
    function completeProcessing(track, pixelCount) {
        trackString = track.code;
        outputField.value = 'Track Generated!\nTotal Objects: ' + pixelCount + '\n\n' + trackString;
        btnGenerate.textContent = originalText;
        btnGenerate.disabled = false;
    }
}

function resetProject() {
    try {
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
        
        // Reset UI with element validation
        if (outputField) {
            outputField.value = '';
            outputField.innerText = '';
        }
        const qualitySelect = document.getElementById('qualitySelect');
        if (qualitySelect) qualitySelect.value = '2';
        
        const uploadBtn = document.getElementById('uploadButton');
        if (uploadBtn) uploadBtn.value = '';
        
        // Clear image gallery with validation
        const imageGallery = document.getElementById('imageGallery');
        if (imageGallery) {
            imageGallery.innerHTML = '';
        }
        
        const imagesSection = document.getElementById('imagesSection');
        if (imagesSection) {
            imagesSection.style.display = 'none';
        }
        
        // Clear positioning with validation
        const positioningDiv = document.getElementById('imagePositioning');
        if (positioningDiv) {
            positioningDiv.innerHTML = '';
            positioningDiv.style.display = 'none';
        }
        
        updateAndClearPreviewCanvas();
    } catch (error) {
        console.error('Error in resetProject:', error);
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