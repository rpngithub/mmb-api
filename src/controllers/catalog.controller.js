const catalog = require('../services/catalog.service');
const specialEventService = require('../services/specialEvent.service');

const send = (res, data) => res.json({ success: true, data });

const businessCategories = async (req, res) => send(res, await catalog.listBusinessCategories(req.query));
const industryDetail     = async (req, res) => send(res, await catalog.getIndustryDetail(req.params.ref));
const industryKeywords   = async (req, res) => send(res, await catalog.listIndustryKeywords(req.params.ref));
const pageSections       = async (req, res) => send(res, await catalog.listPageSections(req.query));
const templateCategories = async (req, res) => send(res, await catalog.listTemplateCategories(req.query));
const assetCategories    = async (req, res) => send(res, await catalog.listAssetCategories(req.query));
const tags               = async (req, res) => send(res, await catalog.listTags());
const languages          = async (req, res) => send(res, await catalog.listLanguages());
const templateSizes      = async (req, res) => send(res, await catalog.listTemplateSizes());
const brandSeries        = async (req, res) => send(res, await catalog.listBrandSeries(req.query, req.user));
const variants           = async (req, res) => send(res, await catalog.listVariants(req.query, req.user));
const variantDetail      = async (req, res) => send(res, await catalog.getVariantDetail(req.params.uid, req.user));
const faqCategories      = async (req, res) => send(res, await catalog.listFaqCategories());
const faqs               = async (req, res) => send(res, await catalog.listFaqs(req.query));
const testimonials       = async (req, res) => send(res, await catalog.listTestimonials());
const banners            = async (req, res) => send(res, await catalog.listBanners(req.user));
const specialEvents      = async (req, res) => {
  const { range, events } = await specialEventService.listSpecialEvents(req.query, req.user);
  res.json({ success: true, data: events, meta: { range } });
};
const plans              = async (req, res) => send(res, await catalog.listPlans(req.query));

module.exports = {
  businessCategories, industryDetail, industryKeywords, pageSections, templateCategories, assetCategories, tags, languages, templateSizes, brandSeries,
  variants, variantDetail, faqCategories, faqs, testimonials, banners, specialEvents, plans,
};
