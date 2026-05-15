"use strict";
// ─── Schwab OAuth ─────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANCELLABLE_STATUSES = void 0;
/** Statuses that represent a cancellable (still-open) order */
exports.CANCELLABLE_STATUSES = new Set([
    'AWAITING_PARENT_ORDER', 'AWAITING_CONDITION', 'AWAITING_STOP_CONDITION',
    'AWAITING_MANUAL_REVIEW', 'ACCEPTED', 'AWAITING_UR_OUT',
    'PENDING_ACTIVATION', 'QUEUED', 'WORKING',
]);
