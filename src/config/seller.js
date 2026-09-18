// The supplier block on every invoice and receipt — who is selling. Deployment
// configuration rather than an app_settings row: the GSTIN printed on a tax
// invoice is not something to leave one stray click away in the admin panel,
// and it changes about as often as the company's registered address does.
//
// Read on each call rather than captured at require time so a test can set it.
// Every field degrades gracefully: a blank GSTIN renders as "pending" rather than
// failing the document, because a customer asking for their receipt on the day
// registration is still in progress must still get one.
//
// SELLER_STATE decides CGST+SGST (buyer in the same state) versus IGST (any other
// state) on the invoice. The split is presentation only — the customer was
// charged the flat rate in utils/gst.js either way.
function seller() {
  const env = process.env;
  return {
    name:       env.SELLER_NAME       || 'MakeMyBrand',
    gstin:      env.SELLER_GSTIN      || '',
    address:    env.SELLER_ADDRESS    || '',
    state:      env.SELLER_STATE      || '',
    state_code: env.SELLER_STATE_CODE || '',
    email:      env.SELLER_EMAIL      || '',
    // Services Accounting Code for what MMB sells. 998314 is "IT design and
    // development services", the code most Indian SaaS files under.
    sac_code:   env.SELLER_SAC_CODE   || '998314',
  };
}

module.exports = { seller };
