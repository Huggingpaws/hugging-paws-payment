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

// Fixed product price is decided on the SERVER, not trusted from the browser —
// this is what stops someone tampering with the price in dev tools.
const PRODUCT_PRICE_INR = 199;

// 1. Create a Razorpay order (called before opening the Razorpay checkout popup)
app.post('/create-order', async (req, res) => {
  try {
    const options = {
      amount: PRODUCT_PRICE_INR * 100, // amount in paise
      currency: 'INR',
      receipt: 'receipt_' + Date.now(),
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
