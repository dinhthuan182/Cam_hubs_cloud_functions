import { after, before, beforeEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "cam-hubs-access-rules";
const FIRESTORE_RULES = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");
const STORAGE_RULES = readFileSync(resolve(__dirname, "../../storage.rules"), "utf8");

const CAM_OWNER = "cam-owner-uid";
const VIEWER_OWNER = "viewer-owner-uid";
const STRANGER = "stranger-uid";
const CAM = "cam-x";
const CAM2 = "cam-z";
const VIEWER = "viewer-y";
const STRANGER_DEV = "stranger-d";
const STRANGER_DEV2 = "stranger-d2";

let env: RulesTestEnvironment;

function db(uid: string) {
  return env.authenticatedContext(uid).firestore();
}

function storage(uid: string) {
  return env.authenticatedContext(uid).storage();
}

async function seedFirestore() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const admin = ctx.firestore();
    const device = (id: string, owner: string, editors: string[]) =>
      setDoc(doc(admin, "devices", id), {
        ownerUserId: owner,
        displayName: id,
        platform: "iPhone",
        pairingToken: `token-${id}`,
        fcmToken: `fcm-${id}`,
        editorUserIds: editors,
      });
    await device(CAM, CAM_OWNER, [VIEWER_OWNER]);
    await device(CAM2, CAM_OWNER, [VIEWER_OWNER]);
    await device(VIEWER, VIEWER_OWNER, [CAM_OWNER]);
    await device(STRANGER_DEV, STRANGER, [STRANGER]);
    await device(STRANGER_DEV2, STRANGER, [STRANGER]);
    const pairing = (id: string, a: string, b: string) =>
      setDoc(doc(admin, "pairings", id), { deviceA: a, deviceB: b, memberDeviceIds: [a, b], status: "active" });
    await pairing(`${CAM}_${VIEWER}`, CAM, VIEWER);
    await pairing(`${CAM2}_${VIEWER}`, CAM2, VIEWER);
    await pairing(`${STRANGER_DEV}_${STRANGER_DEV2}`, STRANGER_DEV, STRANGER_DEV2);
    await setDoc(doc(admin, "signalingSessions", "s1"), { sessionId: "s1", cameraDeviceId: CAM, status: "live" });
    await setDoc(doc(admin, "signalingConnections", "s1_viewer-y_abc"), {
      connectionId: "s1_viewer-y_abc",
      sessionId: "s1",
      cameraDeviceId: CAM,
      viewerDeviceId: VIEWER,
      viewerUserId: VIEWER_OWNER,
      status: "waiting",
      cameraIceCandidates: [],
      viewerIceCandidates: [],
    });
    const event = (id: string, camera: string) =>
      setDoc(doc(admin, "cameraEvents", id), {
        cameraDeviceId: camera,
        eventType: "motion",
        detectedAt: Timestamp.now(),
        sensitivityLevel: 0.5,
        ttlExpiry: Timestamp.fromMillis(Date.now() + 86_400_000),
        clipState: "available",
        storagePath: `clips/${camera}/${id}.mp4`,
      });
    await event("e1", CAM);
    await event("e2", CAM2);
    await setDoc(doc(admin, "detectionSettings", CAM), {
      motionDetectionEnabled: true,
      enabledCategories: ["person"],
      detectionAuthorizedBy: CAM,
    });
    await setDoc(doc(admin, "subscriptions", CAM), { premium: true });
    await setDoc(doc(admin, "users", VIEWER_OWNER), { premium: true });
    await setDoc(doc(admin, "users", STRANGER), { premium: true });
  });
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: FIRESTORE_RULES, host: "127.0.0.1", port: 8080 },
    storage: { rules: STORAGE_RULES, host: "127.0.0.1", port: 9199 },
  });
});

after(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await env.cleanup();
});

describe("devices", () => {
  beforeEach(seedFirestore);

  test("an owner creates its device with the app's merge shape", () =>
    assertSucceeds(
      setDoc(
        doc(db(VIEWER_OWNER), "devices", "viewer-new"),
        {
          ownerUserId: VIEWER_OWNER,
          displayName: "iPad",
          platform: "iPad",
          pairingToken: "t",
          isStreaming: false,
          lastSeenAt: serverTimestamp(),
        },
        { merge: true }
      )
    ));

  test("bootstrap may read its own device id before the doc exists", () =>
    assertSucceeds(getDoc(doc(db(VIEWER_OWNER), "devices", "not-created-yet"))));

  test("a paired user reads the camera's device doc and may rename it", async () => {
    await assertSucceeds(getDoc(doc(db(VIEWER_OWNER), "devices", CAM)));
    await assertSucceeds(updateDoc(doc(db(VIEWER_OWNER), "devices", CAM), { displayName: "Kitchen" }));
  });

  test("a stranger cannot read a device doc or list devices", async () => {
    await assertFails(getDoc(doc(db(STRANGER), "devices", CAM)));
    await assertFails(getDocs(collection(db(STRANGER), "devices")));
    await assertFails(getDocs(query(collection(db(STRANGER), "devices"), where("pairingToken", "==", `token-${CAM}`))));
  });

  test("an owner cannot grant itself premium or editors", async () => {
    await assertFails(updateDoc(doc(db(CAM_OWNER), "devices", CAM2), { premiumActive: true }));
    await assertFails(updateDoc(doc(db(STRANGER), "devices", STRANGER_DEV), { editorUserIds: [STRANGER, "x"] }));
    await assertFails(
      setDoc(doc(db(STRANGER), "devices", "new-dev"), { ownerUserId: STRANGER, editorUserIds: [CAM_OWNER] })
    );
  });
});

