const BaseRepository = require('./base.repository');
const { Payment } = require('../models');

class PaymentRepository extends BaseRepository {
  constructor() { super(Payment); }

  findByRazorpayOrderId(orderId)     { return this.findOne({ razorpay_order_id: orderId }); }
  findByRazorpayPaymentId(paymentId) { return this.findOne({ razorpay_payment_id: paymentId }); }
}

module.exports = new PaymentRepository();
