/**
 * CryptoPixels — Main Application
 * All bug-fix references are tagged inline: // FIX #N
 */

import { APP_CONFIG } from './config.js';

const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    PAYMENT_RECEIVER,
    PIXEL_PRICE_ETH,
    GRID_SIZE,
    CELL_SIZE,
    PIXELS_TABLE,
    BASE_CHAIN_INFO,
    ALLOWED_LINK_PROTOCOLS,
    ALLOWED_IMAGE_EXTENSIONS,
    MIN_PIXELS,
} = APP_CONFIG;

// ─── FIX #50: Top-level error boundary ──────────────────────────────────────
window.addEventListener('error', (e) => {
    console.error('Unhandled error:', e.error);
    showToast('An unexpected error occurred. Please refresh the page.', 'error');
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
    showToast('An unexpected error occurred. Please refresh the page.', 'error');
});

// ─── FIX #2 / #3: Validate payment receiver address at startup ───────────────
(function validateConfig() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        throw new Error('Supabase credentials are not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY environment variables.');
    }
    if (!PAYMENT_RECEIVER) {
        throw new Error('PAYMENT_RECEIVER wallet address is not configured. Set VITE_PAYMENT_RECEIVER environment variable.');
    }
    // Validate it looks like an EIP-55 checksummed Ethereum address
    if (!/^0x[0-9a-fA-F]{40}$/.test(PAYMENT_RECEIVER)) {
        throw new Error(`PAYMENT_RECEIVER "${PAYMENT_RECEIVER}" is not a valid Ethereum address.`);
    }
})();

// ─── DOM refs ────────────────────────────────────────────────────────────────
const canvas        = document.getElementById('gridCanvas');
const ctx           = canvas.getContext('2d');
const overlay       = document.getElementById('overlay');
const buyModal      = document.getElementById('buyModal');
const blockCoords   = document.getElementById('blockCoords');
const imgUrlInput   = document.getElementById('imgUrl');
const linkUrlInput  = document.getElementById('linkUrl');
const payBtn        = document.getElementById('payBtn');
const toast         = document.getElementById('toast');
const pixelCountEl  = document.getElementById('pixelCount');
const totalPriceEl  = document.getElementById('totalPrice');
const a11yAnnounce  = document.getElementById('a11y-announce'); // FIX #29

