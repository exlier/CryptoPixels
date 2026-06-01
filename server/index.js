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
  PRICE_PER_PIXEL_ETH = '0.0001',
  RESERVATION_TTL_MINUTES = '15',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !PAYMENT_RECEIVER) {
  console.error('SUPABASE_URL, SUPABASE_SERVICE_KEY, and PAYMENT_RECEIVER must be set as environment variables');
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
    if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fe80')) return true;
    return false;
  }
  return isPrivateIpv4(ip);
}

async function releaseExpiredReservation(reservationToken) {
  const { error: deleteErr } = await supabase
    .from('pixels')
    .delete()
    .eq('reservation_token', reservationToken)
    .eq('tx_hash', `RESERVED:${reservationToken}`);

  if (deleteErr) {
    console.error(`Failed to release expired reservation rows for ${reservationToken}:`, deleteErr);
  }

  const { error: updateErr } = await supabase
    .from('pixels_reservations')
    .update({ status: 'expired' })
    .eq('reservation_token', reservationToken);

  if (updateErr) {
    console.error(`Failed to mark reservation ${reservationToken} expired:`, updateErr);
  }
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

    try {
      const parsed = new URL(linkUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Invalid link protocol' });
    } catch (e) {
      return res.status(400).json({ error: 'Invalid link URL' });
    }

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

      try {
        const addrs = await dns.lookup(parsed.hostname, { all: true });
        if (addrs.some((a) => isPrivateIp(a.address))) return res.status(400).json({ error: 'Image host resolves to private IP' });
      } catch (e) {
        return res.status(400).json({ error: 'Unable to resolve image host' });
      }

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

    const pricePerPixelWei = parseEtherToWei(PRICE_PER_PIXEL_ETH);
    const totalWei = pricePerPixelWei * BigInt(selectedPixels.length);
    const expectedTotalWei = totalWei.toString();
    const reservationToken = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + Number(RESERVATION_TTL_MINUTES) * 60 * 1000).toISOString();

    const { error: reserveErr } = await supabase.from('pixels_reservations').insert([
      {
        reservation_token: reservationToken,
        pixel_count: selectedPixels.length,
        expected_total_wei: expectedTotalWei,
        expires_at: expiresAt,
      },
    ]);

    if (reserveErr) {
      console.error('Reservation creation failed:', reserveErr);
      return res.status(500).json({ error: 'Unable to create reservation' });
    }

    const rows = selectedPixels.map((p) => ({
      x: Number(p.x),
      y: Number(p.y),
      image_url: imageUrl,
      link_url: linkUrl,
      tx_hash: `RESERVED:${reservationToken}`,
      reservation_token: reservationToken,
    }));

    const { error: insertErr } = await supabase.from('pixels').insert(rows);
    if (insertErr) {
      console.error('Reserve failed:', insertErr);
      await supabase.from('pixels_reservations').delete().eq('reservation_token', reservationToken);
      return res.status(409).json({ error: 'Some pixels are already taken' });
    }

    return res.json({ expectedTotalWei, priceWei: totalWei.toString(), paymentReceiver: PAYMENT_RECEIVER, reservationToken, reserveToken: reservationToken });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/verify', async (req, res) => {
  try {
    const { txHash } = req.body || {};
    const reservationToken = req.body?.reservationToken || req.body?.reserveToken;
    if (!txHash || !reservationToken) return res.status(400).json({ error: 'Missing txHash or reservation token' });

    const { data: reservation, error: reservationErr } = await supabase
      .from('pixels_reservations')
      .select('*')
      .eq('reservation_token', reservationToken)
      .maybeSingle();

    if (reservationErr) {
      console.error('Reservation lookup failed:', reservationErr);
      return res.status(500).json({ error: 'DB error' });
    }

    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    if (reservation.status !== 'pending') {
      return res.status(400).json({ error: 'Reservation is not pending' });
    }

    const now = new Date();
    const expiresAt = new Date(reservation.expires_at);
    if (now > expiresAt) {
      await releaseExpiredReservation(reservationToken);
      return res.status(400).json({ error: 'Reservation expired' });
    }

    const tx = await provider.getTransaction(txHash);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!tx || !receipt) return res.status(400).json({ error: 'Transaction not found or not mined yet' });
    if (receipt.status !== 1) {
      console.warn(`Transaction ${txHash} failed for reservation ${reservationToken}`);
      return res.status(400).json({ error: 'Transaction failed' });
    }

    const txValue = BigInt(tx.value.toString());
    const expectedValue = BigInt(reservation.expected_total_wei);
    if (txValue !== expectedValue) {
      console.warn(`Payment mismatch for reservation ${reservationToken}: expected ${expectedValue}, got ${txValue}`);
      return res.status(400).json({ error: 'Amount must match reservation exactly' });
    }

    if (!PAYMENT_RECEIVER) {
      console.error('Server missing PAYMENT_RECEIVER');
      return res.status(500).json({ error: 'Server misconfigured' });
    }

    if (!tx.to || tx.to.toLowerCase() !== PAYMENT_RECEIVER.toLowerCase()) {
      console.warn(`Payment receiver mismatch for reservation ${reservationToken}: expected ${PAYMENT_RECEIVER}, got ${tx.to}`);
      return res.status(400).json({ error: 'Payment receiver mismatch' });
    }

    const block = await provider.getBlock(receipt.blockNumber);
    if (!block) {
      console.error(`Unable to fetch block ${receipt.blockNumber} for tx ${txHash}`);
      return res.status(500).json({ error: 'Blockchain verification failed' });
    }

    const txTimestamp = new Date(block.timestamp * 1000);
    const createdAt = new Date(reservation.created_at);
    if (txTimestamp < createdAt || txTimestamp > expiresAt) {
      console.warn(`Transaction timestamp outside reservation window for ${reservationToken}: created ${createdAt.toISOString()}, tx ${txTimestamp.toISOString()}, expires ${expiresAt.toISOString()}`);
      return res.status(400).json({ error: 'Transaction not valid for this reservation' });
    }

    const { error: updateErr } = await supabase
      .from('pixels')
      .update({ tx_hash: txHash })
      .eq('reservation_token', reservationToken)
      .eq('tx_hash', `RESERVED:${reservationToken}`);

    if (updateErr) {
      console.error('Finalizing claim failed:', updateErr);
      return res.status(500).json({ error: 'Finalizing claim failed' });
    }

    const { error: statusErr } = await supabase
      .from('pixels_reservations')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('reservation_token', reservationToken);

    if (statusErr) {
      console.error('Failed to mark reservation completed:', statusErr);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
