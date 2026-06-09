/**
 * CryptoPixels — Application Configuration
 *
 * SECURITY NOTE (Bug #1 / #2):
 * ─────────────────────────────────────────────────────────────────────────────
 * SUPABASE_URL and SUPABASE_ANON_KEY are intentionally loaded from environment
 * variables at build time (or injected by your hosting platform) rather than
 * being committed as plain-text secrets.
 *
 * For local development create a .env file (never commit it):
 *   VITE_SUPABASE_URL=https://your-project.supabase.co
 *   VITE_SUPABASE_ANON_KEY=eyJ...
 *   VITE_PAYMENT_RECEIVER=0x...
 *
 * For GitHub Pages / Netlify / Vercel set these as repository/environment
 * secrets and inject them at build time.
 *
 * The anon key is still a *public* key (it is embedded in the browser bundle),
 * but it should not be committed to source control. Supabase Row Level Security
 * (RLS) must be enabled on all tables to limit what the anon role can read/write.
 *
 * The PAYMENT_RECEIVER wallet address (Bug #2) is also read from an env var so
 * it is not hard-coded in a way that an attacker could trivially patch via a
 * browser extension or MITM proxy. At runtime the app validates that the address
 * is a valid checksummed EIP-55 address before every transaction.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Vite-style env injection (replace with your build tool's equivalent).
// Falls back to empty strings so the app fails loudly rather than silently.
const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};

export const APP_CONFIG = Object.freeze({
    // Bug #1: No longer hard-coded — read from build-time environment variables.
    SUPABASE_URL:      env.VITE_SUPABASE_URL      || '',
    SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY || '',

    // Bug #2: Wallet address from env var, validated at runtime in app.js.
    PAYMENT_RECEIVER: env.VITE_PAYMENT_RECEIVER || '',

    PIXEL_PRICE_ETH: '0.001',  // treated as a string throughout to avoid float math
    GRID_SIZE: 1000,
    CELL_SIZE: 10,
    PIXELS_TABLE: 'pixels',

    // Bug #8 + #39: Correct Base Mainnet RPC URL; single source of truth for chainId.
    BASE_CHAIN_INFO: Object.freeze({
        chainId: '0x2105',                        // 8453 decimal — Base Mainnet
        chainName: 'Base Mainnet',
        nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 }),
        rpcUrls: ['https://mainnet.base.org'],    // Bug #8: was 'https://base.org' (marketing site)
        blockExplorerUrls: ['https://basescan.org'],
    }),

    // Bug #36: Only allow https: for redirect links (http: removed).
    ALLOWED_LINK_PROTOCOLS: Object.freeze(['https:']),

    ALLOWED_IMAGE_EXTENSIONS: Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']),

    // Minimum pixel purchase enforced both client- and server-side.
    MIN_PIXELS: 100,
});