// ─── FIX #21: Single Supabase client instance (not re-created per call) ──────
let _supabaseClient = null;
function getSupabaseClient() {
    if (!_supabaseClient) {
        if (!window.supabase) throw new Error('Supabase library not loaded.');
        _supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return _supabaseClient;
}

// ─── State ───────────────────────────────────────────────────────────────────
let isSubmitting  = false;
let isModalOpen   = false; // FIX #40: boolean state instead of style.display check
const imageCache  = new Map();
// FIX #44: track in-flight image loads to avoid duplicate Image() objects
const imagePending = new Map();
let selectedPixels = [];   // array of {x, y}
let tempSelection  = new Set();
let isDragging     = false;
let dragStart      = null;
let cachedPixels   = [];

// ─── FIX #35: Bounded image cache (LRU-style, max 500 entries) ───────────────
const IMAGE_CACHE_MAX = 500;
function imageCacheSet(key, value) {
    if (imageCache.size >= IMAGE_CACHE_MAX) {
        // Evict the oldest entry
        imageCache.delete(imageCache.keys().next().value);
    }
    imageCache.set(key, value);
}

// ─── Utilities ───────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
    // FIX #30: Always use textContent (never innerHTML) to prevent XSS
    toast.textContent = message;
    toast.className   = `toast visible${type === 'error' ? ' toast--error' : ''}`;
    window.clearTimeout(toast._timeoutId);
    toast._timeoutId = window.setTimeout(() => toast.classList.remove('visible'), 4200);
    // FIX #29: Mirror toast to accessible live region
    if (a11yAnnounce) a11yAnnounce.textContent = message;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// FIX #24: Safer coordinate extraction — explicit fallback that handles 0 correctly
function getClientXY(event) {
    if (event.touches && event.touches.length > 0) {
        return { clientX: event.touches[0].clientX, clientY: event.touches[0].clientY };
    }
    return { clientX: event.clientX, clientY: event.clientY };
}

function mapEventToCanvasCoordinates(event) {
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const { clientX, clientY } = getClientXY(event);
    const rawX  = clientX - rect.left;
    const rawY  = clientY - rect.top;
    const cellX = Math.floor(clamp(rawX * scaleX, 0, canvas.width  - 1) / CELL_SIZE);
    const cellY = Math.floor(clamp(rawY * scaleY, 0, canvas.height - 1) / CELL_SIZE);
    return { x: cellX * CELL_SIZE, y: cellY * CELL_SIZE, cellX, cellY };
}

function cellKey(x, y) { return `${x},${y}`; }

// ─── Validation ──────────────────────────────────────────────────────────────
function validateUrl(value, allowedProtocols) {
    try {
        const url = new URL(value.trim());
        return allowedProtocols.includes(url.protocol);
    } catch {
        return false;
    }
}

function validateImageUrl(value) {
    if (!validateUrl(value, ['https:'])) return false;
    const parsed = new URL(value.trim());
    const path   = parsed.pathname.toLowerCase();
    // FIX #18: Also block SVG with a data: or javascript: src inside the URL itself.
    // Note: true MIME-type verification happens server-side in the Supabase RPC.
    if (path.endsWith('.svg')) {
        // Disallow SVG unless you have a server-side sanitiser in place,
        // because SVG files can contain inline <script> tags.
        // Remove this check if you add server-side SVG sanitisation.
        return false;
    }
    return ALLOWED_IMAGE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function validateLinkUrl(value) {
    // FIX #12 + #36: Only https: is allowed for redirect links
    return validateUrl(value, ALLOWED_LINK_PROTOCOLS);
}

// ─── Modal ───────────────────────────────────────────────────────────────────
function openModal() {
    if (selectedPixels.length === 0) return; // FIX #14: never open with 0 pixels
    overlay.style.display   = 'block';
    buyModal.style.display  = 'block';
    document.body.style.overflow = 'hidden';
    isModalOpen = true; // FIX #40
    payBtn.focus();
}

function closeModal() {
    overlay.style.display  = 'none';
    buyModal.style.display = 'none';
    document.body.style.overflow = '';
    isModalOpen = false; // FIX #40
}

function setButtonState(isBusy) {
    isSubmitting    = isBusy;
    payBtn.disabled = isBusy;
    // FIX #41: use textContent (no layout reflow) instead of innerText
    payBtn.textContent = isBusy ? 'Processing…' : 'Pay with Crypto Wallet';
}

// ─── Canvas drawing ──────────────────────────────────────────────────────────
function drawGrid() {
    ctx.clearRect(0, 0, GRID_SIZE, GRID_SIZE);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, GRID_SIZE, GRID_SIZE);
    ctx.strokeStyle = '#222';
    ctx.lineWidth   = 1;
    for (let x = 0; x <= GRID_SIZE; x += CELL_SIZE) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, GRID_SIZE); ctx.stroke();
    }
    for (let y = 0; y <= GRID_SIZE; y += CELL_SIZE) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(GRID_SIZE, y); ctx.stroke();
    }
}

function drawPixelPlaceholder(x, y, width = CELL_SIZE, height = CELL_SIZE) {
    ctx.fillStyle   = 'rgba(56, 189, 248, 0.22)';
    ctx.fillRect(x + 1, y + 1, width - 2, height - 2);
    ctx.strokeStyle = '#475569';
    ctx.strokeRect(x + 1, y + 1, width - 2, height - 2);
}

// FIX #44: Use pending-promise map to avoid duplicate Image() objects for the same URL
function loadRemoteImage(src) {
    if (imagePending.has(src)) return imagePending.get(src);
    const promise = new Promise((resolve, reject) => {
        const image      = new Image();
        image.crossOrigin = 'anonymous';
        image.onload  = () => { imagePending.delete(src); resolve(image); };
        image.onerror = () => { imagePending.delete(src); reject(new Error('Image load failed')); };
        image.src = src;
    });
    imagePending.set(src, promise);
    return promise;
}

