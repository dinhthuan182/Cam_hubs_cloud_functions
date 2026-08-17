import { test } from "node:test";
import assert from "node:assert/strict";
import { selectBodyLocKey, eligibleRecipientToken } from "../src/notification";

test("selectBodyLocKey maps each visual category to its body key (008)", () => {
  assert.equal(selectBodyLocKey("person", "motion"), "notification.body.person");
  assert.equal(selectBodyLocKey("pet", "motion"), "notification.body.pet");
  assert.equal(selectBodyLocKey("vehicle", "motion"), "notification.body.vehicle");
  assert.equal(selectBodyLocKey("otherMotion", "motion"), "notification.body.otherMotion");
});

test("selectBodyLocKey falls back to 006 keys for a legacy (no-category) event", () => {
  assert.equal(selectBodyLocKey(undefined, "motion"), "notification.body.motion");
  assert.equal(selectBodyLocKey(undefined, "sound"), "notification.body.sound");
});

test("a sound-category event resolves to the sound body via the eventType fallback", () => {
  assert.equal(selectBodyLocKey("sound", "sound"), "notification.body.sound");
});

test("a non-premium recipient is excluded (021 US5)", () => {
  assert.equal(
    eligibleRecipientToken(
      { premiumActive: false, fcmToken: "tok-1" },
      "cam-1"
    ),
    undefined
  );
  assert.equal(
    eligibleRecipientToken({ fcmToken: "tok-1" }, "cam-1"),
    undefined
  );
});

test("a premium recipient with a token is eligible", () => {
  assert.equal(
    eligibleRecipientToken(
      { premiumActive: true, fcmToken: "tok-1" },
      "cam-1"
    ),
    "tok-1"
  );
});

test("premium recipients are still filtered by watching + token", () => {
  assert.equal(
    eligibleRecipientToken(
      { premiumActive: true, activelyWatchingCameraId: "cam-1", fcmToken: "tok-1" },
      "cam-1"
    ),
    undefined
  );
  assert.equal(
    eligibleRecipientToken({ premiumActive: true, fcmToken: "" }, "cam-1"),
    undefined
  );
});
