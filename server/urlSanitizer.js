const dns = require('dns').promises;

/**
 * Check if an IP address is in the private IP ranges
 * @param {string} ip - IP address to check
 * @returns {boolean} - true if IP is private/restricted
 */
function isPrivateIp(ip) {
  if (!ip) return true;

  // IPv6 loopback and private
  if (ip.includes(':')) {
    if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fe80:')) return true;
    // IPv6 loopback
    if (ip === '::1') return true;
    // IPv6 private (fc00::/7)
    if (ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')) return true;
    // IPv6 link-local (fe80::/10)
    if (ip.toLowerCase().startsWith('fe80:')) return true;
    return false;
  }

  // IPv4 loopback (127.0.0.0/8)
  if (ip.startsWith('127.')) return true;

  // IPv4 private (10.0.0.0/8)
  if (ip.startsWith('10.')) return true;

  // IPv4 private (172.16.0.0/12)
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1]);
    if (second >= 16 && second <= 31) return true;
  }

  // IPv4 private (192.168.0.0/16)
  if (ip.startsWith('192.168.')) return true;

  // Link-local (169.254.0.0/16)
  if (ip.startsWith('169.254.')) return true;

  // AWS metadata endpoint
  if (ip === '169.254.169.254') return true;

  // This host (0.0.0.0)
  if (ip === '0.0.0.0') return true;

  // Broadcast
  if (ip === '255.255.255.255') return true;

  return false;
}

/**
 * Validate an image URL for SSRF attacks
 * @param {string} url - URL to validate
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
async function validateImageUrl(url) {
  // Validate input
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'Invalid URL' };
  }

  // Reject data: URIs
  if (url.startsWith('data:')) {
    return { valid: false, error: 'Data URIs not allowed for images' };
  }

  // Parse and validate URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { valid: false, error: 'Invalid image URL format' };
  }

  // Only allow http and https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, error: 'Only http and https protocols allowed' };
  }

  // Validate hostname is not empty
  if (!parsed.hostname) {
    return { valid: false, error: 'Invalid hostname' };
  }

  // Reject localhost-like domains
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === 'localhost.' || hostname === '127.0.0.1' || hostname === '[::1]') {
    return { valid: false, error: 'Localhost URLs not allowed' };
  }

  // Check for private IP ranges in the hostname itself
  if (isPrivateIp(hostname)) {
    return { valid: false, error: 'Private IP addresses not allowed' };
  }

  // Resolve hostname to IP and check if it's private
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        return { valid: false, error: 'Hostname resolves to private IP' };
      }
    }
  } catch (e) {
    return { valid: false, error: 'Unable to resolve hostname' };
  }

  // Validate file extension
  const pathname = parsed.pathname.toLowerCase();
  const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
  if (!allowedExtensions.some((ext) => pathname.endsWith(ext))) {
    return { valid: false, error: 'Image file extension not allowed (allowed: png, jpg, jpeg, gif, webp, svg)' };
  }

  return { valid: true };
}

/**
 * Validate a link URL for XSS and other attacks
 * @param {string} url - URL to validate
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
async function validateLinkUrl(url) {
  // Validate input
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'Invalid URL' };
  }

  // List of dangerous protocols
  const dangerousProtocols = [
    'javascript:',
    'data:',
    'vbscript:',
    'file:',
    'about:',
    'blob:',
  ];

  // Check for dangerous protocols
  const lowerUrl = url.toLowerCase().trim();
  for (const protocol of dangerousProtocols) {
    if (lowerUrl.startsWith(protocol)) {
      return { valid: false, error: `${protocol} protocol not allowed` };
    }
  }

  // Check for protocol-relative URLs (//example.com)
  if (lowerUrl.startsWith('//')) {
    return { valid: false, error: 'Protocol-relative URLs not allowed' };
  }

  // Parse and validate URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { valid: false, error: 'Invalid link URL format' };
  }

  // Only allow http and https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, error: 'Only http and https protocols allowed for links' };
  }

  // Validate hostname is not empty
  if (!parsed.hostname) {
    return { valid: false, error: 'Invalid hostname' };
  }

  // Basic check for common XSS patterns in search params
  const params = new URLSearchParams(parsed.search);
  for (const [key, value] of params) {
    // Check for script tags or event handlers in URL parameters
    if (
      value.toLowerCase().includes('<script') ||
      value.toLowerCase().includes('onerror=') ||
      value.toLowerCase().includes('onload=') ||
      value.toLowerCase().includes('onclick=') ||
      value.toLowerCase().includes('javascript:')
    ) {
      return { valid: false, error: 'Suspicious content detected in URL parameters' };
    }
  }

  return { valid: true };
}

/**
 * Sanitize a URL to remove potentially dangerous characters
 * @param {string} url - URL to sanitize
 * @returns {string} - Sanitized URL
 */
function sanitizeUrl(url) {
  if (!url) return '';
  
  try {
    const parsed = new URL(url);
    // Reconstruct URL to normalize it
    return parsed.toString();
  } catch (e) {
    return '';
  }
}

module.exports = {
  validateImageUrl,
  validateLinkUrl,
  sanitizeUrl,
  isPrivateIp,
};
