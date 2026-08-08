const { Op, literal } = require('sequelize');
const BaseRepository = require('./base.repository');
const { Business, BusinessCategory, User } = require('../models');

const EARTH_KM = 6371;
const KM_PER_DEG_LAT = 111.045;

// Category attributes on the PUBLIC reads. The moderation columns are fetched but
// never emitted — business.service#toPublic reads them to decide whether the
// industry chip is shown at all, then builds the chip by hand.
const PUBLIC_CATEGORY_ATTRS = ['id', 'uid', 'slug', 'name', 'status', 'is_active'];

// A deactivated owner's business must vanish from the public directory. Enforced
// as a required join rather than by switching the business off, so reactivating
// the account restores the listing exactly as it was — and so a business the
// owner had already deleted stays deleted.
const ACTIVE_OWNER = { model: User, attributes: [], where: { is_active: 1 }, required: true };

class BusinessRepository extends BaseRepository {
  constructor() { super(Business); }

  findAllByUser(userId, options = {}) { return this.findMany({ user_id: userId, is_active: 1 }, options); }

  // Public profile: active businesses only, with their category for the label chip.
  // `status`/`is_active` come along so the caller can suppress the chip while a
  // user-suggested sub-industry is still awaiting approval (see toPublic).
  findPublicByUid(uid) {
    return this.findOne(
      { uid, is_active: 1 },
      { include: [{ model: BusinessCategory, attributes: PUBLIC_CATEGORY_ATTRS }, ACTIVE_OWNER] },
    );
  }

  /**
   * "Near Me" geo search. Caller passes already-sanitized numbers.
   * Bounding-box prefilter (index-friendly) narrows rows, then a haversine
   * expression gives precise `distance_km` for the radius cut and ordering.
   */
  findNearby({ lat, lng, radiusKm, q, categoryId, sort, limit, offset }) {
    const latDelta = radiusKm / KM_PER_DEG_LAT;
    const lngDelta = radiusKm / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180) || 1);

    const distance = literal(
      `(${EARTH_KM} * acos(LEAST(1, ` +
      `cos(radians(${lat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${lng})) + ` +
      `sin(radians(${lat})) * sin(radians(latitude)))))`,
    );

    const where = {
      is_active: 1,
      latitude:  { [Op.between]: [lat - latDelta, lat + latDelta] },
      longitude: { [Op.between]: [lng - lngDelta, lng + lngDelta] },
    };
    if (categoryId != null) where.category_id = categoryId; // 0 => supplied-but-unresolved: match nothing
    if (q) where[Op.or] = [
      { name:        { [Op.like]: `%${q}%` } },
      { description: { [Op.like]: `%${q}%` } },
    ];

    const order = sort === 'rating'
      ? [[literal('rating_avg'), 'DESC'], [literal('rating_count'), 'DESC'], [literal('distance_km'), 'ASC']]
      : [[literal('distance_km'), 'ASC']];

    return this.model.findAll({
      attributes: { include: [[distance, 'distance_km']] },
      where,
      having: literal(`distance_km <= ${radiusKm}`),
      include: [{ model: BusinessCategory, attributes: PUBLIC_CATEGORY_ATTRS }, ACTIVE_OWNER],
      order,
      limit,
      offset,
      subQuery: false,
    });
  }
}

module.exports = new BusinessRepository();
