const { ForbiddenError, ValidationError } = require('../errors');
const { tokensIn } = require('../utils/renderTemplate');
const notificationService = require('./notification.service');

// The server-side write gate for /admin/notification-templates, in the same role
// framePublish.js plays for frames: rules the Joi schema cannot express, enforced
// where a direct PATCH cannot bypass them.

// 1. FREEZE the identity of a seeded row.
//
// `code` is the contract between the row and the service call site that dispatches
// it, AND it prefixes every dedupe_key already written for that notification — so
// renaming it both silences the trigger and orphans every user's history, with no
// error anywhere. `trigger_type` decides which job owns the row, so flipping it
// strands the template where nothing scans for it. `trigger_config` is the
// parameters for that frozen trigger (which date, how many days), so it moves with
// it.
//
// Copy, CTA, imagery, audience, throttle and the active toggle all stay editable:
// those are exactly what the admin panel exists to change.
const FROZEN_ON_SYSTEM = ['code', 'trigger_type', 'trigger_config'];

// 2. Own the `{{placeholder}}` contract, so an admin never has to.
//
// This used to demand that the admin hand-maintain a `variables` list matching the
// copy exactly, in both directions, and rejected the save if it drifted. That put
// the burden in the wrong place: the set of values a trigger can supply is fixed
// by the CODE that dispatches it, not by whoever is editing the wording.
//
// So `variables` is now a SUPPLY LIST, owned by the server:
//
//   - system templates: seeded, immutable. It states what this notification's
//     trigger passes in. The admin's copy may use any subset of it — including
//     none, if they want simpler wording — but may not invent a new one.
//   - admin-authored templates: derived from the copy on every write. A manual
//     template has no trigger feeding it, so whatever it mentions is all there is,
//     and the campaign path refuses placeholders anyway.
//
// The error an admin can still hit now names what IS available, instead of telling
// them they failed to declare something they never knew they had to.

function _assertPlaceholdersSupported(title, body, supply, code) {
  const used    = [...new Set([...tokensIn(title), ...tokensIn(body)])];
  const allowed = new Set(supply || []);
  const unknown = used.filter((t) => !allowed.has(t));

  if (unknown.length) {
    throw new ValidationError(
      `This notification cannot fill ${unknown.map((u) => `{{${u}}}`).join(', ')}. ` +
      (allowed.size
        ? `Available placeholders for '${code}': ${[...allowed].map((a) => `{{${a}}}`).join(', ')}.`
        : `'${code}' has no placeholders available — write the message as plain text.`),
    );
  }
}

async function assertTemplateWritable(payload, row) {
  const isSystem = row ? Number(row.is_system) === 1 : false;

  if (row) {
    if (isSystem) {
      for (const field of FROZEN_ON_SYSTEM) {
        if (payload[field] === undefined) continue;
        // trigger_config is an object; compare by value, not identity.
        const before = field === 'trigger_config' ? JSON.stringify(row[field] || null) : String(row[field]);
        const after  = field === 'trigger_config' ? JSON.stringify(payload[field] || null) : String(payload[field]);
        if (before !== after) {
          throw new ForbiddenError(
            `'${field}' is locked on a built-in notification — it is wired to application ` +
            'logic and to notifications already sent. The message, button, audience and ' +
            'frequency are all editable.',
          );
        }
      }
    }
  } else if (!payload.code) {
    throw new ValidationError('A notification template needs a code');
  }

  // Evaluate against the row as it will be AFTER the write, not just the patch:
  // editing only the body still has to agree with the supply list.
  const title = payload.title !== undefined ? payload.title : row?.title;
  const body  = payload.body  !== undefined ? payload.body  : row?.body;

  if (isSystem) {
    // Immutable supply list. `variables` is not in the admin schema, so it cannot
    // arrive in the payload — this reads the stored list and validates against it.
    _assertPlaceholdersSupported(title, body, row.variables, row.code);
  } else {
    // Derived. Whatever the copy mentions IS the contract for a manual template.
    payload.variables = [...new Set([...tokensIn(title), ...tokensIn(body)])];
  }

  // Defaults may only cover placeholders that exist, otherwise they are dead
  // config that silently does nothing.
  if (payload.variable_defaults) {
    const supply = new Set(isSystem ? (row.variables || []) : payload.variables);
    const stray  = Object.keys(payload.variable_defaults).filter((k) => !supply.has(k));
    if (stray.length) {
      throw new ValidationError(
        `Default value(s) for ${stray.join(', ')} do not match any placeholder in this message.`,
      );
    }
  }

  // The catalogue is cached for a minute in the send path; drop it so an edit is
  // live immediately rather than "sometime in the next minute", which is the kind
  // of thing that makes an admin press Save four times.
  notificationService.invalidateTemplateCache();
}

module.exports = { assertTemplateWritable, FROZEN_ON_SYSTEM };