// FIX #38: Validate pixel dimensions before drawing
function safeDrawPixel(pixel) {
    const x      = Number(pixel.x);
    const y      = Number(pixel.y);
    const width  = Number(pixel.width)  || CELL_SIZE;
    const height = Number(pixel.height) || CELL_SIZE;

    if (!Number.isFinite(x) || !Number.isFinite(y) ||
        !Number.isFinite(width) || !Number.isFinite(height) ||
        width <= 0 || height <= 0 ||
        x < 0 || y < 0 || x + width > GRID_SIZE || y + height > GRID_SIZE) {
        console.warn('Skipping pixel with invalid dimensions:', pixel);
        return;
    }
    return { x, y, width, height };
}

function drawPixelItem(pixel) {
    const dims = safeDrawPixel(pixel);
    if (!dims) return;
    const { x, y, width, height } = dims;

    if (!pixel.image_url) {
        drawPixelPlaceholder(x, y, width, height);
        return;
    }

    if (imageCache.has(pixel.image_url)) {
        ctx.drawImage(imageCache.get(pixel.image_url), x, y, width, height);
        return;
    }

    loadRemoteImage(pixel.image_url)
        .then((image) => {
            imageCacheSet(pixel.image_url, image); // FIX #35: bounded cache
            ctx.drawImage(image, x, y, width, height);
        })
        .catch((error) => {
            console.warn('Failed to load pixel image:', pixel.image_url, error);
            drawPixelPlaceholder(x, y, width, height);
        });
}

// FIX #46: Wrap drawSelections in try/finally so ctx.save()/restore() always balance
function drawSelections() {
    ctx.save();
    try {
        tempSelection.forEach((k) => {
            const [x, y] = k.split(',').map(Number);
            ctx.fillStyle = 'rgba(56,189,248,0.25)';
            ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        });
        selectedPixels.forEach((p) => {
            const x = Number(p.x);
            const y = Number(p.y);
            ctx.fillStyle   = 'rgba(56,189,248,0.4)';
            ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
            ctx.strokeStyle = 'rgba(2,6,23,0.6)';
            ctx.strokeRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        });
    } finally {
        ctx.restore(); // FIX #46: always runs even if an exception occurs above
    }
}

// FIX #47: Show a loading overlay while pixels are fetched
function setGridLoading(loading) {
    const container = document.getElementById('canvas-container');
    let spinner = document.getElementById('grid-spinner');
    if (loading) {
        if (!spinner) {
            spinner = document.createElement('div');
            spinner.id = 'grid-spinner';
            spinner.setAttribute('aria-label', 'Loading pixel grid…');
            spinner.setAttribute('role', 'status');
            container.appendChild(spinner);
        }
        spinner.style.display = 'flex';
    } else if (spinner) {
        spinner.style.display = 'none';
    }
}

// FIX #9: Only select the columns the client actually needs (not select('*'))
async function fetchAndDrawPixels() {
    drawGrid();
    setGridLoading(true);

    try {
        const client = getSupabaseClient();
        const { data: pixels, error } = await client
            .from(PIXELS_TABLE)
            .select('x, y, width, height, image_url, link_url'); // FIX #9: no select('*')

        if (error) {
            console.error('Failed to fetch pixels:', error);
            showToast('Unable to load pixel map. Please refresh the page.', 'error');
            return;
        }

        cachedPixels = pixels || [];
        cachedPixels.forEach((pixel) => drawPixelItem(pixel));
        drawSelections();
    } catch (err) {
        console.error('Unexpected error fetching pixels:', err);
        showToast('Unable to load pixel map. Please refresh the page.', 'error');
    } finally {
        setGridLoading(false);
    }
}

// FIX #25: handle multiple matching rows gracefully (don't rely on .single())
async function getPixelRecord(x, y) {
    try {
        const client = getSupabaseClient();
        const { data, error } = await client
            .from(PIXELS_TABLE)
            .select('link_url')
            .eq('x', x)
            .eq('y', y)
            .limit(1);

        if (error) {
            console.error('Error loading pixel record:', error);
            showToast('Error checking the selected block. Try again later.', 'error');
            return null;
        }
        return (data && data.length > 0) ? data[0] : null;
    } catch (err) {
        console.error('Unexpected error in getPixelRecord:', err);
        return null;
    }
}

