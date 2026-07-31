const Joi = require('joi');

const createSubscriptionSchema = Joi.object({
  plan_billing_option_id: Joi.number().integer().required(),
  coupon_code:            Joi.string().optional(),
});

const verifyCouponSchema = Joi.object({
  code:    Joi.string().required(),
  plan_id: Joi.number().integer().required(),
});

const verifyPaymentSchema = Joi.object({
  razorpay_order_id:   Joi.string().required(),
  razorpay_payment_id: Joi.string().required(),
  razorpay_signature:  Joi.string().required(),
});

module.exports = { createSubscriptionSchema, verifyCouponSchema, verifyPaymentSchema };
