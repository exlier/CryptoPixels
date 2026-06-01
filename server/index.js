const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const dns = require('dns').promises;
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const { logger, logPaymentAttempt, logSecurityEvent, logRateLimitWarning } = require('./logger');
const { validateImageUrl, validateLinkUrl } = require('./urlSanitizer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Rate limiters
const readLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: 'Too many read requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Log rate limit hits
    return false;
  },
  handler: (req, res) => {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.connection.remoteAddress || 
                     req.socket.remoteAddress || 
                     'unknown';
    logRateLimitWarning(clientIp, {
      endpoint: req.path,
      method: 'GET',
      limit: 100,
      windowMs: 60000,
    });
    res.status(429).json({
      error: 'Too many read requests',
      retryAfter: 60,
    });
  },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: 'Too many write requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Log rate limit hits
    return false;
  },
  handler: (req, res) => {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.connection.remoteAddress || 
                     req.socket.remoteAddress || 
                     'unknown';
    logRateLimitWarning(clientIp, {
      endpoint: req.path,
      method: 'POST',
      limit: 10,
      windowMs: 60000,
    });
    res.status(429).json({
      error: 'Too many write requests',
      retryAfter: 60,
    });
  },
});

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PAYMENT_RECEIVER,
  BASE_RPC_URL = 'https://mainnet.base.org',
  BASE_CHAIN_ID = '8',
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