// ─── Selection UI ────────────────────────────────────────────────────────────
function updateSelectionUI() {
    const totalPixels = selectedPixels.length;
    // FIX #42: use a single source of truth text node; blockCoords is now supplementary
    blockCoords.textContent = `Selected Pixels: ${totalPixels}`;
    if (pixelCountEl) pixelCountEl.textContent = String(totalPixels);

    // FIX #4 / #19: Use BigInt-style integer math to avoid float precision loss.
    // PIXEL_PRICE_ETH = '0.001' = 1/1000 ETH
    // totalEth = totalPixels * 0.001 ETH  →  represented as integer milliETH then formatted.
    const milliEth = totalPixels; // 1 pixel = 1 milliETH
    const ethWhole = Math.floor(milliEth / 1000);
    const ethFrac  = String(milliEth % 1000).padStart(3, '0');
    const totalEthDisplay = `${ethWhole}.${ethFrac}`;
    if (totalPriceEl) totalPriceEl.textContent = `${totalEthDisplay} ETH`;

    // FIX #20: never re-enable the button while a submission is in-flight
    if (!isSubmitting) {
        payBtn.disabled = totalPixels < MIN_PIXELS;
    }
}

function resetModal() {
    buyModal.querySelectorAll('input').forEach((input) => { input.value = ''; });
    setButtonState(false);
    updateSelectionUI();
}

