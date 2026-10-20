import { before, after, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

const PROJECT_ID = "cam-hubs-subscription-rules";
const OWNER = "owner-uid";
const DEVICE = "device-abc";

let env: RulesTestEnvironment;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

after(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "devices", DEVICE), {
      ownerUserId: OWNER,
      displayName: "Front Door",
      premiumActive: false,
    });
    await setDoc(doc(db, "devices", "camera-new"), { ownerUserId: OWNER, displayName: "New Camera" });
    await setDoc(doc(db, "subscriptions", DEVICE), {
      premium: true,
      status: "active",
      originalTransactionId: "otx-1",
      environment: "Production",
    });
    await setDoc(doc(db, "detectionSettings", DEVICE), {
      motionDetectionEnabled: true,
      detectionAuthorizedBy: DEVICE,
    });
  });
});

function ownerDb() {
  return env.authenticatedContext(OWNER).firestore();
}

test("owner may read their own device entitlement", async () => {
  await assertSucceeds(getDoc(doc(ownerDb(), "subscriptions", DEVICE)));
});

test("a different signed-in user CANNOT read another device's entitlement", async () => {
  const outsiderDb = env.authenticatedContext("outsider-uid").firestore();
  await assertFails(getDoc(doc(outsiderDb, "subscriptions", DEVICE)));
});

test("owner CANNOT write the premium flag on their entitlement record", async () => {
  await assertFails(updateDoc(doc(ownerDb(), "subscriptions", DEVICE), { premium: true }));
});

test("owner CANNOT create an entitlement record (server writes it via Admin SDK)", async () => {
  await assertFails(setDoc(doc(ownerDb(), "subscriptions", "device-new"), { premium: true }));
});

test("owner CANNOT forge the subscription identity fields", async () => {
  await assertFails(
    updateDoc(doc(ownerDb(), "subscriptions", DEVICE), { originalTransactionId: "forged" })
  );
});

test("owner CANNOT grant themselves premiumActive on their device", async () => {
  await assertFails(updateDoc(doc(ownerDb(), "devices", DEVICE), { premiumActive: true }));
});

test("owner CAN still rename their device", async () => {
  await assertSucceeds(updateDoc(doc(ownerDb(), "devices", DEVICE), { displayName: "Garage" }));
});

test("a client CANNOT repoint detectionAuthorizedBy at a device it does not own — the privilege-escalation guard", async () => {
  await assertFails(
    updateDoc(doc(ownerDb(), "detectionSettings", DEVICE), {
      detectionAuthorizedBy: "someone-elses-premium-device",
    })
  );
});

test("a client CANNOT write detectionAuthorizedAt", async () => {
  await assertFails(
    updateDoc(doc(ownerDb(), "detectionSettings", DEVICE), { detectionAuthorizedAt: Date.now() })
  );
});

test("a client CANNOT create detection settings that name an authorizer", async () => {
  await assertFails(
    setDoc(doc(ownerDb(), "detectionSettings", "camera-new"), {
      motionDetectionEnabled: true,
      detectionAuthorizedBy: DEVICE,
    })
  );
});

test("a client CAN still write the non-authorization detection settings", async () => {
  await assertSucceeds(
    updateDoc(doc(ownerDb(), "detectionSettings", DEVICE), { motionDetectionEnabled: false })
  );
});

test("a client CAN create detection settings without an authorizer", async () => {
  await assertSucceeds(
    setDoc(doc(ownerDb(), "detectionSettings", "camera-new"), { motionDetectionEnabled: true })
  );
});
