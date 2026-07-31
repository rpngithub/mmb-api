const catalog = require('../services/catalog.service');
const specialEventService = require('../services/specialEvent.service');

const send = (res, data) => res.json({ success: true, data });

const businessCategories = async (req, res) => send(res, await catalog.listBusinessCategories(req.query));
const templateCategories = async (req, res) => send(res, await catalog.listTemplateCategories(req.query));
const assetCategories    = async (req, res) => send(res, await catalog.listAssetCategories(req.query));
const tags               = async (req, res) => send(res, await catalog.listTags());
const templateSizes      = async (req, res) => send(res, await catalog.listTemplateSizes());
const themeGroups        = async (req, res) => send(res, await catalog.listThemeGroups());
const themes             = async (req, res) => send(res, await catalog.listThemes(req.query));
const themeDetail        = async (req, res) => send(res, await catalog.getThemeDetail(req.params.uid, req.user));
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
  businessCategories, templateCategories, assetCategories, tags, templateSizes, themeGroups,
  themes, themeDetail, faqCategories, faqs, testimonials, banners, specialEvents, plans,
};
