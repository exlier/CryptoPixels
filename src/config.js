export const APP_CONFIG = {
    SUPABASE_URL: null,
    SUPABASE_ANON_KEY: null,
    PAYMENT_RECEIVER: null,
    PIXEL_PRICE_ETH: '0.0001',
    GRID_SIZE: 1000,
    CELL_SIZE: 10,
    PIXELS_TABLE: 'pixels',
    BASE_CHAIN_ID: '0x2105',
    BASE_CHAIN_INFO: {
        chainId: '0x2105',
        chainName: 'Base Mainnet',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://mainnet.base.org'],
        blockExplorerUrls: ['https://basescan.org'],
    },
    ALLOWED_LINK_PROTOCOLS: ['https:', 'http:'],
    ALLOWED_IMAGE_EXTENSIONS: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
};
