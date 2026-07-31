const Razorpay = require('razorpay');

// Lazily instantiate so the app can boot without Razorpay keys configured
// (e.g. local dev). The client is created on first actual payment call.
let client = null;

function getRazorpay() {
  if (!client) {
    client = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return client;
}

module.exports = getRazorpay;