app.get('/api/pixels', readLimiter, async (req, res) => {
  try {
    const { data, error } = await supabase.from('pixels').select('*');
    if (error) return res.status(500).json({ error: 'DB error' });
    return res.json(data || []);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/pixel', readLimiter, async (req, res) => {
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

app.post('/api/checkout', writeLimiter, async (req, res) => {
  try {
    const { selectedPixels, imageUrl, linkUrl } = req.body || {};
    
    // Extract client IP
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.connection.remoteAddress || 
                     req.socket.remoteAddress || 
                     'unknown';

    // Validate pixel selection
    if (!Array.isArray(selectedPixels) || selectedPixels.length < 100) {
      logger.warn('Checkout validation failed: minimum order size not met', {
        ip: clientIp,
        pixelCount: selectedPixels?.length || 0,
      });
      return res.status(400).json({ error: 'Minimum order size is 100 pixels' });
    }

    // Validate URLs are provided
    if (!imageUrl || !linkUrl) {
      logger.warn('Checkout validation failed: missing URLs', {
        ip: clientIp,
        hasImageUrl: !!imageUrl,
        hasLinkUrl: !!linkUrl,
      });
      return res.status(400).json({ error: 'Missing image or link' });
    }

    // Validate link URL
    const linkValidation = await validateLinkUrl(linkUrl);
    if (!linkValidation.valid) {
      logSecurityEvent('invalid_link_url', {
        reason: linkValidation.error,
        ip: clientIp,
        url: linkUrl.substring(0, 100), // Log first 100 chars for debugging
      });
      logger.warn('Checkout validation failed: invalid link URL', {
        reason: linkValidation.error,
        ip: clientIp,
      });
      return res.status(400).json({ error: linkValidation.error });
    }

    // Validate image URL
    const imageValidation = await validateImageUrl(imageUrl);
    if (!imageValidation.valid) {
      logSecurityEvent('invalid_image_url', {
        reason: imageValidation.error,
        ip: clientIp,
        url: imageUrl.substring(0, 100), // Log first 100 chars for debugging
      });
      logger.warn('Checkout validation failed: invalid image URL', {
        reason: imageValidation.error,
        ip: clientIp,
      });
      return res.status(400).json({ error: imageValidation.error });
    }

    // Additional validation: fetch image metadata to ensure it's a valid image
    try {
      const head = await fetch(imageUrl, { method: 'HEAD', redirect: 'follow', timeout: 5000 });
      if (!head.ok) {
        logger.warn('Image URL not accessible', {
          ip: clientIp,
          status: head.status,
        });
        return res.status(400).json({ error: 'Image not fetchable' });
      }
      
      const contentType = head.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        logger.warn('URL does not point to image', {
          ip: clientIp,
          contentType,
        });
        return res.status(400).json({ error: 'Image URL does not point to an image' });
      }
      
      const contentLength = head.headers.get('content-length');
      if (contentLength && Number(contentLength) > 2 * 1024 * 1024) {
        logger.warn('Image too large', {
          ip: clientIp,
          size: contentLength,
        });
        return res.status(400).json({ error: 'Image too large' });
      }
    } catch (e) {
      logger.warn('Unable to fetch image metadata', {
        ip: clientIp,
        error: e.message,
      });
      return res.status(400).json({ error: 'Unable to fetch image metadata' });
    }

    // Calculate pricing and create reservation
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
      logger.error('Reservation creation failed', {
        error: reserveErr.message,
        ip: clientIp,
      });
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
      logger.error('Pixel reservation insertion failed', {
        error: insertErr.message,
        ip: clientIp,
        pixelCount: selectedPixels.length,
      });
      await supabase.from('pixels_reservations').delete().eq('reservation_token', reservationToken);
      return res.status(409).json({ error: 'Some pixels are already taken' });
    }

    logger.info('Checkout completed successfully', {
      reservationToken,
      pixelCount: selectedPixels.length,
      totalWei: totalWei.toString(),
      ip: clientIp,
    });

    return res.json({
      expectedTotalWei,
      priceWei: totalWei.toString(),
      paymentReceiver: PAYMENT_RECEIVER,
      reservationToken,
      reserveToken: reservationToken,
    });
  } catch (err) {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.connection.remoteAddress || 
                     req.socket.remoteAddress || 
                     'unknown';
    logger.error('Unexpected error in /api/checkout', {
      error: err.message,
      stack: err.stack,
      ip: clientIp,
    });
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/verify', writeLimiter, async (req, res) => {
  try {
    const { txHash } = req.body || {};
    const reservationToken = req.body?.reservationToken || req.body?.reserveToken;
    
    // Extract client IP from request
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.connection.remoteAddress || 
                     req.socket.remoteAddress || 
                     'unknown';
    
    // Validate inputs
    if (!txHash || !reservationToken) {
      logPaymentAttempt(txHash || 'unknown', 'failure', {
        reason: 'Missing txHash or reservation token',
        ip: clientIp,
        reservationToken: reservationToken || 'unknown',
      });
      return res.status(400).json({ error: 'Missing txHash or reservation token' });
    }

    // Replay attack protection: Check if this transaction hash has already been used
    const { data: usedTx, error: usedTxErr } = await supabase
      .from('used_transactions')
      .select('*')
      .eq('tx_hash', txHash)
      .maybeSingle();

    if (usedTxErr) {
      logger.error('Used transactions lookup failed', {
        txHash,
        reservationToken,
        error: usedTxErr.message,
        ip: clientIp,
      });
      return res.status(500).json({ error: 'DB error' });
    }

    if (usedTx) {
      logSecurityEvent('replay_attack_detected', {
        txHash,
        reservationToken,
        ip: clientIp,
        previousVerification: usedTx.verified_at,
      });
      logPaymentAttempt(txHash, 'failure', {
        reason: 'Replay attack - transaction already used',
        ip: clientIp,
        reservationToken,
      });
      return res.status(400).json({ error: 'Transaction has already been used' });
    }

    const { data: reservation, error: reservationErr } = await supabase
      .from('pixels_reservations')
      .select('*')
      .eq('reservation_token', reservationToken)
      .maybeSingle();

    if (reservationErr) {
      logger.error('Reservation lookup failed', {
        txHash,
        reservationToken,
        error: reservationErr.message,
        ip: clientIp,
      });
      return res.status(500).json({ error: 'DB error' });
    }

    if (!reservation) {
      logPaymentAttempt(txHash, 'failure', {
        reason: 'Reservation not found',
        ip: clientIp,
        reservationToken,
      });
      return res.status(404).json({ error: 'Reservation not found' });
    }

    if (reservation.status !== 'pending') {
      logSecurityEvent('non_pending_reservation_attempt', {
        txHash,
        reservationToken,
        ip: clientIp,
        currentStatus: reservation.status,
      });
      logPaymentAttempt(txHash, 'failure', {
        reason: `Reservation is not pending (status: ${reservation.status})`,
        ip: clientIp,
        reservationToken,
      });
      return res.status(400).json({ error: 'Reservation is not pending' });
    }

    const now = new Date();
    const expiresAt = new Date(reservation.expires_at);
    if (now > expiresAt) {
      logSecurityEvent('expired_reservation_attempt', {
        txHash,
        reservationToken,
        ip: clientIp,
        expiresAt: reservation.expires_at,
      });
      logPaymentAttempt(txHash, 'failure', {
        reason: 'Reservation expired',
        ip: clientIp,
        reservationToken,
      });
      await releaseExpiredReservation(reservationToken);
      return res.status(400).json({ error: 'Reservation expired' });
    }

    const tx = await provider.getTransaction(txHash);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!tx || !receipt) {
      logPaymentAttempt(txHash, 'failure', {
        reason: 'Transaction not found or not mined yet',
        ip: clientIp,
        reservationToken,
      });
      return res.status(400).json({ error: 'Transaction not found or not mined yet' });
    }
    
    if (receipt.status !== 1) {
      logPaymentAttempt(txHash, 'failure', {
        reason: 'Transaction failed',
        ip: clientIp,
        reservationToken,
        txStatus: receipt.status,
      });
      return res.status(400).json({ error: 'Transaction failed' });
    }

    // Verify chainId to prevent cross-chain replays
    const network = await provider.getNetwork();
    const expectedChainId = Number(BASE_CHAIN_ID);
    if (network.chainId !== expectedChainId) {
      logSecurityEvent('chain_id_mismatch', {
        txHash,
        reservationToken,
        ip: clientIp,
        expectedChainId,
        actualChainId: network.chainId,
      });
      logPaymentAttempt(txHash, 'failure', {
        reason: `Chain ID mismatch (expected ${expectedChainId}, got ${network.chainId})`,
        ip: clientIp,
        reservationToken,
        expectedChainId,
        actualChainId: network.chainId,
      });
      return res.status(400).json({ error: 'Transaction is not on the correct chain' });
    }

    const txValue = BigInt(tx.value.toString());
    const expectedValue = BigInt(reservation.expected_total_wei);
    if (txValue !== expectedValue) {
      logSecurityEvent('payment_amount_mismatch', {
        txHash,
        reservationToken,
        ip: clientIp,
        expectedValue: expectedValue.toString(),
        actualValue: txValue.toString(),
      });
      logPaymentAttempt(txHash, 'failure', {
        reason: `Amount mismatch (expected ${expectedValue}, got ${txValue})`,
        ip: clientIp,
        reservationToken,
        expectedValue: expectedValue.toString(),
        value: txValue.toString(),
        chainId: network.chainId,
      });
      return res.status(400).json({ error: 'Amount must match reservation exactly' });
    }

    if (!PAYMENT_RECEIVER) {
      logger.error('Server missing PAYMENT_RECEIVER configuration', { txHash, reservationToken, ip: clientIp });
      return res.status(500).json({ error: 'Server misconfigured' });
    }

    if (!tx.to || tx.to.toLowerCase() !== PAYMENT_RECEIVER.toLowerCase()) {
      logSecurityEvent('payment_receiver_mismatch', {
        txHash,
        reservationToken,
        ip: clientIp,
        expectedReceiver: PAYMENT_RECEIVER,
        actualReceiver: tx.to,
      });
      logPaymentAttempt(txHash, 'failure', {
        reason: `Payment receiver mismatch (expected ${PAYMENT_RECEIVER}, got ${tx.to})`,
        ip: clientIp,
        reservationToken,
        value: txValue.toString(),
        chainId: network.chainId,
      });
      return res.status(400).json({ error: 'Payment receiver mismatch' });
    }

    const block = await provider.getBlock(receipt.blockNumber);
    if (!block) {
      logger.error('Unable to fetch block for transaction', {
        txHash,
        reservationToken,
        blockNumber: receipt.blockNumber,
        ip: clientIp,
      });
      return res.status(500).json({ error: 'Blockchain verification failed' });
    }

    const txTimestamp = new Date(block.timestamp * 1000);
    const createdAt = new Date(reservation.created_at);
    if (txTimestamp < createdAt || txTimestamp > expiresAt) {
      logSecurityEvent('transaction_timestamp_mismatch', {
        txHash,
        reservationToken,
        ip: clientIp,
        createdAt: createdAt.toISOString(),
        txTimestamp: txTimestamp.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      logPaymentAttempt(txHash, 'failure', {
        reason: 'Transaction timestamp outside reservation window',
        ip: clientIp,
        reservationToken,
        value: txValue.toString(),
        chainId: network.chainId,
      });
      return res.status(400).json({ error: 'Transaction not valid for this reservation' });
    }

    // Store the used transaction hash to prevent replays
    const { error: storeErr } = await supabase
      .from('used_transactions')
      .insert([
        {
          tx_hash: txHash,
          chain_id: network.chainId,
          verified_at: new Date().toISOString(),
        },
      ]);

    if (storeErr) {
      logger.error('Failed to store used transaction hash', {
        txHash,
        reservationToken,
        chainId: network.chainId,
        error: storeErr.message,
        ip: clientIp,
      });
      return res.status(500).json({ error: 'Failed to store transaction record' });
    }

    const { error: updateErr } = await supabase
      .from('pixels')
      .update({ tx_hash: txHash })
      .eq('reservation_token', reservationToken)
      .eq('tx_hash', `RESERVED:${reservationToken}`);

    if (updateErr) {
      logger.error('Finalizing claim failed', {
        txHash,
        reservationToken,
        error: updateErr.message,
        ip: clientIp,
      });
      return res.status(500).json({ error: 'Finalizing claim failed' });
    }

    const { error: statusErr } = await supabase
      .from('pixels_reservations')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('reservation_token', reservationToken);

    if (statusErr) {
      logger.error('Failed to mark reservation completed', {
        txHash,
        reservationToken,
        error: statusErr.message,
        ip: clientIp,
      });
    }

    // Log successful verification
    logPaymentAttempt(txHash, 'success', {
      reason: 'Payment verified and pixels reserved',
      ip: clientIp,
      reservationToken,
      value: txValue.toString(),
      chainId: network.chainId,
    });

    logger.info('Payment verification completed successfully', {
      txHash,
      reservationToken,
      chainId: network.chainId,
      value: txValue.toString(),
      ip: clientIp,
    });

    return res.json({ success: true });
  } catch (err) {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.connection.remoteAddress || 
                     req.socket.remoteAddress || 
                     'unknown';
    logger.error('Unexpected error in /api/verify', {
      error: err.message,
      stack: err.stack,
      txHash: req.body?.txHash || 'unknown',
      reservationToken: req.body?.reservationToken || req.body?.reserveToken || 'unknown',
      ip: clientIp,
    });
    return res.status(500).json({ error: 'Server error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
