import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getRefundOffer } from "./refund-requests.server";

let base: ReturnType<typeof seedBaseData>;

function buy({
  on = "2026-11-01T10:00:00",
  amountPaid = 6000,
}: { on?: string; amountPaid?: number } = {}) {
  return testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid,
      createdAt: new Date(on).toISOString(),
    })
    .returning()
    .get();
}

function today(when: string) {
  vi.setSystemTime(new Date(when));
}

describe("getRefundOffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers the amount the learner was charged, not the list price", () => {
    // List price is set on the course; a coupon brought the charge down.
    testDb
      .update(schema.courses)
      .set({ price: 10000 })
      .run();
    const purchase = buy({ amountPaid: 6000 });
    today("2026-11-03T12:00:00");

    expect(getRefundOffer(base.user.id, base.course.id)).toEqual({
      eligible: true,
      purchaseId: purchase.id,
      amount: 6000,
      lastDayInWindow: "2026-11-15",
    });
  });

  describe("the Refund Window", () => {
    it("still covers the 14th day after the Purchase, late in the evening", () => {
      buy({ on: "2026-11-01T23:00:00" });
      today("2026-11-15T23:59:00");

      expect(getRefundOffer(base.user.id, base.course.id)).toMatchObject({
        eligible: true,
      });
    });

    it("has closed on the 15th day after the Purchase", () => {
      buy({ on: "2026-11-01T10:00:00" });
      today("2026-11-16T00:01:00");

      expect(getRefundOffer(base.user.id, base.course.id)).toEqual({
        eligible: false,
        reason: "window-closed",
      });
    });
  });

  describe("an earlier Refund Request", () => {
    function request(purchaseId: number, status: schema.RefundRequestStatus) {
      testDb
        .insert(schema.refundRequests)
        .values({ purchaseId, status, reason: "Not what I expected." })
        .run();
    }

    it("blocks a new one while it is still Requested", () => {
      const purchase = buy();
      request(purchase.id, schema.RefundRequestStatus.Requested);
      today("2026-11-03T12:00:00");

      expect(getRefundOffer(base.user.id, base.course.id)).toEqual({
        eligible: false,
        reason: "already-requested",
      });
    });

    it("does not block a new one once Declined", () => {
      const purchase = buy();
      request(purchase.id, schema.RefundRequestStatus.Declined);
      today("2026-11-03T12:00:00");

      expect(getRefundOffer(base.user.id, base.course.id)).toMatchObject({
        eligible: true,
      });
    });
  });

  describe("Watched Time", () => {
    function addLesson(position: number) {
      const module =
        testDb.select().from(schema.modules).get() ??
        testDb
          .insert(schema.modules)
          .values({ courseId: base.course.id, title: "Module", position: 1 })
          .returning()
          .get();
      return testDb
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get();
    }

    function watch(lessonId: number, ...positions: number[]) {
      for (const positionSeconds of positions) {
        testDb
          .insert(schema.videoWatchEvents)
          .values({
            userId: base.user.id,
            lessonId,
            eventType: "progress",
            positionSeconds,
          })
          .run();
      }
    }

    it("adds up the furthest point reached in each lesson", () => {
      buy();
      const first = addLesson(1);
      const second = addLesson(2);
      // Rewatching the start of a lesson does not add time: 1h + 1h = 2h.
      watch(first.id, 600, 3600, 300);
      watch(second.id, 3600);
      today("2026-11-03T12:00:00");

      expect(getRefundOffer(base.user.id, base.course.id)).toEqual({
        eligible: false,
        reason: "watched-too-much",
      });
    });

    it("stays eligible just under 2 hours, however many lessons are complete", () => {
      buy();
      const first = addLesson(1);
      const second = addLesson(2);
      watch(first.id, 3600);
      watch(second.id, 3599);
      for (const lesson of [first, second]) {
        testDb
          .insert(schema.lessonProgress)
          .values({
            userId: base.user.id,
            lessonId: lesson.id,
            status: schema.LessonProgressStatus.Completed,
          })
          .run();
      }
      today("2026-11-03T12:00:00");

      expect(getRefundOffer(base.user.id, base.course.id)).toMatchObject({
        eligible: true,
      });
    });
  });

  it("is not eligible for a claimed Team Seat", () => {
    const purchase = buy();
    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        purchaseId: purchase.id,
        code: "SEAT-1",
        redeemedByUserId: base.user.id,
        redeemedAt: new Date("2026-11-02T09:00:00").toISOString(),
      })
      .run();
    today("2026-11-03T12:00:00");

    expect(getRefundOffer(base.user.id, base.course.id)).toEqual({
      eligible: false,
      reason: "team-seat",
    });
  });

  it("is not eligible without a Purchase", () => {
    expect(getRefundOffer(base.user.id, base.course.id)).toEqual({
      eligible: false,
      reason: "no-purchase",
    });
  });
});
