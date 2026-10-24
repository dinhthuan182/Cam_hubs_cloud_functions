import { after, before, beforeEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, Timestamp, updateDoc, where } from "firebase/firestore";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "cam-hubs-talklinks-rules";
const FIRESTORE_RULES = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");

const CAM_OWNER = "cam-owner-uid";
const W_OWNER = "watcher-owner-uid";
const T_OWNER = "talker-owner-uid";
const STRANGER = "stranger-uid";
const CAM = "cam-x";
const W = "viewer-w";
const T = "viewer-t";
const STRANGER_DEV = "stranger-d";
const LINK_ID = `S1_${T}_${W}`;

let env: RulesTestEnvironment;

function db(uid: string) {
  return env.authenticatedContext(uid).firestore();
}

function link(sessionId: string, talker: string, watcher: string) {
  return {
    linkId: `${sessionId}_${talker}_${watcher}`,
    sessionId,
    cameraDeviceId: CAM,
    talkerDeviceId: talker,
    watcherDeviceId: watcher,
    status: "waiting",
    offer: { sdp: "o", type: "offer" },
    watcherIceCandidates: [],
    talkerIceCandidates: [],
    createdAt: Timestamp.now(),
  };
}

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const admin = ctx.firestore();
    const device = (id: string, owner: string, editors: string[]) =>
      setDoc(doc(admin, "devices", id), {
        ownerUserId: owner,
        displayName: id,
        platform: "iPhone",
        pairingToken: `token-${id}`,
        editorUserIds: editors,
      });
    await device(CAM, CAM_OWNER, [W_OWNER, T_OWNER]);
    await device(W, W_OWNER, [CAM_OWNER]);
    await device(T, T_OWNER, [CAM_OWNER]);
    await device(STRANGER_DEV, STRANGER, [STRANGER]);
    await setDoc(doc(admin, "signalingSessions", "S1"), {
      sessionId: "S1",
      cameraDeviceId: CAM,
      status: "live",
      talkBackTalkers: { [T]: { startedAt: Timestamp.now() } },
    });
    await setDoc(doc(admin, "talkLinks", LINK_ID), link("S1", T, W));
  });
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: FIRESTORE_RULES, host: "127.0.0.1", port: 8080 },
  });
});

after(async () => {
  await env.clearFirestore();
  await env.cleanup();
});

describe("talkLinks create", () => {
  beforeEach(async () => {
    await seed();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), "talkLinks", LINK_ID));
    });
  });

  test("a watcher may create a link to a current talker", async () => {
    await assertSucceeds(setDoc(doc(db(W_OWNER), "talkLinks", LINK_ID), link("S1", T, W)));
  });

  test("a link to a device that is not talking is refused", () =>
    assertFails(setDoc(doc(db(W_OWNER), "talkLinks", `S1_X_${W}`), link("S1", "X", W))));

  test("a link is refused when the session has no talkers at all", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "signalingSessions", "S2"), {
        sessionId: "S2",
        cameraDeviceId: CAM,
        status: "live",
      });
    });
    await assertFails(setDoc(doc(db(W_OWNER), "talkLinks", `S2_${T}_${W}`), link("S2", T, W)));
  });

  test("a stranger cannot create a link as a watcher", () =>
    assertFails(setDoc(doc(db(STRANGER), "talkLinks", `S1_${T}_${STRANGER_DEV}`), link("S1", T, STRANGER_DEV))));

  test("creating as someone else's watcher device is refused", () =>
    assertFails(setDoc(doc(db(T_OWNER), "talkLinks", `S1_${T}_${W}`), link("S1", T, W))));

  test("a link to yourself is refused", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "signalingSessions", "S3"), {
        sessionId: "S3",
        cameraDeviceId: CAM,
        status: "live",
        talkBackTalkers: { [W]: { startedAt: Timestamp.now() } },
      });
    });
    await assertFails(setDoc(doc(db(W_OWNER), "talkLinks", `S3_${W}_${W}`), link("S3", W, W)));
  });

  test("a mismatched document id is refused", async () => {
    await assertFails(setDoc(doc(db(W_OWNER), "talkLinks", "other-id"), link("S1", T, W)));
    await assertFails(
      setDoc(doc(db(W_OWNER), "talkLinks", `S1_${T}_${W}_x`), { ...link("S1", T, W), linkId: "S1_wrong" })
    );
  });

  test("create requires waiting status, no answer and no talker candidates", async () => {
    const id = `S1_${T}_${W}`;
    await assertFails(setDoc(doc(db(W_OWNER), "talkLinks", id), { ...link("S1", T, W), status: "active" }));
    await assertFails(
      setDoc(doc(db(W_OWNER), "talkLinks", id), { ...link("S1", T, W), answer: { sdp: "a", type: "answer" } })
    );
    await assertFails(
      setDoc(doc(db(W_OWNER), "talkLinks", id), { ...link("S1", T, W), talkerIceCandidates: [{ c: "1" }] })
    );
    await assertSucceeds(setDoc(doc(db(W_OWNER), "talkLinks", id), link("S1", T, W)));
  });

  test("a camera id that differs from the session's camera is refused", () =>
    assertFails(
      setDoc(doc(db(W_OWNER), "talkLinks", `S1_${T}_${W}`), { ...link("S1", T, W), cameraDeviceId: STRANGER_DEV })
    ));
});