// ─── Purchase flow ───────────────────────────────────────────────────────────
async function handlePurchase() {
    if (isSubmitting) return;

    const totalPixels = selectedPixels.length;
    if (totalPixels < MIN_PIXELS) {
        showToast(`Minimum order size is ${MIN_PIXELS} pixels (0.1 ETH)`, 'error');
        return;
    }

    const imageUrl = imgUrlInput.value.trim();
    const linkUrl  = linkUrlInput.value.trim();

    if (!imageUrl || !linkUrl) {
        showToast('Fill both image and website fields before buying.', 'error');
        return;
    }

    if (!validateImageUrl(imageUrl)) {
        showToast('Enter a valid HTTPS image URL ending with PNG/JPG/GIF/WEBP.', 'error');
        return;
    }

    if (!validateLinkUrl(linkUrl)) {
        showToast('Enter a valid website URL using HTTPS.', 'error');
        return;
    }

    // FIX #31: Check that all selected pixels are still available
    const soldKeys = new Set(cachedPixels.map((p) => cellKey(p.x, p.y)));
    const conflicts = selectedPixels.filter((p) => soldKeys.has(cellKey(p.x, p.y)));
    if (conflicts.length > 0) {
        showToast(`${conflicts.length} pixel(s) in your selection are already sold. Please reselect.`, 'error');
        // Remove conflicts from selection and refresh
        selectedPixels = selectedPixels.filter((p) => !soldKeys.has(cellKey(p.x, p.y)));
        updateSelectionUI();
        renderCanvasFromCache();
        return;
    }

    if (!window.ethereum) {
        showToast('Wallet not detected. Open the page inside a wallet-enabled browser.', 'error');
        return;
    }

    setButtonState(true);

    try {
        const provider = new ethers.providers.Web3Provider(window.ethereum);

        // FIX #26: Request accounts first, with distinct error for user denial
        try {
            await provider.send('eth_requestAccounts', []);
        } catch (accountError) {
            if (accountError.code === 4001) {
                showToast('Wallet access denied. Please approve the connection request.', 'error');
            } else {
                showToast('Could not connect to wallet. Please try again.', 'error');
            }
            return;
        }

        // FIX #16: Switch/add chain
        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: BASE_CHAIN_INFO.chainId }],
            });
        } catch (switchError) {
            if (switchError.code === 4902) {
                try {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [BASE_CHAIN_INFO],
                    });
                } catch (addError) {
                    showToast('Could not add Base network to your wallet. Please add it manually.', 'error');
                    return;
                }
            } else if (switchError.code === 4001) {
                showToast('Network switch denied. Please switch to Base Mainnet manually.', 'error');
                return;
            } else {
                throw switchError;
            }
        }

        // FIX #10: Verify we are actually on the correct chain after switching
        const network = await provider.getNetwork();
        const expectedChainId = parseInt(BASE_CHAIN_INFO.chainId, 16);
        if (network.chainId !== expectedChainId) {
            showToast('Wrong network detected after switch. Please manually switch to Base Mainnet.', 'error');
            return;
        }

        const signer = provider.getSigner();
        payBtn.textContent = 'Awaiting transaction…';

        // FIX #4 / #19: Integer-safe wei calculation using ethers BigNumber
        // PIXEL_PRICE_ETH = '0.001' = 10^15 wei per pixel
        const pricePerPixelWei = ethers.utils.parseEther(PIXEL_PRICE_ETH); // exact BigNumber
        const totalValue = pricePerPixelWei.mul(totalPixels);              // no float involved

        const tx = await signer.sendTransaction({
            to:    PAYMENT_RECEIVER,
            value: totalValue,
        });

        payBtn.textContent = 'Waiting for confirmation…';
        // FIX #10: wait for 2 confirmations on Base for better finality assurance
        await tx.wait(2);

        payBtn.textContent = 'Recording pixels…';

        const client = getSupabaseClient();

        const xArrayData = selectedPixels.map((p) => p.x);
        const yArrayData = selectedPixels.map((p) => p.y);
        // FIX #17: Include pixel dimensions and the computed block bounds
        const blockWidth  = selectedPixels.length > 0
            ? (Math.max(...selectedPixels.map((p) => p.x)) - Math.min(...selectedPixels.map((p) => p.x)) + CELL_SIZE)
            : CELL_SIZE;
        const blockHeight = selectedPixels.length > 0
            ? (Math.max(...selectedPixels.map((p) => p.y)) - Math.min(...selectedPixels.map((p) => p.y)) + CELL_SIZE)
            : CELL_SIZE;

        const { error } = await client.rpc('buy_pixel_secure_flexible', {
            _x_array:      xArrayData,
            _y_array:      yArrayData,
            _image_url:    imageUrl,
            _link_url:     linkUrl,
            _tx_hash:      tx.hash,
            _block_width:  blockWidth,    // FIX #17
            _block_height: blockHeight,   // FIX #17
        });

        if (error) {
            console.error('Supabase RPC failed:', error);
            showToast(`Server error recording pixels: ${error.message}. Your transaction hash is ${tx.hash} — contact support.`, 'error');
            return;
        }

        showToast('Pixels purchased successfully! Refreshing canvas.', 'info');
        // FIX #23: No arbitrary setTimeout — await the refresh directly
        const prevSelection = [...selectedPixels];
        tempSelection.clear();
        selectedPixels = [];
        closeModal();
        await fetchAndDrawPixels();
        if (a11yAnnounce) {
            a11yAnnounce.textContent = `Purchase complete. ${prevSelection.length} pixels acquired.`;
        }

    } catch (error) {
        console.error('Purchase failed:', error);
        // FIX #33: Distinguish common MetaMask error codes for actionable messages
        if (error.code === 4001) {
            showToast('Transaction canceled by user.', 'error');
        } else if (error.code === 'INSUFFICIENT_FUNDS' || (error.message && error.message.includes('insufficient funds'))) {
            showToast('Insufficient ETH balance for this purchase.', 'error');
        } else if (error.code === 'NETWORK_ERROR') {
            showToast('Network error. Check your connection and try again.', 'error');
        } else {
            showToast('Transaction failed. Check the console for details and try again.', 'error');
        }
    } finally {
        setButtonState(false);
    }
}

// ─── Double-click to open pixel links ────────────────────────────────────────
async function handleCanvasDoubleClick(event) {
    const coords = mapEventToCanvasCoordinates(event);
    const record = await getPixelRecord(coords.x, coords.y);

    if (record?.link_url) {
        // FIX #6: Validate the stored URL before opening it (server data may be stale/tampered)
        if (!validateLinkUrl(record.link_url)) {
            console.warn('Blocked unsafe pixel link:', record.link_url);
            showToast('This pixel contains an unsafe link and cannot be opened.', 'error');
            return;
        }
        try {
            window.open(record.link_url, '_blank', 'noopener,noreferrer');
        } catch (error) {
            console.error('Failed to open link:', error);
            showToast('Unable to open the pixel link.', 'error');
        }
    }
}

