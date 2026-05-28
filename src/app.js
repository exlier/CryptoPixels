import { APP_CONFIG } from './config.js';

const {
    PIXEL_PRICE_ETH,
    GRID_SIZE,
    CELL_SIZE,
    PIXELS_TABLE,
    BASE_CHAIN_INFO,
    ALLOWED_LINK_PROTOCOLS,
    ALLOWED_IMAGE_EXTENSIONS,
} = APP_CONFIG;

const canvas = document.getElementById('gridCanvas');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const buyModal = document.getElementById('buyModal');
const blockCoords = document.getElementById('blockCoords');
const imgUrlInput = document.getElementById('imgUrl');
const linkUrlInput = document.getElementById('linkUrl');
const payBtn = document.getElementById('payBtn');
const toast = document.getElementById('toast');
const pixelCountEl = document.getElementById('pixelCount');
const totalPriceEl = document.getElementById('totalPrice');

let isSubmitting = false; // prevents double-submit and UI races
const imageCache = new Map();
let selectedPixels = []; // array of {x, y}
let tempSelection = new Set();
let isDragging = false;
let dragStart = null;
let cachedPixels = [];
let pendingRaf = null; // for throttling pointermove

function showToast(message, type = 'info') {
    toast.textContent = message;
    toast.className = `toast visible ${type === 'error' ? 'toast--error' : ''}`;
    window.clearTimeout(toast.timeoutId);
    toast.timeoutId = window.setTimeout(() => {
        toast.classList.remove('visible');
    }, 4200);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function mapEventToCanvasCoordinates(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = (event.touches ? event.touches[0].clientX : event.clientX) || event.clientX;
    const clientY = (event.touches ? event.touches[0].clientY : event.clientY) || event.clientY;
    const rawX = clientX - rect.left;
    const rawY = clientY - rect.top;
    const cellX = Math.floor(clamp(rawX * scaleX, 0, canvas.width - 1) / CELL_SIZE);
    const cellY = Math.floor(clamp(rawY * scaleY, 0, canvas.height - 1) / CELL_SIZE);
    return { x: cellX * CELL_SIZE, y: cellY * CELL_SIZE, cellX, cellY };
}

function cellKey(x, y) {
    return `${x},${y}`;
}

function validateUrl(value, allowedProtocols) {
    try {
        const url = new URL(value.trim());
        return allowedProtocols.includes(url.protocol);
    } catch {
        return false;
    }
}

function validateImageUrl(value) {
    const v = value.trim();
    if (v.startsWith('data:')) return v.startsWith('data:image/');
    if (!validateUrl(v, ['https:'])) return false;
    const parsed = new URL(v);
    const path = parsed.pathname.toLowerCase();
    return ALLOWED_IMAGE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function validateLinkUrl(value) {
    if (!validateUrl(value, ALLOWED_LINK_PROTOCOLS)) return false;
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
}

// Parse a decimal ETH string into wei (BigInt) without using floating-point arithmetic.
function parseEtherToWei(ethStr) {
    const s = String(ethStr).trim();
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) throw new Error('Invalid ETH amount');
    const [whole, frac = ''] = s.split('.');
    const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
    const combined = whole + fracPadded;
    return BigInt(combined);
}

// Format wei (BigInt) to a short ETH string for UI (up to 6 fractional digits).
function formatWeiToEth(wei) {
    const WEI = 10n ** 18n;
    const whole = wei / WEI;
    const frac = wei % WEI;
    if (frac === 0n) return whole.toString();
    const fracFull = frac.toString().padStart(18, '0');
    const frac6 = fracFull.slice(0, 6).replace(/0+$/, '');
    return frac6 ? `${whole.toString()}.${frac6}` : whole.toString();
}

function openModal() {
    overlay.style.display = 'block';
    buyModal.style.display = 'block';
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    overlay.style.display = 'none';
    buyModal.style.display = 'none';
    document.body.style.overflow = '';
}

function setButtonState(isBusy) {
    isSubmitting = isBusy;
    payBtn.disabled = isBusy;
    payBtn.innerText = isBusy ? 'Processing…' : 'Pay with Crypto Wallet';
}

function drawGrid() {
    ctx.clearRect(0, 0, GRID_SIZE, GRID_SIZE);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, GRID_SIZE, GRID_SIZE);

    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    for (let x = 0; x <= GRID_SIZE; x += CELL_SIZE) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, GRID_SIZE);
        ctx.stroke();
    }
    for (let y = 0; y <= GRID_SIZE; y += CELL_SIZE) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(GRID_SIZE, y);
        ctx.stroke();
    }
}

function drawPixelPlaceholder(x, y, width = CELL_SIZE, height = CELL_SIZE) {
    ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
    ctx.fillRect(x + 1, y + 1, width - 2, height - 2);
    ctx.strokeStyle = '#475569';
    ctx.strokeRect(x + 1, y + 1, width - 2, height - 2);
}

