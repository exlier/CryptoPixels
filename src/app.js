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

let isSubmitting = false;
const imageCache = new Map();
let selectedSet = new Set();
let tempSelection = new Set();
let isDragging = false;
let dragStart = null;
let cachedPixels = [];

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
    if (!validateUrl(value, ['https:'])) return false;
    const parsed = new URL(value.trim());
    const path = parsed.pathname.toLowerCase();
    return ALLOWED_IMAGE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function validateLinkUrl(value) {
    if (!validateUrl(value, ALLOWED_LINK_PROTOCOLS)) return false;
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
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
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Image load failed'));
        image.src = src;
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
    selectedSet.forEach((k) => {
        const [x, y] = k.split(',').map(Number);
        ctx.fillStyle = 'rgba(56,189,248,0.4)';
        ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        ctx.strokeStyle = 'rgba(2,6,23,0.6)';
        ctx.strokeRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
    });
    ctx.restore();
}

async function fetchAndDrawPixels() {
    drawGrid();

    if (!window.supabase) {
        showToast('Supabase client not loaded. Check your script tags.', 'error');
        return;
    }

    const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: pixels, error } = await supabaseClient.from(PIXELS_TABLE).select('*');

    if (error) {
        console.error('Failed to fetch pixels:', error);
        showToast('Unable to load pixel map. Please refresh the page.', 'error');
        return;
    }

    cachedPixels = pixels || [];
    cachedPixels.forEach((pixel) => drawPixelItem(pixel));
    drawSelections();
}

async function getPixelRecord(x, y) {
    const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabaseClient
        .from(PIXELS_TABLE)
        .select('link_url')
        .eq('x', x)
        .eq('y', y)
        .single();

    if (error && error.code !== 'PGRST116') {
        console.error('Error loading pixel record:', error);
        showToast('Error checking the selected block. Try again later.', 'error');
        return null;
    }

    return data;
}

function updateSelectionUI() {
    const totalPixels = selectedSet.size;
    blockCoords.innerText = `Selected Pixels: ${totalPixels}`;
    if (pixelCountEl) pixelCountEl.innerText = String(totalPixels);
    const totalEth = (totalPixels * Number(PIXEL_PRICE_ETH)).toFixed(6).replace(/\.0+$/, '.0');
    if (totalPriceEl) totalPriceEl.innerText = `${totalEth} ETH`;

    if (totalPixels < 100) {
        payBtn.disabled = true;
    } else {
        payBtn.disabled = false;
    }
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

    const totalPixels = selectedSet.size;
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
        showToast('Enter a valid HTTPS image URL ending with PNG/JPG/GIF/SVG/WEBP.', 'error');
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

    try {
        const provider = new ethers.providers.Web3Provider(window.ethereum);
        await provider.send('eth_requestAccounts', []);
        const signer = provider.getSigner();

        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: BASE_CHAIN_INFO.chainId }],
            });
        } catch (switchError) {
            if (switchError.code === 4902) {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [BASE_CHAIN_INFO],
                });
            } else {
                throw switchError;
            }
        }

        payBtn.innerText = 'Awaiting transaction...';

        // Calculate total value in wei using BigNumber multiply
        const perPixelWei = ethers.utils.parseEther(PIXEL_PRICE_ETH);
        const totalValue = perPixelWei.mul(totalPixels);

        const tx = await signer.sendTransaction({
            to: PAYMENT_RECEIVER,
            value: totalValue,
        });

        payBtn.innerText = 'Waiting for confirmation...';
        await tx.wait();

        const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        // Loop RPC insertion for each pixel coordinate
        const insertPromises = [];
        selectedSet.forEach((k) => {
            const [x, y] = k.split(',').map(Number);
            insertPromises.push(
                supabaseClient.rpc('buy_pixel_secure', {
                    _x: x,
                    _y: y,
                    _width: CELL_SIZE,
                    _height: CELL_SIZE,
                    _image_url: imageUrl,
                    _link_url: linkUrl,
                    _tx_hash: tx.hash,
                })
            );
        });

        const insertResults = await Promise.all(insertPromises);
        const rpcError = insertResults.find((r) => r.error);
        if (rpcError) {
            console.error('Supabase RPC failed:', rpcError);
            showToast('Purchase saved locally, but failed to finalize on the server.', 'error');
            return;
        }

        showToast('Pixels purchased successfully! Refreshing canvas.', 'info');
        setTimeout(() => {
            closeModal();
            selectedSet.clear();
            fetchAndDrawPixels();
        }, 800);
    } catch (error) {
        console.error('Purchase failed:', error);
        showToast('Transaction failed or canceled. Try again if needed.', 'error');
    } finally {
        setButtonState(false);
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
        if (selectedSet.has(k)) selectedSet.delete(k);
        else selectedSet.add(k);
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
        const coords = mapEventToCanvasCoordinates(e);
        previewSelectionBetween(dragStart, coords);
        renderCanvasFromCache();
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
        if (selectedSet.size < 100) {
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
    if (!window.supabase || !window.ethers) {
        showToast('Missing required blockchain libraries. Check your network or script imports.', 'error');
    }

    drawGrid();
    attachEvents();
    fetchAndDrawPixels();
    updateSelectionUI();
}

initializePage();
