// ─── Trazify Pixel Processor — WebAssembly Module ───────────────────────────
//
// Accelerates the CPU-intensive pixel classification loop from track-worker.js.
// Exported functions use raw pointers for zero-copy interop with JavaScript.
//
// JS allocates buffers in Wasm linear memory via wasm_alloc(), copies pixel data
// and color palette in, calls process_pixels(), then reads results out as f64
// triplets (colorIndex, trackX, trackY).

// ─── Memory management ─────────────────────────────────────────────────────

/// Allocate `size` zero-initialized bytes in Wasm linear memory and return the pointer.
/// Callers must free the allocation via `wasm_dealloc` with the same size.
#[no_mangle]
pub extern "C" fn wasm_alloc(size: usize) -> *mut u8 {
    let mut buf = vec![0u8; size];
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// Free a buffer previously allocated with `wasm_alloc`.
#[no_mangle]
pub extern "C" fn wasm_dealloc(ptr: *mut u8, size: usize) {
    if !ptr.is_null() && size > 0 {
        unsafe {
            drop(Vec::from_raw_parts(ptr, 0, size));
        }
    }
}

// ─── Pixel processing ───────────────────────────────────────────────────────

/// Process a range of pixel rows from an RGBA image and classify each non-white,
/// non-transparent pixel by closest color match (Euclidean distance in RGB space).
///
/// # Arguments
/// * `pixels_ptr`      – pointer to RGBA pixel data (`width * height * 4` bytes)
/// * `width`           – image width in pixels
/// * `height`          – image height in pixels
/// * `step`            – sampling step (1 = every pixel, 2 = every other, etc.)
/// * `y_start`         – first row to process (inclusive)
/// * `y_end`           – last row to process (exclusive, capped at `height`)
/// * `colors_ptr`      – pointer to RGB color palette (`num_colors * 3` bytes)
/// * `num_colors`      – number of colors in the palette
/// * `scale`           – image scale factor
/// * `half_width`      – `width / 2.0`  (pre-computed for coordinate transform)
/// * `half_height`     – `height / 2.0` (pre-computed for coordinate transform)
/// * `offset_x`        – combined X offset (`imageOffset.x + globalXOffset`)
/// * `offset_y`        – combined Y offset (`imageOffset.y + globalYOffset`)
/// * `result_ptr`      – pointer to output buffer (`f64` triplets: colorIdx, trackX, trackY)
/// * `max_results`     – capacity of the result buffer in triplets
/// * `white_threshold` – brightness sum threshold above which pixels are skipped
///                       (e.g. 720 means avg brightness > 240 is white, 750 means > 250)
///
/// # Returns
/// Number of classified pixels written to `result_ptr`.
#[no_mangle]
pub extern "C" fn process_pixels(
    pixels_ptr: *const u8,
    width: u32,
    height: u32,
    step: u32,
    y_start: u32,
    y_end: u32,
    colors_ptr: *const u8,
    num_colors: u32,
    scale: f64,
    half_width: f64,
    half_height: f64,
    offset_x: f64,
    offset_y: f64,
    result_ptr: *mut f64,
    max_results: u32,
    white_threshold: u32,
) -> u32 {
    let w = width as usize;
    let total_px = (width as usize) * (height as usize) * 4;
    let pixels = unsafe { core::slice::from_raw_parts(pixels_ptr, total_px) };
    let colors = unsafe { core::slice::from_raw_parts(colors_ptr, (num_colors * 3) as usize) };
    let results =
        unsafe { core::slice::from_raw_parts_mut(result_ptr, (max_results * 3) as usize) };

    let s = step as usize;
    let nc = num_colors as usize;
    let y_e = core::cmp::min(y_end as usize, height as usize);
    let max_r = max_results as usize;
    let mut count: usize = 0;

    let mut y = y_start as usize;
    while y < y_e {
        let mut x: usize = 0;
        while x < w {
            let idx = (y * w + x) * 4;

            // Skip fully transparent pixels
            if pixels[idx + 3] == 0 {
                x += s;
                continue;
            }

            let r = pixels[idx] as i32;
            let g = pixels[idx + 1] as i32;
            let b = pixels[idx + 2] as i32;

            // Skip white-ish pixels above the configurable brightness threshold
            if (r + g + b) as u32 > white_threshold {
                x += s;
                continue;
            }

            // Find closest color (Euclidean distance, no sqrt needed)
            let mut min_dist = i32::MAX;
            let mut best: i32 = -1;

            for ci in 0..nc {
                let cr = colors[ci * 3] as i32;
                let cg = colors[ci * 3 + 1] as i32;
                let cb = colors[ci * 3 + 2] as i32;
                let dr = r - cr;
                let dg = g - cg;
                let db = b - cb;
                let dist = dr * dr + dg * dg + db * db;
                if dist < min_dist {
                    min_dist = dist;
                    best = ci as i32;
                }
            }

            if best < 0 || count >= max_r {
                if count >= max_r {
                    return count as u32;
                }
                x += s;
                continue;
            }

            // Coordinate transform — matches JS:
            //   trackX = ((x - width/2) * scale + offset.x + xOffset) * 2
            let track_x = ((x as f64 - half_width) * scale + offset_x) * 2.0;
            let track_y = ((y as f64 - half_height) * scale + offset_y) * 2.0;

            let i3 = count * 3;
            results[i3] = best as f64;
            results[i3 + 1] = track_x;
            results[i3 + 2] = track_y;
            count += 1;

            x += s;
        }
        y += s;
    }

    count as u32
}

/// Estimate the number of non-white, non-transparent pixels in an image
/// using sparse sampling. Used for adaptive step calculation.
///
/// # Arguments
/// * `pixels_ptr`      – pointer to RGBA pixel data
/// * `width`           – image width
/// * `height`          – image height
/// * `sample_step`     – sampling step (clamped to min 4)
/// * `white_threshold` – brightness sum threshold (e.g. 720 = avg > 240)
///
/// # Returns
/// Estimated total non-white pixel count (extrapolated from sample).
#[no_mangle]
pub extern "C" fn estimate_density(
    pixels_ptr: *const u8,
    width: u32,
    height: u32,
    sample_step: u32,
    white_threshold: u32,
) -> u32 {
    let w = width as usize;
    let h = height as usize;
    let total_px = w * h * 4;
    let pixels = unsafe { core::slice::from_raw_parts(pixels_ptr, total_px) };
    let step = core::cmp::max(sample_step as usize, 4);

    let mut non_white: u32 = 0;
    let mut sampled: u32 = 0;

    let mut y: usize = 0;
    while y < h {
        let mut x: usize = 0;
        while x < w {
            let idx = (y * w + x) * 4;
            sampled += 1;
            if pixels[idx + 3] == 0 {
                x += step;
                continue;
            }
            let bright =
                (pixels[idx] as u32 + pixels[idx + 1] as u32 + pixels[idx + 2] as u32) / 3;
            if bright <= white_threshold / 3 {
                non_white += 1;
            }
            x += step;
        }
        y += step;
    }

    if sampled == 0 {
        return 0;
    }

    let ratio = non_white as f64 / sampled as f64;
    let total_pixels = (w * h) as f64;
    (ratio * total_pixels) as u32
}
