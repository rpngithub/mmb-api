const { Op } = require('sequelize');
const { ValidationError, ConflictError } = require('../errors');
const { Plan, PlanBillingOption } = require('../models');

// Invariants for the free plan (plan_type 'free') — the plan accounts WITHOUT a
// subscription are held to by quota.service. It is a set of limits, not a product:
// nothing can be bought on it, and there can only be one, or "which limits apply
// to a free user?" would have no single answer. Judged on the state the row WOULD
// have after the write, like couponRules, so a PATCH carrying one field is still
// checked against the rest.
async function assertPlanWritable(patch, row) {
  const next = { ...(row ? row.toJSON() : {}), ...patch };
  if (next.plan_type !== 'free') return;

  const details = [];
  if (next.trial_days) details.push({ field: 'trial_days', message: 'The free plan has no trial' });
  if (next.pass_price != null || next.pass_days != null) {
    details.push({ field: 'pass_price', message: 'The free plan is not an access pass' });
  }
  if (details.length) throw new ValidationError('Invalid free plan', details);

  if (row && await PlanBillingOption.count({ where: { plan_id: row.id, is_active: 1 } })) {
    throw new ValidationError('A plan with active billing options cannot be the free plan — deactivate them first');
  }

  if ((next.status || 'active') === 'active') {
    const other = await Plan.findOne({
      where: { plan_type: 'free', status: 'active', ...(row ? { id: { [Op.ne]: row.id } } : {}) },
    });
    if (other) throw new ConflictError(`"${other.name}" is already the active free plan`);
  }
}

// Nothing is sold on the free plan, so it can have no price to sell it at.
async function assertBillingOptionWritable(patch, row) {
  const planId = patch.plan_id ?? row?.plan_id;
  const plan   = planId ? await Plan.findByPk(planId, { attributes: ['plan_type'] }) : null;
  if (plan?.plan_type === 'free') {
    throw new ValidationError('The free plan cannot have billing options');
  }
}

module.exports = { assertPlanWritable, assertBillingOptionWritable };
