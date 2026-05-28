export const APP_CONFIG = {
    SUPABASE_URL: 'https://kvtdelsdifkerfepvkvn.supabase.co',
    // Supabase anon key must NOT be committed. Server should hold service role key.
    SUPABASE_ANON_KEY: null,
    // Do not store payment receiver or other secrets client-side. Server provides this at checkout.
    PAYMENT_RECEIVER: null,
    PIXEL_PRICE_ETH: '0.001',
    GRID_SIZE: 1000,
    CELL_SIZE: 10,
    PIXELS_TABLE: 'pixels',
    BASE_CHAIN_ID: '0x2105',
    BASE_CHAIN_INFO: {
        chainId: '0x2105',
        chainName: 'Base Mainnet',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        // Correct RPC URL for Base mainnet
        rpcUrls: ['https://mainnet.base.org'],
        blockExplorerUrls: ['https://basescan.org'],
    },
    ALLOWED_LINK_PROTOCOLS: ['https:', 'http:'],
    ALLOWED_IMAGE_EXTENSIONS: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
};
