const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const dns = require('dns').promises;
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PAYMENT_RECEIVER,
  BASE_RPC_URL = 'https://mainnet.base.org',
  PIXEL_PRICE_ETH = '0.001',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set as environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const provider = new ethers.providers.JsonRpcProvider(BASE_RPC_URL);

function parseEtherToWei(ethStr) {
  const s = String(ethStr).trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) throw new Error('Invalid ETH amount');
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole + fracPadded);
}

function isPrivateIpv4(ip) {
  if (!ip) return false;
  if (ip.startsWith('10.') || ip.startsWith('127.') || ip.startsWith('169.254.') || ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

function isPrivateIp(ip) {
  if (!ip) return false;
  if (ip.includes(':')) {
    // basic IPv6 checks
    if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fe80')) return true;
    return false;
  }
  return isPrivateIpv4(ip);
}

app.get('/api/pixels', async (req, res) => {
  try {
    const { data, error } = await supabase.from('pixels').select('*');
    if (error) return res.status(500).json({ error: 'DB error' });
    return res.json(data || []);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/pixel', async (req, res) => {
  const { x, y } = req.query;
  if (x == null || y == null) return res.status(400).json({ error: 'Missing x or y' });
  try {
    const { data, error } = await supabase.from('pixels').select('*').eq('x', Number(x)).eq('y', Number(y)).maybeSingle();
    if (error) return res.status(500).json({ error: 'DB error' });
    return res.json(data || null);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/checkout', async (req, res) => {
  try {
    const { selectedPixels, imageUrl, linkUrl } = req.body || {};
    if (!Array.isArray(selectedPixels) || selectedPixels.length < 100) {
      return res.status(400).json({ error: 'Minimum order size is 100 pixels' });
    }

    if (!imageUrl || !linkUrl) return res.status(400).json({ error: 'Missing image or link' });

    // basic link validation
    try {
      const parsed = new URL(linkUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Invalid link protocol' });
    } catch (e) {
      return res.status(400).json({ error: 'Invalid link URL' });
    }

    // image validation: allow data: or fetch HEAD with safety checks
    if (!imageUrl.startsWith('data:')) {
      let parsed;
      try {
        parsed = new URL(imageUrl);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid image URL' });
      }

      const path = parsed.pathname.toLowerCase();
      const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
      if (!allowed.some((ext) => path.endsWith(ext))) return res.status(400).json({ error: 'Disallowed image extension' });

      // DNS resolution to avoid private addresses
      try {
        const addrs = await dns.lookup(parsed.hostname, { all: true });
        if (addrs.some((a) => isPrivateIp(a.address))) return res.status(400).json({ error: 'Image host resolves to private IP' });
      } catch (e) {
        return res.status(400).json({ error: 'Unable to resolve image host' });
      }

      // HEAD request to check content-type and content-length
      try {
        const head = await fetch(imageUrl, { method: 'HEAD', redirect: 'follow', timeout: 5000 });
        if (!head.ok) return res.status(400).json({ error: 'Image not fetchable' });
        const ct = head.headers.get('content-type') || '';
        if (!ct.startsWith('image/')) return res.status(400).json({ error: 'Image URL does not point to an image' });
        const len = head.headers.get('content-length');
        if (len && Number(len) > 2 * 1024 * 1024) return res.status(400).json({ error: 'Image too large' });
      } catch (e) {
        return res.status(400).json({ error: 'Unable to fetch image metadata' });
      }
    }

    // compute price
    const pricePerPixelWei = parseEtherToWei(PIXEL_PRICE_ETH || '0.001');
    const totalWei = pricePerPixelWei * BigInt(selectedPixels.length);

    // try to reserve by inserting rows with a reserved tx_hash token (relies on unique constraint on x,y)
    const reserveToken = crypto.randomBytes(16).toString('hex');
    const rows = selectedPixels.map((p) => ({ x: Number(p.x), y: Number(p.y), image_url: imageUrl, link_url: linkUrl, tx_hash: `RESERVED:${reserveToken}` }));

    const { error } = await supabase.from('pixels').insert(rows);
    if (error) {
      console.error('Reserve failed:', error);
      return res.status(409).json({ error: 'Some pixels are already taken' });
    }

    return res.json({ priceWei: totalWei.toString(), paymentReceiver: PAYMENT_RECEIVER, reserveToken });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/verify', async (req, res) => {
  try {
    const { txHash, reserveToken } = req.body || {};
    if (!txHash || !reserveToken) return res.status(400).json({ error: 'Missing txHash or reserveToken' });

    // find reserved rows
    const { data: reservedRows, error: selErr } = await supabase.from('pixels').select('x,y').eq('tx_hash', `RESERVED:${reserveToken}`);
    if (selErr) return res.status(500).json({ error: 'DB error' });
    if (!reservedRows || reservedRows.length === 0) return res.status(404).json({ error: 'No reservation found' });

    // fetch tx and receipt
    const tx = await provider.getTransaction(txHash);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!tx || !receipt) return res.status(400).json({ error: 'Transaction not found or not mined yet' });
    if (receipt.status !== 1) return res.status(400).json({ error: 'Transaction failed' });

    // compute expected amount
    const pricePerPixelWei = parseEtherToWei(PIXEL_PRICE_ETH || '0.001');
    const expected = pricePerPixelWei * BigInt(reservedRows.length);

    // tx.value might be a BigNumber; convert to string then BigInt
    const txValue = BigInt(tx.value.toString());
    if (txValue !== expected) return res.status(400).json({ error: 'Incorrect payment amount' });

    if (!PAYMENT_RECEIVER) return res.status(500).json({ error: 'Server not configured with PAYMENT_RECEIVER' });
    if (!tx.to || tx.to.toLowerCase() !== PAYMENT_RECEIVER.toLowerCase()) return res.status(400).json({ error: 'Payment receiver mismatch' });

    // finalize: update reserved rows to the real tx hash
    const { error: updErr } = await supabase.from('pixels').update({ tx_hash: txHash }).eq('tx_hash', `RESERVED:${reserveToken}`);
    if (updErr) {
      console.error('Update failed:', updErr);
      return res.status(500).json({ error: 'Finalizing claim failed' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
