// Hugging Paws — Razorpay backend
// Handles: order creation, payment signature verification, and simple order logging.
// Your Razorpay KEY SECRET lives ONLY here (as an environment variable) — never in the frontend.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' })); // lock this to your real site domain in production

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn('WARNING: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set. Set them as environment variables before going live.');
}

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

const ORDERS_FILE = path.join(__dirname, 'orders.json');
function readOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8')); } catch { return []; }
}
function saveOrder(order) {
  const orders = readOrders();
  orders.push(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// ===== Pricing (decided on the SERVER, never trusted from the browser) =====
// This mirrors the pricing shown on the site (index.html) exactly, so the
// amount charged always matches what the customer saw on screen.
const UNIT_PRICE = 199;   // 1 bottle
const PAIR_PRICE = 299;   // every 2 bottles
const SHIPPING_FEE = 200;
const SHIPPING_MIN_QTY = 10;

// Coupons — kept here too (not trusted from the browser) so a tampered
// "coupon" value in the request can't grant a discount it shouldn't.
const COUPONS = {
  BULK10: { pct: 20, minQty: 10 }, // 10+ bottles -> 20% off
  BULK20: { pct: 30, minQty: 20 }, // 20+ bottles -> 30% off
};

function clampQty(q) {
  q = parseInt(q, 10);
  if (!Number.isFinite(q) || q < 1) return 1;
  if (q > 50) return 50;
  return q;
}

function itemsTotal(q) {
  return Math.floor(q / 2) * PAIR_PRICE + (q % 2) * UNIT_PRICE;
}

function discountFor(q, couponCode) {
  const coupon = COUPONS[String(couponCode || '').toUpperCase()];
  if (!coupon || q < coupon.minQty) return 0;
  return Math.round(itemsTotal(q) * coupon.pct / 100);
}

function shippingFor(q) {
  return q >= SHIPPING_MIN_QTY ? SHIPPING_FEE : 0;
}

// Total for a PREPAID (online) order — COD fee is handled separately by the
// /cod-order route below and never goes through Razorpay.
function calcTotal(q, couponCode) {
  return itemsTotal(q) - discountFor(q, couponCode) + shippingFor(q);
}

// 1. Create a Razorpay order (called before opening the Razorpay checkout popup)
app.post('/create-order', async (req, res) => {
  try {
    const quantity = clampQty(req.body.quantity);
    const couponCode = req.body.coupon || '';

    const total = calcTotal(quantity, couponCode);

    const options = {
      amount: total * 100, // amount in paise
      currency: 'INR',
      receipt: 'receipt_' + Date.now(),
      notes: { quantity: String(quantity), coupon: couponCode || 'none' },
    };
    const order = await razorpay.orders.create(options);
    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_KEY_ID, // safe to expose — this is the publishable key
    });
  } catch (err) {
    console.error('create-order error:', err);
    res.status(500).json({ error: 'Could not create order' });
  }
});

// 2. Verify payment signature after Razorpay checkout completes (Prepaid orders)
app.post('/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, customer } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ verified: false, error: 'Missing payment fields' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const verified = expectedSignature === razorpay_signature;

  if (verified) {
    const orderId = 'HP' + Date.now().toString().slice(-8);
    saveOrder({
      orderId,
      razorpay_order_id,
      razorpay_payment_id,
      customer,
      paymentMethod: 'prepaid',
      status: 'paid',
      createdAt: new Date().toISOString(),
    });
    return res.json({ verified: true, orderId });
  }

  res.status(400).json({ verified: false, error: 'Signature mismatch — payment could not be verified' });
});

// 3. Log a Cash on Delivery order (no payment gateway involved, just record-keeping)
app.post('/cod-order', (req, res) => {
  const { customer } = req.body;
  if (!customer || !customer.name || !customer.phone || !customer.address || !customer.pincode) {
    return res.status(400).json({ error: 'Missing customer details' });
  }
  const orderId = 'HP' + Date.now().toString().slice(-8);
  saveOrder({
    orderId,
    customer,
    paymentMethod: 'cod',
    status: 'confirmed_cod',
    createdAt: new Date().toISOString(),
  });
  res.json({ orderId });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hugging Paws backend running on port ${PORT}`));