describe("pairings", () => {
  beforeEach(seedFirestore);

  test("a client cannot create a pairing, even for its own device", async () => {
    await assertFails(
      setDoc(doc(db(STRANGER), "pairings", `${CAM}_${STRANGER_DEV}`), {
        deviceA: CAM,
        deviceB: STRANGER_DEV,
        memberDeviceIds: [CAM, STRANGER_DEV],
        status: "active",
      })
    );
    await assertFails(
      setDoc(doc(db(STRANGER), "pairings", "spoofed"), {
        deviceA: STRANGER_DEV,
        deviceB: STRANGER_DEV2,
        memberDeviceIds: [CAM, STRANGER_DEV],
        status: "active",
      })
    );
  });

  test("a member unpairs but cannot re-activate or rewrite membership", async () => {
    const own = doc(db(STRANGER), "pairings", `${STRANGER_DEV}_${STRANGER_DEV2}`);
    await assertFails(updateDoc(own, { memberDeviceIds: [CAM, STRANGER_DEV] }));
    await assertFails(updateDoc(own, { deviceA: CAM }));
    await assertSucceeds(updateDoc(own, { status: "removed" }));
    await assertFails(updateDoc(own, { status: "active" }));
  });

  test("a non-member cannot unpair someone else's pairing", () =>
    assertFails(updateDoc(doc(db(STRANGER), "pairings", `${CAM}_${VIEWER}`), { status: "removed" })));

  test("a member lists its active pairings with the app's query", () =>
    assertSucceeds(
      getDocs(
        query(
          collection(db(VIEWER_OWNER), "pairings"),
          where("memberDeviceIds", "array-contains", VIEWER),
          where("status", "==", "active")
        )
      )
    ));
});

