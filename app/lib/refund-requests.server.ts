import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessons,
  modules,
  purchases,
  refundRequests,
  RefundRequestStatus,
  videoWatchEvents,
} from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;
const MAX_WATCHED_SECONDS = 2 * 60 * 60;

export type RefundIneligibleReason =
  | "no-purchase"
  | "already-requested"
  | "team-seat"
  | "window-closed"
  | "watched-too-much";

export type RefundOffer =
  | {
      eligible: true;
      purchaseId: number;
      amount: number;
      lastDayInWindow: string;
    }
  | { eligible: false; reason: RefundIneligibleReason };

// The Refund Window is counted in whole calendar days, not hours: someone who
// buys at 23:00 still gets the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfWindow(purchasedAt: string): string {
  const deadline = new Date(purchasedAt);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function hasRequestedRefundRequest(purchaseId: number) {
  return !!db
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, RefundRequestStatus.Requested)
      )
    )
    .get();
}

// Watched Time: the furthest point reached in each lesson's video, summed
// across the course, so rewatching a lesson does not count twice.
function getWatchedSeconds(userId: number, courseId: number) {
  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .innerJoin(lessons, eq(videoWatchEvents.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(
      and(eq(videoWatchEvents.userId, userId), eq(modules.courseId, courseId))
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

// A claimed Team Seat belongs to the team; the learner cannot hand it back.
function isClaimedTeamSeat(purchaseId: number) {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
}

/**
 * Whether the learner may raise a Refund Request for their Purchase of this
 * course right now, and for how much.
 */
export function getRefundOffer(userId: number, courseId: number): RefundOffer {
  const purchase = getLatestPurchase(userId, courseId);
  if (!purchase) return { eligible: false, reason: "no-purchase" };

  if (hasRequestedRefundRequest(purchase.id)) {
    return { eligible: false, reason: "already-requested" };
  }

  if (isClaimedTeamSeat(purchase.id)) {
    return { eligible: false, reason: "team-seat" };
  }

  const lastDayInWindow = lastDayOfWindow(purchase.createdAt);
  if (calendarDay(new Date()) > lastDayInWindow) {
    return { eligible: false, reason: "window-closed" };
  }

  if (getWatchedSeconds(userId, courseId) >= MAX_WATCHED_SECONDS) {
    return { eligible: false, reason: "watched-too-much" };
  }

  return {
    eligible: true,
    purchaseId: purchase.id,
    amount: purchase.amountPaid,
    lastDayInWindow,
  };
}
