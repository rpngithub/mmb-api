'use strict';

/**
 * Initial schema baseline for mmb-api.
 * Creates all 46 tables in foreign-key dependency order, mirroring the
 * Sequelize model definitions in src/models. Polymorphic actor_id columns
 * (user_sessions, token_blacklist, activity_logs) and self-referential
 * parent_id columns carry indexes but no DB-level FK constraint, matching
 * the models (which use { constraints: false } / app-level associations).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');

    const pk        = () => ({ type: S.INTEGER, primaryKey: true, autoIncrement: true });
    const uid       = () => ({ type: S.UUID, allowNull: false, unique: true });
    const created   = { type: S.DATE, allowNull: false, defaultValue: now };
    const updated   = { type: S.DATE, allowNull: false, defaultValue: now };
    const bothTs    = { created_at: created, updated_at: updated };
    const createdTs = { created_at: created };
    const updatedTs = { updated_at: updated };
    const fk = (model, { allowNull = false, onDelete = 'CASCADE' } = {}) => ({
      type: S.INTEGER,
      allowNull,
      references: { model, key: 'id' },
      onDelete,
      onUpdate: 'CASCADE',
    });

    // ---- roles ----
    await queryInterface.createTable('roles', {
      id:          pk(),
      uid:         uid(),
      name:        { type: S.STRING(100), allowNull: false, unique: true },
      description: { type: S.TEXT, allowNull: true },
      permissions: { type: S.JSON, allowNull: false },
      is_system:   { type: S.TINYINT, defaultValue: 0 },
      ...bothTs,
    });

    // ---- users ----
    await queryInterface.createTable('users', {
      id:                   pk(),
      uid:                  uid(),
      name:                 { type: S.STRING(100), allowNull: false },
      email:                { type: S.STRING(255), allowNull: true, unique: true },
      phone:                { type: S.STRING(20), allowNull: true, unique: true },
      password_hash:        { type: S.STRING(255), allowNull: true },
      profile_photo_s3_key: { type: S.STRING(500), allowNull: true },
      razorpay_customer_id: { type: S.STRING(100), allowNull: true },
      is_active:            { type: S.TINYINT, defaultValue: 1 },
      last_login_at:        { type: S.DATE, allowNull: true },
      ...bothTs,
    });

    // ---- admin_users ----
    await queryInterface.createTable('admin_users', {
      id:            pk(),
      uid:           uid(),
      name:          { type: S.STRING(100), allowNull: false },
      email:         { type: S.STRING(255), allowNull: false, unique: true },
      password_hash: { type: S.STRING(255), allowNull: false },
      role_id:       fk('roles', { onDelete: 'RESTRICT' }),
      is_active:     { type: S.TINYINT, defaultValue: 1 },
      last_login_at: { type: S.DATE, allowNull: true },
      ...bothTs,
    });

    // ---- user_sessions (polymorphic actor, no FK) ----
    await queryInterface.createTable('user_sessions', {
      id:                 pk(),
      uid:                uid(),
      actor_type:         { type: S.ENUM('user', 'admin'), allowNull: false },
      actor_id:           { type: S.INTEGER, allowNull: false },
      jti:                { type: S.UUID, allowNull: false, unique: true },
      refresh_token_hash: { type: S.STRING(255), allowNull: false },
      client_type:        { type: S.STRING(50), allowNull: true },
      ip_address:         { type: S.STRING(45), allowNull: true },
      device_info:        { type: S.TEXT, allowNull: true },
      expires_at:         { type: S.DATE, allowNull: false },
      is_revoked:         { type: S.TINYINT, defaultValue: 0 },
      ...createdTs,
    });

    // ---- token_blacklist (polymorphic actor, no FK) ----
    await queryInterface.createTable('token_blacklist', {
      id:         pk(),
      jti:        { type: S.UUID, allowNull: false, unique: true },
      actor_type: { type: S.ENUM('user', 'admin'), allowNull: false },
      actor_id:   { type: S.INTEGER, allowNull: false },
      reason:     { type: S.ENUM('logout', 'revoked', 'pwd_change'), allowNull: false },
      expires_at: { type: S.DATE, allowNull: false },
      ...createdTs,
    });

    // ---- otp_codes ----
    await queryInterface.createTable('otp_codes', {
      id:         pk(),
      phone:      { type: S.STRING(20), allowNull: false },
      otp_hash:   { type: S.STRING(255), allowNull: false },
      purpose:    { type: S.ENUM('login', 'signup', 'reset'), allowNull: false },
      attempts:   { type: S.INTEGER, defaultValue: 0 },
      expires_at: { type: S.DATE, allowNull: false },
      is_used:    { type: S.TINYINT, defaultValue: 0 },
      ...createdTs,
    });

    // ---- failed_login_attempts ----
    await queryInterface.createTable('failed_login_attempts', {
      id:           pk(),
      identifier:   { type: S.STRING(255), allowNull: false },
      ip_address:   { type: S.STRING(45), allowNull: true },
      attempt_type: { type: S.ENUM('password', 'otp'), allowNull: false },
      ...createdTs,
    });

    // ---- activity_logs (polymorphic actor, no FK) ----
    await queryInterface.createTable('activity_logs', {
      id:          pk(),
      actor_type:  { type: S.ENUM('user', 'admin'), allowNull: true },
      actor_id:    { type: S.INTEGER, allowNull: true },
      entity_type: { type: S.STRING(100), allowNull: true },
      entity_id:   { type: S.INTEGER, allowNull: true },
      action:      { type: S.STRING(100), allowNull: false },
      metadata:    { type: S.JSON, allowNull: true },
      ip_address:  { type: S.STRING(45), allowNull: true },
      ...createdTs,
    });

    // ---- business_categories (self-ref parent, no FK) ----
    await queryInterface.createTable('business_categories', {
      id:               pk(),
      uid:              uid(),
      parent_id:        { type: S.INTEGER, allowNull: true },
      name:             { type: S.STRING(100), allowNull: false },
      icon_s3_key:      { type: S.STRING(500), allowNull: true },
      thumbnail_s3_key: { type: S.STRING(500), allowNull: true },
      display_order:    { type: S.INTEGER, defaultValue: 0 },
      is_active:        { type: S.TINYINT, defaultValue: 1 },
      ...bothTs,
    });

    // ---- tags ----
    await queryInterface.createTable('tags', {
      id:   pk(),
      name: { type: S.STRING(100), allowNull: false, unique: true },
      ...createdTs,
    });

    // ---- business_category_tags ----
    await queryInterface.createTable('business_category_tags', {
      id:          pk(),
      category_id: fk('business_categories'),
      tag_id:      fk('tags'),
    });

    // ---- businesses ----
    await queryInterface.createTable('businesses', {
      id:           pk(),
      uid:          uid(),
      user_id:      fk('users'),
      category_id:  fk('business_categories', { allowNull: true, onDelete: 'SET NULL' }),
      name:         { type: S.STRING(200), allowNull: false },
      description:  { type: S.TEXT, allowNull: true },
      logo_s3_key:  { type: S.STRING(500), allowNull: true },
      cover_s3_key: { type: S.STRING(500), allowNull: true },
      latitude:     { type: S.DECIMAL(10, 8), allowNull: true },
      longitude:    { type: S.DECIMAL(11, 8), allowNull: true },
      geohash:      { type: S.STRING(12), allowNull: true },
      address:      { type: S.TEXT, allowNull: true },
      city:         { type: S.STRING(100), allowNull: true },
      state:        { type: S.STRING(100), allowNull: true },
      is_active:    { type: S.TINYINT, defaultValue: 1 },
      ...bothTs,
    });

    // ---- products ----
    await queryInterface.createTable('products', {
      id:          pk(),
      uid:         uid(),
      business_id: fk('businesses'),
      name:        { type: S.STRING(200), allowNull: false },
      description: { type: S.TEXT, allowNull: true },
      price:       { type: S.DECIMAL(10, 2), allowNull: true },
      is_active:   { type: S.TINYINT, defaultValue: 1 },
      ...bothTs,
    });

    // ---- product_images ----
    await queryInterface.createTable('product_images', {
      id:            pk(),
      product_id:    fk('products'),
      s3_key:        { type: S.STRING(500), allowNull: false },
      display_order: { type: S.INTEGER, defaultValue: 0 },
      ...createdTs,
    });

    // ---- template_categories (self-ref parent, no FK) ----
    await queryInterface.createTable('template_categories', {
      id:               pk(),
      uid:              uid(),
      parent_id:        { type: S.INTEGER, allowNull: true },
      name:             { type: S.STRING(100), allowNull: false },
      icon_s3_key:      { type: S.STRING(500), allowNull: true },
      thumbnail_s3_key: { type: S.STRING(500), allowNull: true },
      show_in_homepage: { type: S.TINYINT, defaultValue: 0 },
      display_order:    { type: S.INTEGER, defaultValue: 0 },
      is_active:        { type: S.TINYINT, defaultValue: 1 },
      ...bothTs,
    });

    // ---- templates ----
    await queryInterface.createTable('templates', {
      id:               pk(),
      uid:              uid(),
      category_id:      fk('template_categories', { allowNull: true, onDelete: 'SET NULL' }),
      name:             { type: S.STRING(200), allowNull: false },
      thumbnail_s3_key: { type: S.STRING(500), allowNull: true },
      content:          { type: S.TEXT('long'), allowNull: true },
      template_type:    { type: S.ENUM('image', 'video', 'animated'), defaultValue: 'image' },
      is_premium:       { type: S.TINYINT, defaultValue: 0 },
      trending_score:   { type: S.FLOAT, defaultValue: 0 },
      views_count:      { type: S.INTEGER, defaultValue: 0 },
      downloads_count:  { type: S.INTEGER, defaultValue: 0 },
      likes_count:      { type: S.INTEGER, defaultValue: 0 },
      status:           { type: S.ENUM('active', 'inactive', 'draft'), defaultValue: 'draft' },
      created_by:       fk('admin_users', { allowNull: true, onDelete: 'SET NULL' }),
      ...bothTs,
    });

    // ---- template_tags ----
    await queryInterface.createTable('template_tags', {
      id:          pk(),
      template_id: fk('templates'),
      tag_id:      fk('tags'),
    });

    // ---- template_sizes ----
    await queryInterface.createTable('template_sizes', {
      id:        pk(),
      uid:       uid(),
      name:      { type: S.STRING(100), allowNull: false },
      width:     { type: S.INTEGER, allowNull: false },
      height:    { type: S.INTEGER, allowNull: false },
      unit:      { type: S.STRING(10), defaultValue: 'px' },
      platform:  { type: S.ENUM('instagram', 'facebook', 'youtube', 'whatsapp', 'custom'), defaultValue: 'custom' },
      is_active: { type: S.TINYINT, defaultValue: 1 },
      ...createdTs,
    });

    // ---- template_size_map ----
    await queryInterface.createTable('template_size_map', {
      id:          pk(),
      template_id: fk('templates'),
      size_id:     fk('template_sizes'),
    });

    // ---- theme_groups ----
    await queryInterface.createTable('theme_groups', {
      id:            pk(),
      uid:           uid(),
      name:          { type: S.STRING(100), allowNull: false },
      display_order: { type: S.INTEGER, defaultValue: 0 },
      is_active:     { type: S.TINYINT, defaultValue: 1 },
      ...bothTs,
    });

    // ---- themes ----
    await queryInterface.createTable('themes', {
      id:               pk(),
      uid:              uid(),
      group_id:         fk('theme_groups'),
      name:             { type: S.STRING(100), allowNull: false },
      thumbnail_s3_key: { type: S.STRING(500), allowNull: true },
      display_order:    { type: S.INTEGER, defaultValue: 0 },
      is_active:        { type: S.TINYINT, defaultValue: 1 },
      ...bothTs,
    });

    // ---- theme_templates ----
    await queryInterface.createTable('theme_templates', {
      id:          pk(),
      theme_id:    fk('themes'),
      template_id: fk('templates'),
    });

    // ---- template_business_categories ----
    await queryInterface.createTable('template_business_categories', {
      id:                   pk(),
      template_id:          fk('templates'),
      business_category_id: fk('business_categories'),
    });

    // ---- asset_categories (self-ref parent, no FK) ----
    await queryInterface.createTable('asset_categories', {
      id:            pk(),
      uid:           uid(),
      parent_id:     { type: S.INTEGER, allowNull: true },
      name:          { type: S.STRING(100), allowNull: false },
      display_order: { type: S.INTEGER, defaultValue: 0 },
      is_active:     { type: S.TINYINT, defaultValue: 1 },
      ...bothTs,
    });

    // ---- assets ----
    await queryInterface.createTable('assets', {
      id:          pk(),
      uid:         uid(),
      category_id: fk('asset_categories', { allowNull: true, onDelete: 'SET NULL' }),
      name:        { type: S.STRING(200), allowNull: false },
      s3_key:      { type: S.STRING(500), allowNull: false },
      asset_type:  { type: S.ENUM('icon', 'emoji', 'shape', 'font', 'audio', 'video', 'animated', 'bg'), allowNull: false },
      is_premium:  { type: S.TINYINT, defaultValue: 0 },
      status:      { type: S.ENUM('active', 'inactive'), defaultValue: 'active' },
      ...bothTs,
    });

    // ---- asset_tags ----
    await queryInterface.createTable('asset_tags', {
      id:       pk(),
      asset_id: fk('assets'),
      tag_id:   fk('tags'),
    });

    // ---- special_events ----
    await queryInterface.createTable('special_events', {
      id:           pk(),
      uid:          uid(),
      name:         { type: S.STRING(200), allowNull: false },
      description:  { type: S.TEXT, allowNull: true },
      type:         { type: S.ENUM('holiday', 'observance', 'awareness', 'custom'), allowNull: false },
      event_date:   { type: S.STRING(5), allowNull: true },
      full_date:    { type: S.DATEONLY, allowNull: true },
      is_recurring: { type: S.TINYINT, defaultValue: 1 },
      is_active:    { type: S.TINYINT, defaultValue: 1 },
      ...bothTs,
    });

    // ---- special_event_templates ----
    await queryInterface.createTable('special_event_templates', {
      id:          pk(),
      event_id:    fk('special_events'),
      template_id: fk('templates'),
    });

    // ---- user_frames ----
    await queryInterface.createTable('user_frames', {
      id:         pk(),
      uid:        uid(),
      user_id:    fk('users'),
      name:       { type: S.STRING(200), allowNull: false },
      s3_key:     { type: S.STRING(500), allowNull: false },
      frame_type: { type: S.ENUM('image', 'animated'), defaultValue: 'image' },
      is_active:  { type: S.TINYINT, defaultValue: 1 },
      ...createdTs,
    });

    // ---- projects (self-ref parent_project_id, no FK) ----
    await queryInterface.createTable('projects', {
      id:                pk(),
      uid:               uid(),
      user_id:           fk('users'),
      business_id:       fk('businesses', { allowNull: true, onDelete: 'SET NULL' }),
      template_id:       fk('templates', { allowNull: true, onDelete: 'SET NULL' }),
      parent_project_id: { type: S.INTEGER, allowNull: true },
      size_id:           fk('template_sizes', { allowNull: true, onDelete: 'SET NULL' }),
      name:              { type: S.STRING(200), allowNull: false },
      content:           { type: S.TEXT('long'), allowNull: true },
      thumbnail_s3_key:  { type: S.STRING(500), allowNull: true },
      status:            { type: S.ENUM('draft', 'published', 'archived'), defaultValue: 'draft' },
      ...bothTs,
    });

    // ---- project_exports ----
    await queryInterface.createTable('project_exports', {
      id:              pk(),
      uid:             uid(),
      project_id:      fk('projects'),
      user_id:         fk('users'),
      export_type:     { type: S.ENUM('download', 'share'), allowNull: false },
      platform:        { type: S.ENUM('whatsapp', 'instagram', 'facebook', 'direct'), allowNull: true },
      s3_key:          { type: S.STRING(500), allowNull: true },
      file_size_bytes: { type: S.BIGINT, allowNull: true },
      status:          { type: S.ENUM('pending', 'success', 'failed'), defaultValue: 'pending' },
      ...createdTs,
    });

    // ---- plans ----
    await queryInterface.createTable('plans', {
      id:            pk(),
      uid:           uid(),
      name:          { type: S.STRING(100), allowNull: false },
      description:   { type: S.TEXT, allowNull: true },
      is_free:       { type: S.TINYINT, defaultValue: 0 },
      is_popular:    { type: S.TINYINT, defaultValue: 0 },
      status:        { type: S.ENUM('active', 'inactive'), defaultValue: 'active' },
      display_order: { type: S.INTEGER, defaultValue: 0 },
      ...bothTs,
    });

    // ---- plan_billing_options ----
    await queryInterface.createTable('plan_billing_options', {
      id:               pk(),
      plan_id:          fk('plans'),
      billing_cycle:    { type: S.ENUM('monthly', 'annual'), allowNull: false },
      price:            { type: S.DECIMAL(10, 2), allowNull: false },
      discounted_price: { type: S.DECIMAL(10, 2), allowNull: true },
      discount_label:   { type: S.STRING(100), allowNull: true },
      currency:         { type: S.STRING(3), defaultValue: 'INR' },
      razorpay_plan_id: { type: S.STRING(100), allowNull: true },
      is_active:        { type: S.TINYINT, defaultValue: 1 },
      ...bothTs,
    });

    // ---- feature_types ----
    await queryInterface.createTable('feature_types', {
      id:           pk(),
      key:          { type: S.STRING(100), allowNull: false, unique: true },
      label:        { type: S.STRING(200), allowNull: false },
      description:  { type: S.TEXT, allowNull: true },
      reset_period: { type: S.ENUM('monthly', 'annual', 'never'), defaultValue: 'never' },
      data_type:    { type: S.ENUM('integer', 'boolean'), defaultValue: 'integer' },
      ...createdTs,
    });

    // ---- plan_features ----
    await queryInterface.createTable('plan_features', {
      id:              pk(),
      plan_id:         fk('plans'),
      feature_type_id: fk('feature_types'),
      value:           { type: S.INTEGER, allowNull: false, comment: '-1 = unlimited' },
      display_label:   { type: S.STRING(200), allowNull: true },
      display_order:   { type: S.INTEGER, defaultValue: 0 },
      show_on_card:    { type: S.TINYINT, defaultValue: 1 },
    });

    // ---- coupons ----
    await queryInterface.createTable('coupons', {
      id:              pk(),
      uid:             uid(),
      code:            { type: S.STRING(50), allowNull: false, unique: true },
      title:           { type: S.STRING(200), allowNull: false },
      discount_type:   { type: S.ENUM('percentage', 'fixed'), allowNull: false },
      discount_value:  { type: S.DECIMAL(10, 2), allowNull: false },
      applicable_to:   { type: S.ENUM('all_plans', 'specific_plans'), defaultValue: 'all_plans' },
      target_audience: { type: S.ENUM('all', 'new_users', 'existing_users'), defaultValue: 'all' },
      max_uses:        { type: S.INTEGER, allowNull: true },
      used_count:      { type: S.INTEGER, defaultValue: 0 },
      valid_from:      { type: S.DATE, allowNull: false },
      valid_to:        { type: S.DATE, allowNull: true },
      status:          { type: S.ENUM('active', 'inactive', 'expired'), defaultValue: 'active' },
      ...bothTs,
    });

    // ---- coupon_plan_restrictions ----
    await queryInterface.createTable('coupon_plan_restrictions', {
      id:        pk(),
      coupon_id: fk('coupons'),
      plan_id:   fk('plans'),
    });

    // ---- user_subscriptions ----
    await queryInterface.createTable('user_subscriptions', {
      id:                       pk(),
      uid:                      uid(),
      user_id:                  fk('users'),
      plan_id:                  fk('plans', { onDelete: 'RESTRICT' }),
      plan_billing_option_id:   fk('plan_billing_options', { onDelete: 'RESTRICT' }),
      coupon_id:                fk('coupons', { allowNull: true, onDelete: 'SET NULL' }),
      status:                   { type: S.ENUM('active', 'overridden', 'cancelled', 'expired'), defaultValue: 'active' },
      starts_at:                { type: S.DATE, allowNull: false },
      ends_at:                  { type: S.DATE, allowNull: false },
      cancelled_at:             { type: S.DATE, allowNull: true },
      auto_renew:               { type: S.TINYINT, defaultValue: 1 },
      amount_paid:              { type: S.DECIMAL(10, 2), allowNull: false },
      razorpay_subscription_id: { type: S.STRING(100), allowNull: true },
      ...bothTs,
    });

    // ---- payments ----
    await queryInterface.createTable('payments', {
      id:                  pk(),
      uid:                 uid(),
      user_id:             fk('users'),
      subscription_id:     fk('user_subscriptions', { allowNull: true, onDelete: 'SET NULL' }),
      order_type:          { type: S.ENUM('subscription', 'one_time'), defaultValue: 'subscription' },
      amount:              { type: S.DECIMAL(10, 2), allowNull: false },
      amount_before_tax:   { type: S.DECIMAL(10, 2), allowNull: false },
      gst_rate:            { type: S.DECIMAL(5, 2), defaultValue: 18 },
      gst_amount:          { type: S.DECIMAL(10, 2), allowNull: false },
      currency:            { type: S.STRING(3), defaultValue: 'INR' },
      status:              { type: S.ENUM('pending', 'success', 'failed', 'refunded'), defaultValue: 'pending' },
      razorpay_order_id:   { type: S.STRING(100), allowNull: true },
      razorpay_payment_id: { type: S.STRING(100), allowNull: true },
      razorpay_signature:  { type: S.STRING(500), allowNull: true },
      failure_reason:      { type: S.TEXT, allowNull: true },
      paid_at:             { type: S.DATE, allowNull: true },
      ...bothTs,
    });

    // ---- user_quota_usage ----
    await queryInterface.createTable('user_quota_usage', {
      id:                   pk(),
      user_id:              { type: S.INTEGER, allowNull: false, unique: true, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      storage_used_bytes:   { type: S.BIGINT, defaultValue: 0 },
      ai_credits_used:      { type: S.INTEGER, defaultValue: 0 },
      downloads_count:      { type: S.INTEGER, defaultValue: 0 },
      shares_count:         { type: S.INTEGER, defaultValue: 0 },
      template_views_count: { type: S.INTEGER, defaultValue: 0 },
      period_start:         { type: S.DATEONLY, allowNull: true },
      period_end:           { type: S.DATEONLY, allowNull: true },
      ...updatedTs,
    });

    // ---- user_billing_details ----
    await queryInterface.createTable('user_billing_details', {
      id:              pk(),
      user_id:         { type: S.INTEGER, allowNull: false, unique: true, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      billing_name:    { type: S.STRING(200), allowNull: false },
      gstin:           { type: S.STRING(15), allowNull: true },
      billing_address: { type: S.TEXT, allowNull: false },
      billing_state:   { type: S.STRING(100), allowNull: false },
      billing_pincode: { type: S.STRING(10), allowNull: false },
      ...updatedTs,
    });

    // ---- faq_categories ----
    await queryInterface.createTable('faq_categories', {
      id:            pk(),
      uid:           uid(),
      name:          { type: S.STRING(100), allowNull: false },
      display_order: { type: S.INTEGER, defaultValue: 0 },
      status:        { type: S.ENUM('active', 'inactive'), defaultValue: 'active' },
      ...bothTs,
    });

    // ---- faqs ----
    await queryInterface.createTable('faqs', {
      id:            pk(),
      uid:           uid(),
      category_id:   fk('faq_categories', { allowNull: true, onDelete: 'SET NULL' }),
      question:      { type: S.TEXT, allowNull: false },
      answer:        { type: S.TEXT('long'), allowNull: false },
      display_order: { type: S.INTEGER, defaultValue: 0 },
      status:        { type: S.ENUM('active', 'inactive'), defaultValue: 'active' },
      created_by:    { type: S.INTEGER, allowNull: true },
      updated_by:    { type: S.INTEGER, allowNull: true },
      ...bothTs,
    });

    // ---- testimonials ----
    await queryInterface.createTable('testimonials', {
      id:                   pk(),
      uid:                  uid(),
      name:                 { type: S.STRING(100), allowNull: false },
      designation:          { type: S.STRING(200), allowNull: true },
      business_category_id: fk('business_categories', { allowNull: true, onDelete: 'SET NULL' }),
      content:              { type: S.TEXT, allowNull: false },
      rating:               { type: S.TINYINT, allowNull: true },
      photo_s3_key:         { type: S.STRING(500), allowNull: true },
      display_order:        { type: S.INTEGER, defaultValue: 0 },
      status:               { type: S.ENUM('active', 'inactive'), defaultValue: 'active' },
      ...bothTs,
    });

    // ---- app_banners ----
    await queryInterface.createTable('app_banners', {
      id:              pk(),
      uid:             uid(),
      title:           { type: S.STRING(200), allowNull: false },
      message:         { type: S.TEXT, allowNull: false },
      cta_label:       { type: S.STRING(100), allowNull: true },
      cta_url:         { type: S.STRING(500), allowNull: true },
      banner_type:     { type: S.ENUM('info', 'warning', 'promo', 'maintenance'), defaultValue: 'info' },
      target_audience: { type: S.ENUM('all', 'free_users', 'paid_users'), defaultValue: 'all' },
      starts_at:       { type: S.DATE, allowNull: false },
      ends_at:         { type: S.DATE, allowNull: true },
      is_dismissible:  { type: S.TINYINT, defaultValue: 1 },
      status:          { type: S.ENUM('active', 'inactive'), defaultValue: 'active' },
      ...bothTs,
    });

    // ---- app_settings ----
    await queryInterface.createTable('app_settings', {
      id:          pk(),
      key:         { type: S.STRING(100), allowNull: false, unique: true },
      value:       { type: S.TEXT, allowNull: true },
      type:        { type: S.ENUM('string', 'integer', 'boolean', 'json'), defaultValue: 'string' },
      description: { type: S.TEXT, allowNull: true },
      group:       { type: S.STRING(50), allowNull: true },
      is_public:   { type: S.TINYINT, defaultValue: 0 },
      updated_by:  { type: S.INTEGER, allowNull: true },
      ...updatedTs,
    });

    // ---- secondary indexes ----
    const addIndex = (table, fields, opts = {}) => queryInterface.addIndex(table, fields, opts);

    // self-referential parents
    await addIndex('business_categories', ['parent_id']);
    await addIndex('template_categories', ['parent_id']);
    await addIndex('asset_categories', ['parent_id']);
    await addIndex('projects', ['parent_project_id']);

    // auth / cleanup hot paths
    await addIndex('user_sessions', ['actor_type', 'actor_id']);
    await addIndex('user_sessions', ['expires_at']);
    await addIndex('token_blacklist', ['expires_at']);
    await addIndex('otp_codes', ['phone']);
    await addIndex('otp_codes', ['expires_at']);

    // trending job + template browse
    await addIndex('activity_logs', ['entity_type', 'entity_id']);
    await addIndex('activity_logs', ['action', 'created_at']);
    await addIndex('templates', ['status', 'trending_score']);
    await addIndex('templates', ['is_premium']);

    // subscription lookups
    await addIndex('user_subscriptions', ['user_id', 'status']);
    await addIndex('user_subscriptions', ['ends_at']);
    await addIndex('payments', ['razorpay_order_id']);
    await addIndex('payments', ['razorpay_payment_id']);

    // unique pair guards on join tables
    await addIndex('business_category_tags', ['category_id', 'tag_id'], { unique: true, name: 'uq_biz_cat_tag' });
    await addIndex('template_tags', ['template_id', 'tag_id'], { unique: true, name: 'uq_template_tag' });
    await addIndex('template_size_map', ['template_id', 'size_id'], { unique: true, name: 'uq_template_size' });
    await addIndex('theme_templates', ['theme_id', 'template_id'], { unique: true, name: 'uq_theme_template' });
    await addIndex('template_business_categories', ['template_id', 'business_category_id'], { unique: true, name: 'uq_tpl_bizcat' });
    await addIndex('asset_tags', ['asset_id', 'tag_id'], { unique: true, name: 'uq_asset_tag' });
    await addIndex('special_event_templates', ['event_id', 'template_id'], { unique: true, name: 'uq_event_template' });
    await addIndex('coupon_plan_restrictions', ['coupon_id', 'plan_id'], { unique: true, name: 'uq_coupon_plan' });
    await addIndex('plan_features', ['plan_id', 'feature_type_id'], { unique: true, name: 'uq_plan_feature' });
  },

  async down(queryInterface) {
    const tables = [
      'app_settings', 'app_banners', 'testimonials', 'faqs', 'faq_categories',
      'user_billing_details', 'user_quota_usage', 'payments', 'user_subscriptions',
      'coupon_plan_restrictions', 'coupons', 'plan_features', 'feature_types',
      'plan_billing_options', 'plans', 'project_exports', 'projects', 'user_frames',
      'special_event_templates', 'special_events', 'asset_tags', 'assets', 'asset_categories',
      'template_business_categories', 'theme_templates', 'themes', 'theme_groups',
      'template_size_map', 'template_sizes', 'template_tags', 'templates', 'template_categories',
      'product_images', 'products', 'businesses', 'business_category_tags', 'tags',
      'business_categories', 'activity_logs', 'failed_login_attempts', 'otp_codes',
      'token_blacklist', 'user_sessions', 'admin_users', 'users', 'roles',
    ];
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of tables) {
      await queryInterface.dropTable(t);
    }
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  },
};
