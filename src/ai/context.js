const { ValidationError } = require('../errors');
const inputSchema = require('./inputSchema');
const { httpError } = require('./errors');

// Server-side context for an AI request: what we already know about the user's
// business and the design they are posting, so the app never has to send it (and
// cannot send someone else's). An operation asks for it in its input schema:
//
//   { "fields": { "project": { "type": "project" }, … }, "context": ["business", "project"] }
//
// Built at SUBMIT, before anything is charged — a project that is not the user's
// is a 404 and costs nothing — and SNAPSHOTTED on the job (ai_jobs.context), so a
// job queued for a while, or retried elsewhere, sends what the user saw when they
// asked, and support can see exactly what went in.
//
// Contact details (phone, WhatsApp, email, website, address) go in only when the
// request sets `include_contact: true`. Everything here is user-authored text and
// reaches the model as DATA in the user turn, never as instructions (see the
// adapter's user_template).
//
// Snapshot:
//   { language: { code, name, native_name },
//     business: { name, description, industry, city, state, keywords[], contact? } | null,
//     project:  { name, design: { name, category, industries[], events[], keywords[] } } | null,
//     attachments: [{ kind: 'project_thumbnail', s3_key }] }   // fetched at send time

const MAX_TEXT = 1000;
const MAX_LIST = 20;
const DEFAULT_LANGUAGE = { code: 'en', name: 'English', native_name: 'English' };

const models = () => require('../models');
const clip = (s, n = MAX_TEXT) => (s === null || s === undefined || s === '' ? null : String(s).slice(0, n));
const names = (rows) => (rows || []).map((r) => r.name).filter(Boolean).slice(0, MAX_LIST);
const lang = (l) => (l ? { code: l.code, name: l.name, native_name: l.native_name } : null);

async function loadProject(ref, userId) {
  const { Project, Template, TemplateFamily, TemplateCategory, BusinessCategory, SpecialEvent, Language } = models();
  const project = await Project.findOne({
    where: { uid: ref.uid, user_id: userId },
    attributes: ['id', 'name', 'business_id', 'thumbnail_s3_key'],
    include: [{
      model: Template, required: false, attributes: ['id', 'name', 'language_id'],
      include: [
        { model: Language, required: false, attributes: ['code', 'name', 'native_name'] },
        {
          model: TemplateFamily, as: 'family', required: false, attributes: ['id', 'name', 'search_keywords'],
          include: [
            { model: TemplateCategory, required: false, attributes: ['name'] },
            { model: BusinessCategory, required: false, attributes: ['name'], through: { attributes: [] } },
            { model: SpecialEvent, required: false, attributes: ['name', 'type'], through: { attributes: [] } },
          ],
        },
      ],
    }],
  });
  // Someone else's project, or none: a 404, like someone else's image.
  if (!project) throw httpError.projectNotFound(ref.field);
  return project;
}

async function loadBusiness(userId, businessId) {
  const { Business, BusinessCategory, Tag } = models();
  const include = [
    { model: BusinessCategory, required: false, attributes: ['name'] },
    { model: Tag, required: false, attributes: ['name'], through: { attributes: [] } },
  ];
  if (businessId) {
    const b = await Business.findOne({ where: { id: businessId, user_id: userId }, include });
    if (b) return b;
  }
  return Business.findOne({ where: { user_id: userId, is_active: 1 }, include, order: [['id', 'ASC']] });
}

// The language to write in: the request's, else the user's primary content
// language ("Preferred Languages", position 0), else the design's, else English.
async function resolveLanguage(code, userId, templateLanguage) {
  const { Language, sequelize } = models();
  if (code) {
    const l = await Language.findOne({ where: { code: String(code).toLowerCase(), is_active: 1 }, attributes: ['code', 'name', 'native_name'] });
    if (!l) throw new ValidationError('Validation failed', [{ field: 'language', message: 'unknown or inactive language code' }]);
    return lang(l);
  }
  const [rows] = await sequelize.query(
    `SELECT l.code, l.name, l.native_name FROM user_languages ul JOIN languages l ON l.id = ul.language_id
      WHERE ul.user_id = ? AND l.is_active = 1 ORDER BY ul.position ASC, ul.id ASC LIMIT 1`,
    { replacements: [userId] },
  );
  return lang(rows[0]) || lang(templateLanguage) || DEFAULT_LANGUAGE;
}

/**
 * @returns the snapshot, or null when the operation declares no context.
 * @throws 404 AI_INPUT_NOT_FOUND for a project that is not the user's;
 *         400 when there is nothing at all to write about.
 */
async function build(operation, input, userId) {
  const schema = operation.input_schema || {};
  const sources = Array.isArray(schema.context) ? schema.context : [];
  if (!sources.length) return null;

  let project = null;
  const ref = sources.includes('project') ? inputSchema.projectRef(schema, input) : null;
  if (ref) project = await loadProject(ref, userId);

  const tpl = project?.Template || null;
  const fam = tpl?.family || null;
  const out = {
    language: await resolveLanguage(input.language, userId, tpl?.Language),
    business: null,
    project: null,
    attachments: [],
  };

  if (project) {
    out.project = {
      name: clip(project.name, 200),
      design: fam ? {
        name: clip(fam.name, 200),
        category: fam.TemplateCategory?.name || null,
        industries: names(fam.BusinessCategories),
        events: (fam.SpecialEvents || []).slice(0, MAX_LIST).map((e) => ({ name: e.name, type: e.type })),
        keywords: (Array.isArray(fam.search_keywords) ? fam.search_keywords : []).slice(0, MAX_LIST),
      } : null,
    };
    if (project.thumbnail_s3_key) out.attachments.push({ kind: 'project_thumbnail', s3_key: project.thumbnail_s3_key });
  }

  if (sources.includes('business')) {
    const b = await loadBusiness(userId, project?.business_id);
    if (b) {
      out.business = {
        name: clip(b.name, 200),
        description: clip(b.description),
        industry: b.BusinessCategory?.name || null,
        city: clip(b.city, 100),
        state: clip(b.state, 100),
        keywords: names(b.Tags),
      };
      if (input.include_contact === true) {
        out.business.contact = {
          phone: clip(b.phone, 20), whatsapp: clip(b.whatsapp, 20), email: clip(b.email, 150),
          website: clip(b.website, 255), address: clip(b.address, 500),
        };
      }
    }
  }

  const userText = typeof input.context === 'string' && input.context.trim();
  if (!out.business && !out.project && !userText) {
    throw new ValidationError('Validation failed', [{
      field: ref ? ref.field : 'context',
      message: 'nothing to write about: send a project, describe the post in context, or add a business profile first',
    }]);
  }
  return out;
}

// What the model is shown about the business and the design: the snapshot minus
// internal fields (storage keys never leave our side).
function forPrompt(snapshot) {
  if (!snapshot) return {};
  const { business, project } = snapshot;
  return { ...(business ? { business } : {}), ...(project ? { project } : {}) };
}

module.exports = { build, forPrompt, resolveLanguage, DEFAULT_LANGUAGE };
