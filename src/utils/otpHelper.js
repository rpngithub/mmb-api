const bcrypt = require('bcryptjs');
const axios  = require('axios');

const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));

const hashOtp = (otp) => bcrypt.hash(otp, 10);

const verifyOtp = (otp, hash) => bcrypt.compare(otp, hash);

const sendOtp = async (phone, otp) => {
  const { SMS_API_KEY, SMS_SENDER_ID, SMS_TEMPLATE_ID } = process.env;
  if (!SMS_API_KEY) {
    console.log(`[OTP DEV] ${phone} → ${otp}`);
    return;
  }
  await axios.post('https://sms.example.com/send', {
    apiKey:     SMS_API_KEY,
    sender:     SMS_SENDER_ID,
    templateId: SMS_TEMPLATE_ID,
    to:         phone,
    variables:  { otp },
  });
};

module.exports = { generateOtp, hashOtp, verifyOtp, sendOtp };