function loadRemoteImage(src) {
    return new Promise((resolve, reject) => {
        try {
            const image = new Image();
            // Only allow data: or same-origin images to avoid canvas tainting and SSRF/exfil
            const url = new URL(src, window.location.href);
            if (src.startsWith('data:') || url.origin === window.location.origin) {
                image.crossOrigin = 'anonymous';
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error('Image load failed'));
                image.src = src;
            } else {
                reject(new Error('External images are not allowed to draw to canvas'));
            }
        } catch (e) {
            reject(e);
        }
    });
}

function drawPixelItem(pixel) {
    const x = Number(pixel.x);
    const y = Number(pixel.y);
    const width = Number(pixel.width) || CELL_SIZE;
    const height = Number(pixel.height) || CELL_SIZE;

    if (!pixel.image_url) {
        drawPixelPlaceholder(x, y, width, height);
        return;
    }
    try {
        if (imageCache.has(pixel.image_url)) {
            ctx.drawImage(imageCache.get(pixel.image_url), x, y, width, height);
            return;
        }

        loadRemoteImage(pixel.image_url)
            .then((image) => {
                imageCache.set(pixel.image_url, image);
                ctx.drawImage(image, x, y, width, height);
            })
            .catch((error) => {
                console.warn('Failed to load pixel image:', pixel.image_url, error);
                drawPixelPlaceholder(x, y, width, height);
            });
    } catch (err) {
        drawPixelPlaceholder(x, y, width, height);
    }
}

function drawSelections() {
    // preview (temp) first
    ctx.save();
    tempSelection.forEach((k) => {
        const [x, y] = k.split(',').map(Number);
        ctx.fillStyle = 'rgba(56,189,248,0.25)';
        ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
    });

    // confirmed selections
    selectedPixels.forEach((p) => {
        const x = Number(p.x);
        const y = Number(p.y);
        ctx.fillStyle = 'rgba(56,189,248,0.4)';
        ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        ctx.strokeStyle = 'rgba(2,6,23,0.6)';
        ctx.strokeRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
    });
    ctx.restore();
}

async function fetchAndDrawPixels() {
    drawGrid();
    try {
        const res = await fetch('/api/pixels');
        if (!res.ok) {
            // Network error: silently fallback to empty canvas with grid
            console.warn('Failed to load pixels; drawing default grid.');
            cachedPixels = [];
            drawSelections();
            return;
        }
        const pixels = await res.json();
        if (!pixels || !Array.isArray(pixels)) {
            console.warn('Pixels response is null or not an array; using empty cache.');
            cachedPixels = [];
            drawSelections();
            return;
        }
        cachedPixels = pixels;
        cachedPixels.forEach((pixel) => {
            try {
                drawPixelItem(pixel);
            } catch (pixelErr) {
                console.warn('Error drawing individual pixel:', pixel, pixelErr);
                // Continue to next pixel instead of failing entirely
            }
        });
        drawSelections();
    } catch (err) {
        // Network or parsing error: do not show toast, just continue with empty grid
        console.error('Failed to fetch/parse pixels:', err);
        cachedPixels = [];
        drawSelections();
    }
}

