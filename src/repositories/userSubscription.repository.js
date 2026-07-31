const BaseRepository = require('./base.repository');
const { UserSubscription, PlanBillingOption, Plan, PlanFeature, FeatureType } = require('../models');
const { Op } = require('sequelize');

class UserSubscriptionRepository extends BaseRepository {
  constructor() { super(UserSubscription); }

  findActiveByUser(userId) {
    return this.findOne({ user_id: userId, status: 'active' });
  }

  // Active subscription with everything the FE needs to render entitlements:
  // the plan, its per-feature limits (+ the feature type meta), and the billing
  // option (cycle/price). Used by GET /subscriptions/me.
  findActiveDetailed(userId) {
    return this.findOne(
      { user_id: userId, status: 'active' },
      {
        include: [
          { model: Plan, include: [{ model: PlanFeature, include: [{ model: FeatureType }] }] },
          { model: PlanBillingOption },
        ],
      }
    );
  }

  // Eligibility guards. Both count any status (incl. expired/cancelled) so a
  // used-up trial/pass still blocks a repeat — the rules are "one pass ever"
  // and "one trial per plan".
  findAccessPassByUser(userId) {
    return this.findOne({ user_id: userId, sub_type: 'access_pass' });
  }

  findTrialByUserAndPlan(userId, planId) {
    return this.findOne({ user_id: userId, plan_id: planId, sub_type: 'trial' });
  }

  // Drives coupon target_audience (new_users vs existing_users): a user "has
  // subscribed" once any row got past 'pending'. Abandoned checkouts stay pending
  // and must not burn new-user eligibility.
  async hasEverSubscribed(userId) {
    const n = await this.model.count({
      where: { user_id: userId, status: { [Op.ne]: 'pending' } },
    });
    return n > 0;
  }

  findByRazorpaySubscriptionId(subId) {
    return this.findOne({ razorpay_subscription_id: subId }, { include: [{ model: PlanBillingOption }] });
  }

  // Only one-time / access-pass subscriptions (auto_renew = 0) expire on a
  // timer. Recurring subs (auto_renew = 1) are driven by Razorpay webhooks
  // (charged extends ends_at; halted/cancelled ends them), so a briefly-late
  // webhook must not wrongly expire a healthy recurring sub.
  findExpired() {
    return this.findMany({ status: 'active', auto_renew: 0, ends_at: { [Op.lt]: new Date() } });
  }

  findOverriddenToReactivate(userId) {
    return this.findMany({
      user_id: userId,
      status: 'overridden',
      ends_at: { [Op.gt]: new Date() },
    });
  }
}

module.exports = new UserSubscriptionRepository();
