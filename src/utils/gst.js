// Indian GST applied to everything sold through the API — plans, the access pass,
// and now individual frames. Extracted from subscription.service so the rate is
// defined once: two copies would drift the first time it changes, and the copy
// that did not change would quietly under-charge tax.
//
// Stored prices are always PRE-tax; the gateway is always handed the post-tax
// total. `payments` keeps all three figures so an invoice can be reconstructed
// without re-deriving anything.
const GST_RATE = 0.18;

function withGst(amountBeforeTax) {
  const gstAmount   = parseFloat((amountBeforeTax * GST_RATE).toFixed(2));
  const totalAmount = parseFloat((amountBeforeTax + gstAmount).toFixed(2));
  return { gstAmount, totalAmount };
}

module.exports = { GST_RATE, withGst };