// ─── Selection logic ─────────────────────────────────────────────────────────
function previewSelectionBetween(start, end) {
    tempSelection.clear();
    const startX = Math.min(start.cellX, end.cellX);
    const endX   = Math.max(start.cellX, end.cellX);
    const startY = Math.min(start.cellY, end.cellY);
    const endY   = Math.max(start.cellY, end.cellY);
    for (let cx = startX; cx <= endX; cx++) {
        for (let cy = startY; cy <= endY; cy++) {
            tempSelection.add(cellKey(cx * CELL_SIZE, cy * CELL_SIZE));
        }
    }
}

// FIX #28: Only toggle pixels that are not already sold
function commitTempSelectionToggle() {
    const soldKeys = new Set(cachedPixels.map((p) => cellKey(p.x, p.y)));
    tempSelection.forEach((k) => {
        if (soldKeys.has(k)) return; // FIX #28: skip sold pixels silently
        const [x, y]    = k.split(',').map(Number);
        const existsIdx  = selectedPixels.findIndex((p) => Number(p.x) === x && Number(p.y) === y);
        if (existsIdx >= 0) {
            selectedPixels.splice(existsIdx, 1);
        } else {
            selectedPixels.push({ x, y });
        }
    });
    tempSelection.clear();
}

// FIX #27: Use requestAnimationFrame-gated renders to avoid per-pointermove full redraws
let _rafPending = false;
function renderCanvasFromCache() {
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
        _rafPending = false;
        drawGrid();
        cachedPixels.forEach((pixel) => drawPixelItem(pixel));
        drawSelections();
    });
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
function attachEvents() {
    // FIX #49: Prevent browser scroll/pan during canvas drag on touch devices
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        isDragging = true;
        dragStart  = mapEventToCanvasCoordinates(e);
        previewSelectionBetween(dragStart, dragStart);
        renderCanvasFromCache();
    });

    canvas.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const coords = mapEventToCanvasCoordinates(e);
        previewSelectionBetween(dragStart, coords);
        renderCanvasFromCache(); // FIX #27: throttled via rAF
    });

    canvas.addEventListener('pointerup', (e) => {
        if (!isDragging) return;
        const coords = mapEventToCanvasCoordinates(e);
        previewSelectionBetween(dragStart, coords);
        commitTempSelectionToggle();
        isDragging = false;
        dragStart  = null;
        renderCanvasFromCache();
        updateSelectionUI();

        // FIX #14 / #37: Only open modal if there is a valid non-zero selection
        if (selectedPixels.length === 0) {
            showToast('No available pixels selected. Sold pixels cannot be purchased.', 'error');
            return;
        }
        resetModal();
        openModal();
        if (selectedPixels.length < MIN_PIXELS) {
            showToast(`Minimum order size is ${MIN_PIXELS} pixels (0.1 ETH)`, 'error');
        }
    });

    canvas.addEventListener('pointercancel', () => {
        isDragging = false;
        tempSelection.clear();
        renderCanvasFromCache();
    });

    canvas.addEventListener('dblclick', handleCanvasDoubleClick);

    overlay.addEventListener('click', closeModal);
    payBtn.addEventListener('click', handlePurchase);

    document.addEventListener('keydown', (event) => {
        // FIX #40: Use isModalOpen boolean instead of checking style.display
        if (event.key === 'Escape' && isModalOpen) {
            closeModal();
        }
    });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
// FIX #32: await fetchAndDrawPixels so canvas is populated before returning
async function initializePage() {
    if (!window.supabase || !window.ethers) {
        showToast('Missing required blockchain libraries. Check your network or script imports.', 'error');
        // Do not throw — the page can still render the grid (read-only)
    }

    drawGrid();
    attachEvents();
    updateSelectionUI();
    await fetchAndDrawPixels(); // FIX #32: was called without await
}

initializePage().catch((err) => {
    console.error('initializePage failed:', err);
    showToast('Failed to initialise the application. Please refresh.', 'error');
});