async function getPixelRecord(x, y) {
    try {
        const res = await fetch(`/api/pixel?x=${encodeURIComponent(x)}&y=${encodeURIComponent(y)}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.error('Error loading pixel record:', err);
        showToast('Error checking the selected block. Try again later.', 'error');
        return null;
    }
}

function updateSelectionUI() {
    const totalPixels = selectedPixels.length;
    blockCoords.innerText = `Selected Pixels: ${totalPixels}`;
    if (pixelCountEl) pixelCountEl.innerText = String(totalPixels);
    // Use integer-safe arithmetic for ETH pricing
    try {
        const pricePerPixelWei = parseEtherToWei(PIXEL_PRICE_ETH);
        const totalWei = pricePerPixelWei * BigInt(totalPixels || 0);
        const display = formatWeiToEth(totalWei);
        if (totalPriceEl) totalPriceEl.innerText = `${display} ETH`;
    } catch (e) {
        if (totalPriceEl) totalPriceEl.innerText = '0 ETH';
    }

    // Respect submission state to avoid race/double-submit
    if (isSubmitting) {
        payBtn.disabled = true;
        return;
    }

    payBtn.disabled = totalPixels < 100;
}

function resetModal() {
    buyModal.querySelectorAll('input').forEach((input) => {
        input.value = '';
    });
    setButtonState(false);
    updateSelectionUI();
}

async function handlePurchase() {
    if (isSubmitting) return;

    const totalPixels = selectedPixels.length;
    if (totalPixels < 100) {
        showToast('Minimum order size is 100 pixels (0.1 ETH)', 'error');
        return;
    }

    const imageUrl = imgUrlInput.value.trim();
    const linkUrl = linkUrlInput.value.trim();

    if (!imageUrl || !linkUrl) {
        showToast('Fill both image and website fields before buying.', 'error');
        return;
    }

    if (!validateImageUrl(imageUrl)) {
        showToast('Enter a valid image (data: or HTTPS) with allowed extension.', 'error');
        return;
    }

    if (!validateLinkUrl(linkUrl)) {
        showToast('Enter a valid website URL using HTTPS or HTTP.', 'error');
        return;
    }

    if (!window.ethereum) {
        showToast('Wallet not detected. Open the page inside a wallet-enabled browser.', 'error');
        return;
    }

    setButtonState(true);
    isSubmitting = true;

    try {
        // 1) ask server to checkout/reserve pixels and return price + payment receiver
        const checkoutResp = await fetch('/api/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedPixels, imageUrl, linkUrl }),
        });

        if (!checkoutResp.ok) {
            const err = await checkoutResp.json().catch(() => ({}));
            throw new Error(err?.error || 'Checkout failed or pixels are unavailable');
        }

        const { priceWei, paymentReceiver, reserveToken } = await checkoutResp.json();

        // 2) request accounts and switch chain if necessary
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const from = accounts[0];

        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: BASE_CHAIN_INFO.chainId }],
            });
        } catch (switchError) {
            if (switchError && switchError.code === 4902) {
                await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [BASE_CHAIN_INFO] });
            }
        }

        payBtn.innerText = 'Awaiting transaction...';

        const valueHex = '0x' + BigInt(priceWei).toString(16);

        // send transaction via the user's wallet
        const txHash = await window.ethereum.request({
            method: 'eth_sendTransaction',
            params: [{ from, to: paymentReceiver, value: valueHex }],
        });

        payBtn.innerText = 'Waiting for confirmation and server verification...';

        // 3) let the server verify the transaction and finalize the claim
        const verifyResp = await fetch('/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txHash, reserveToken }),
        });

        if (!verifyResp.ok) {
            const err = await verifyResp.json().catch(() => ({}));
            throw new Error(err?.error || 'Verification failed');
        }

        showToast('Pixels purchased successfully! Refreshing canvas.', 'info');
        setTimeout(() => {
            tempSelection.clear();
            closeModal();
            selectedPixels = [];
            fetchAndDrawPixels();
        }, 800);
    } catch (error) {
        console.error('Purchase failed:', error);
        showToast(error.message || 'Transaction failed or canceled. Try again if needed.', 'error');
    } finally {
        setButtonState(false);
        isSubmitting = false;
    }
}

async function handleCanvasDoubleClick(event) {
    const coords = mapEventToCanvasCoordinates(event);
    const record = await getPixelRecord(coords.x, coords.y);

    if (record?.link_url) {
        try {
            window.open(record.link_url, '_blank', 'noopener,noreferrer');
        } catch (error) {
            console.error('Failed to open link:', error);
            showToast('Unable to open the pixel link.', 'error');
        }
    }
}

function previewSelectionBetween(start, end) {
    tempSelection.clear();
    const startX = Math.min(start.cellX, end.cellX);
    const endX = Math.max(start.cellX, end.cellX);
    const startY = Math.min(start.cellY, end.cellY);
    const endY = Math.max(start.cellY, end.cellY);
    for (let cx = startX; cx <= endX; cx++) {
        for (let cy = startY; cy <= endY; cy++) {
            tempSelection.add(cellKey(cx * CELL_SIZE, cy * CELL_SIZE));
        }
    }
}

function commitTempSelectionToggle() {
    tempSelection.forEach((k) => {
        const [x, y] = k.split(',').map(Number);
        const existsIdx = selectedPixels.findIndex((p) => Number(p.x) === x && Number(p.y) === y);
        if (existsIdx >= 0) {
            selectedPixels.splice(existsIdx, 1);
        } else {
            selectedPixels.push({ x, y });
        }
    });
    tempSelection.clear();
}

function renderCanvasFromCache() {
    drawGrid();
    cachedPixels.forEach((pixel) => drawPixelItem(pixel));
    drawSelections();
}

function attachEvents() {
    // pointer events for drag selection
    canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        isDragging = true;
        dragStart = mapEventToCanvasCoordinates(e);
        previewSelectionBetween(dragStart, dragStart);
        renderCanvasFromCache();
    });

    canvas.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        // throttle pointermove with requestAnimationFrame
        const coords = mapEventToCanvasCoordinates(e);
        previewSelectionBetween(dragStart, coords);
        if (pendingRaf) return;
        pendingRaf = requestAnimationFrame(() => {
            renderCanvasFromCache();
            pendingRaf = null;
        });
    });

    canvas.addEventListener('pointerup', (e) => {
        if (!isDragging) return;
        const coords = mapEventToCanvasCoordinates(e);
        previewSelectionBetween(dragStart, coords);
        commitTempSelectionToggle();
        isDragging = false;
        dragStart = null;
        renderCanvasFromCache();
        updateSelectionUI();
        // open modal on selection change
        resetModal();
        openModal();
        if (selectedPixels.length < 100) {
            showToast('Minimum order size is 100 pixels (0.1 ETH)', 'error');
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
        if (event.key === 'Escape' && buyModal.style.display === 'block') {
            closeModal();
        }
    });
}

function initializePage() {
    // 1. Attach event listeners FIRST so canvas is interactive immediately
    attachEvents();
    
    // 2. Draw initial grid
    drawGrid();
    
    // 3. Fetch and draw pixels asynchronously (non-blocking)
    //    Any network errors are handled gracefully inside fetchAndDrawPixels
    fetchAndDrawPixels();
    
    // 4. Update UI state
    updateSelectionUI();
}

initializePage();