describe("signaling", () => {
  beforeEach(seedFirestore);

  test("the camera creates, heartbeats and deletes its session", async () => {
    const ref = doc(db(CAM_OWNER), "signalingSessions", "s-new");
    await assertSucceeds(
      setDoc(ref, { sessionId: "s-new", cameraDeviceId: CAM2, status: "starting", startedAt: serverTimestamp() })
    );
    await assertSucceeds(updateDoc(ref, { lastHeartbeatAt: serverTimestamp(), status: "live" }));
    await assertSucceeds(deleteDoc(ref));
  });

  test("a camera cannot move its session onto another camera id", async () => {
    const ref = doc(db(STRANGER), "signalingSessions", "s-evil");
    await assertSucceeds(setDoc(ref, { sessionId: "s-evil", cameraDeviceId: STRANGER_DEV, status: "live" }));
    await assertFails(updateDoc(ref, { cameraDeviceId: CAM }));
  });

  test("a paired viewer finds the live session with the app's query", async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(db(VIEWER_OWNER), "signalingSessions"),
          where("cameraDeviceId", "==", CAM),
          where("status", "==", "live")
        )
      )
    );
    await assertSucceeds(getDoc(doc(db(VIEWER_OWNER), "signalingSessions", "s1")));
  });

  test("a stranger cannot find or read a camera's sessions", async () => {
    await assertFails(
      getDocs(query(collection(db(STRANGER), "signalingSessions"), where("status", "==", "live")))
    );
    await assertFails(
      getDocs(
        query(
          collection(db(STRANGER), "signalingSessions"),
          where("cameraDeviceId", "==", CAM),
          where("status", "==", "live")
        )
      )
    );
    await assertFails(getDoc(doc(db(STRANGER), "signalingSessions", "s1")));
  });

  test("a paired viewer connects: create, camera offer, viewer answer, camera delete", async () => {
    const id = "s1_viewer-y_new";
    await assertSucceeds(
      setDoc(doc(db(VIEWER_OWNER), "signalingConnections", id), {
        connectionId: id,
        sessionId: "s1",
        cameraDeviceId: CAM,
        viewerDeviceId: VIEWER,
        viewerUserId: VIEWER_OWNER,
        status: "waiting",
        cameraIceCandidates: [],
        viewerIceCandidates: [],
      })
    );
    await assertSucceeds(
      getDocs(
        query(
          collection(db(CAM_OWNER), "signalingConnections"),
          where("sessionId", "==", "s1"),
          where("status", "==", "waiting")
        )
      )
    );
    await assertSucceeds(
      updateDoc(doc(db(CAM_OWNER), "signalingConnections", id), { offer: { sdp: "o", type: "offer" } })
    );
    await assertSucceeds(
      updateDoc(doc(db(VIEWER_OWNER), "signalingConnections", id), {
        answer: { sdp: "a", type: "answer" },
        status: "active",
        viewerIceCandidates: arrayUnion({ candidate: "c" }),
      })
    );
    await assertSucceeds(getDoc(doc(db(VIEWER_OWNER), "signalingConnections", id)));
    await assertSucceeds(deleteDoc(doc(db(CAM_OWNER), "signalingConnections", id)));
  });

  test("a stranger cannot join a camera's session", async () => {
    const base = {
      sessionId: "s1",
      viewerUserId: STRANGER,
      status: "waiting",
      cameraIceCandidates: [],
      viewerIceCandidates: [],
    };
    await assertFails(
      setDoc(doc(db(STRANGER), "signalingConnections", "s1_stranger_a"), {
        ...base,
        cameraDeviceId: CAM,
        viewerDeviceId: STRANGER_DEV,
      })
    );
    await assertFails(
      setDoc(doc(db(STRANGER), "signalingConnections", "s1_stranger_b"), {
        ...base,
        cameraDeviceId: STRANGER_DEV,
        viewerDeviceId: STRANGER_DEV,
      })
    );
  });

  test("a viewer cannot claim another device's viewerDeviceId", () =>
    assertFails(
      setDoc(doc(db(STRANGER), "signalingConnections", "s1_viewer-y_spoof"), {
        sessionId: "s1",
        cameraDeviceId: CAM,
        viewerDeviceId: VIEWER,
        viewerUserId: STRANGER,
        status: "waiting",
      })
    ));

  test("a stranger cannot read or list another camera's connections", async () => {
    await assertFails(getDoc(doc(db(STRANGER), "signalingConnections", "s1_viewer-y_abc")));
    await assertFails(
      getDocs(query(collection(db(STRANGER), "signalingConnections"), where("sessionId", "==", "s1")))
    );
  });

  test("a connection's identity fields are locked after create", async () => {
    const ref = doc(db(VIEWER_OWNER), "signalingConnections", "s1_viewer-y_abc");
    await assertFails(updateDoc(ref, { cameraDeviceId: CAM2 }));
    await assertFails(updateDoc(ref, { sessionId: "s2" }));
    await assertFails(updateDoc(ref, { viewerDeviceId: STRANGER_DEV }));
  });
});

describe("camera events", () => {
  beforeEach(seedFirestore);

  test("the camera writes an event and advances its clip, but not the event core", async () => {
    const ref = doc(db(CAM_OWNER), "cameraEvents", "e-new");
    await assertSucceeds(
      setDoc(ref, {
        cameraDeviceId: CAM,
        eventType: "motion",
        detectedAt: serverTimestamp(),
        sensitivityLevel: 0.5,
        ttlExpiry: Timestamp.fromMillis(Date.now() + 86_400_000),
        category: "person",
      })
    );
    await assertSucceeds(setDoc(ref, { clipState: "recording", durationMs: 0, favorite: false }, { merge: true }));
    await assertSucceeds(updateDoc(ref, { clipState: "available", storagePath: `clips/${CAM}/e-new.mp4` }));
    await assertFails(updateDoc(ref, { eventType: "sound" }));
  });

  test("a stranger cannot write events for someone else's camera", () =>
    assertFails(
      setDoc(doc(db(STRANGER), "cameraEvents", "forged"), {
        cameraDeviceId: CAM,
        eventType: "motion",
        detectedAt: serverTimestamp(),
      })
    ));

  test("a paired viewer runs the app's event query across its cameras", () =>
    assertSucceeds(
      getDocs(
        query(
          collection(db(VIEWER_OWNER), "cameraEvents"),
          where("cameraDeviceId", "in", [CAM, CAM2]),
          where("detectedAt", ">=", Timestamp.fromMillis(Date.now() - 86_400_000)),
          orderBy("detectedAt", "desc")
        )
      )
    ));

  test("a paired viewer reads a clip doc and favourites it", async () => {
    await assertSucceeds(getDoc(doc(db(VIEWER_OWNER), "cameraEvents", "e1")));
    await assertSucceeds(updateDoc(doc(db(VIEWER_OWNER), "cameraEvents", "e1"), { favorite: true }));
  });

  test("a stranger cannot read, query or favourite another camera's events", async () => {
    await assertFails(getDoc(doc(db(STRANGER), "cameraEvents", "e1")));
    await assertFails(getDocs(query(collection(db(STRANGER), "cameraEvents"), where("cameraDeviceId", "==", CAM))));
    await assertFails(
      getDocs(query(collection(db(STRANGER), "cameraEvents"), where("cameraDeviceId", "in", [CAM, STRANGER_DEV])))
    );
    await assertFails(updateDoc(doc(db(STRANGER), "cameraEvents", "e1"), { favorite: true }));
  });
});

