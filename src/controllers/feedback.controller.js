const feedbackService = require('../services/feedback.service');

const submit = async (req, res) => {
  const data = await feedbackService.submit(req.user.userId, req.body);
  res.status(201).json({ success: true, data });
};

module.exports = { submit };
