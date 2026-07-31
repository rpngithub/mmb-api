const sequelize = require('../config/db');
const { DataTypes } = require('sequelize');

const modelFiles = [
  'user.model',
  'adminUser.model',
  'role.model',
  'userSession.model',
  'tokenBlacklist.model',
  'otpCode.model',
  'failedLoginAttempt.model',
  'activityLog.model',
  'business.model',
  'businessCategory.model',
  'tag.model',
  'businessCategoryTag.model',
  'product.model',
  'productImage.model',
  'templateCategory.model',
  'template.model',
  'templateTag.model',
  'templateSize.model',
  'templateSizeMap.model',
  'themeGroup.model',
  'theme.model',
  'themeTemplate.model',
  'themePlanRestriction.model',
  'themeBusinessCategory.model',
  'businessTheme.model',
  'templateBusinessCategory.model',
  'assetCategory.model',
  'asset.model',
  'assetTag.model',
  'specialEvent.model',
  'specialEventTemplate.model',
  'userFrame.model',
  'project.model',
  'projectExport.model',
  'plan.model',
  'planBillingOption.model',
  'featureType.model',
  'planFeature.model',
  'coupon.model',
  'couponPlanRestriction.model',
  'userSubscription.model',
  'payment.model',
  'userQuotaUsage.model',
  'userBillingDetail.model',
  'faqCategory.model',
  'faq.model',
  'testimonial.model',
  'appBanner.model',
  'appSetting.model',
];

const db = { sequelize };

for (const file of modelFiles) {
  const define = require(`./${file}`);
  if (typeof define === 'function') {
    define(sequelize);
  }
}

// expose models by their registered name
for (const modelName of Object.keys(sequelize.models)) {
  db[modelName] = sequelize.models[modelName];
}

// run associations after all models are registered
for (const modelName of Object.keys(db)) {
  if (db[modelName] && typeof db[modelName].associate === 'function') {
    db[modelName].associate(db);
  }
}

module.exports = db;