describe("talkLinks read, update and delete", () => {
  beforeEach(seed);

  test("talker and watcher can read and update; identity fields are frozen", async () => {
    await assertSucceeds(getDoc(doc(db(W_OWNER), "talkLinks", LINK_ID)));
    await assertSucceeds(getDoc(doc(db(T_OWNER), "talkLinks", LINK_ID)));
    await assertSucceeds(
      updateDoc(doc(db(T_OWNER), "talkLinks", LINK_ID), {
        answer: { sdp: "a", type: "answer" },
        status: "active",
      })
    );
    await assertSucceeds(updateDoc(doc(db(W_OWNER), "talkLinks", LINK_ID), { watcherIceCandidates: [{ c: "1" }] }));
    for (const field of ["linkId", "sessionId", "cameraDeviceId", "talkerDeviceId", "watcherDeviceId"]) {
      await assertFails(updateDoc(doc(db(W_OWNER), "talkLinks", LINK_ID), { [field]: "changed" }));
      await assertFails(updateDoc(doc(db(T_OWNER), "talkLinks", LINK_ID), { [field]: "changed" }));
    }
  });

  test("the camera owner cannot update a link", () =>
    assertFails(updateDoc(doc(db(CAM_OWNER), "talkLinks", LINK_ID), { status: "closed" })));

  test("a stranger cannot read, update or delete a link", async () => {
    await assertFails(getDoc(doc(db(STRANGER), "talkLinks", LINK_ID)));
    await assertFails(updateDoc(doc(db(STRANGER), "talkLinks", LINK_ID), { status: "closed" }));
    await assertFails(deleteDoc(doc(db(STRANGER), "talkLinks", LINK_ID)));
  });

  test("the camera owner can read and delete links of its session", async () => {
    await assertSucceeds(getDoc(doc(db(CAM_OWNER), "talkLinks", LINK_ID)));
    await assertSucceeds(deleteDoc(doc(db(CAM_OWNER), "talkLinks", LINK_ID)));
  });

  test("the talker and the watcher can delete a link", async () => {
    await assertSucceeds(deleteDoc(doc(db(T_OWNER), "talkLinks", LINK_ID)));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "talkLinks", LINK_ID), link("S1", T, W));
    });
    await assertSucceeds(deleteDoc(doc(db(W_OWNER), "talkLinks", LINK_ID)));
  });

  test("deleting a link that does not exist yet succeeds for a watcher", () =>
    assertSucceeds(deleteDoc(doc(db(W_OWNER), "talkLinks", `S1_${T}_${W}_missing`))));

  test("the camera owner lists its session's links with the app's query and deletes them", async () => {
    const snap = await assertSucceeds(
      getDocs(
        query(
          collection(db(CAM_OWNER), "talkLinks"),
          where("sessionId", "==", "S1"),
          where("cameraDeviceId", "==", CAM)
        )
      )
    );
    for (const d of snap.docs) await assertSucceeds(deleteDoc(d.ref));
  });

  test("a talker lists its links with the app's query", () =>
    assertSucceeds(
      getDocs(
        query(
          collection(db(T_OWNER), "talkLinks"),
          where("sessionId", "==", "S1"),
          where("talkerDeviceId", "==", T)
        )
      )
    ));

  test("a stranger cannot run the camera cleanup query", () =>
    assertFails(
      getDocs(
        query(
          collection(db(STRANGER), "talkLinks"),
          where("sessionId", "==", "S1"),
          where("cameraDeviceId", "==", CAM)
        )
      )
    ));

  test("a watcher who lost access to the camera cannot update, the talker still can", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "devices", CAM), { editorUserIds: [T_OWNER] });
    });
    await assertFails(updateDoc(doc(db(W_OWNER), "talkLinks", LINK_ID), { watcherIceCandidates: [{ c: "1" }] }));
    await assertSucceeds(updateDoc(doc(db(T_OWNER), "talkLinks", LINK_ID), { status: "active" }));
  });
});