describe("detection settings", () => {
  beforeEach(seedFirestore);

  test("a paired viewer reads and edits settings with the app's merge shape", async () => {
    await assertSucceeds(getDoc(doc(db(VIEWER_OWNER), "detectionSettings", CAM)));
    await assertSucceeds(
      setDoc(
        doc(db(VIEWER_OWNER), "detectionSettings", CAM),
        {
          motionDetectionEnabled: true,
          soundDetectionEnabled: false,
          motionSensitivity: 0.5,
          soundSensitivity: 0.5,
          cooldownSeconds: 30,
          enabledCategories: ["person"],
          updatedAt: serverTimestamp(),
          activityZone: deleteField(),
        },
        { merge: true }
      )
    );
  });

  test("the camera owner creates settings for its own camera", () =>
    assertSucceeds(setDoc(doc(db(CAM_OWNER), "detectionSettings", CAM2), { motionDetectionEnabled: true })));

  test("a stranger cannot read, turn off or create another camera's settings", async () => {
    await assertFails(getDoc(doc(db(STRANGER), "detectionSettings", CAM)));
    await assertFails(
      updateDoc(doc(db(STRANGER), "detectionSettings", CAM), {
        motionDetectionEnabled: false,
        soundDetectionEnabled: false,
        enabledCategories: [],
      })
    );
    await assertFails(setDoc(doc(db(STRANGER), "detectionSettings", CAM2), { motionDetectionEnabled: false }));
  });

  test("settings for a camera with no device doc are denied", () =>
    assertFails(setDoc(doc(db(STRANGER), "detectionSettings", "no-such-camera"), { motionDetectionEnabled: true })));
});

describe("clip storage", () => {
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
  const upload = (uid: string, path: string, contentType: string) =>
    Promise.resolve().then(() => storage(uid).ref(path).put(bytes, { contentType }));

  before(async () => {
    await seedFirestore();
    await env.clearStorage();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.storage().ref(`clips/${CAM}/e1.mp4`).put(bytes, { contentType: "video/mp4" });
      await ctx.storage().ref(`clips/${CAM}/e1_thumb.jpg`).put(bytes, { contentType: "image/jpeg" });
    });
  });

  test("the camera owner uploads its clip and thumbnail", async () => {
    await assertSucceeds(upload(CAM_OWNER, `clips/${CAM}/e2.mp4`, "video/mp4"));
    await assertSucceeds(upload(CAM_OWNER, `clips/${CAM}/e2_thumb.jpg`, "image/jpeg"));
  });

  test("uploads must be an mp4 clip or a jpeg thumbnail", async () => {
    await assertFails(upload(CAM_OWNER, `clips/${CAM}/page.html`, "text/html"));
    await assertFails(upload(CAM_OWNER, `clips/${CAM}/page.html`, "video/mp4"));
    await assertFails(upload(CAM_OWNER, `clips/${CAM}/e3.mp4`, "text/html"));
    await assertFails(upload(CAM_OWNER, `clips/${CAM}/e3_thumb.jpg`, "image/png"));
  });

  test("a stranger cannot upload into another camera's folder", () =>
    assertFails(upload(STRANGER, `clips/${CAM}/x.mp4`, "video/mp4")));

  test("a premium paired viewer plays the clip", () =>
    assertSucceeds(storage(VIEWER_OWNER).ref(`clips/${CAM}/e1.mp4`).getMetadata()));

  test("a free reader of a camera it can view gets the thumbnail only", async () => {
    await assertSucceeds(storage(CAM_OWNER).ref(`clips/${CAM}/e1_thumb.jpg`).getMetadata());
    await assertFails(storage(CAM_OWNER).ref(`clips/${CAM}/e1.mp4`).getMetadata());
  });

  test("a stranger cannot read thumbnails, and premium does not unlock unpaired clips", async () => {
    await assertFails(storage(STRANGER).ref(`clips/${CAM}/e1_thumb.jpg`).getMetadata());
    await assertFails(storage(STRANGER).ref(`clips/${CAM}/e1.mp4`).getMetadata());
  });

  test("clients cannot delete clips", () =>
    assertFails(storage(CAM_OWNER).ref(`clips/${CAM}/e1.mp4`).delete()));
});
