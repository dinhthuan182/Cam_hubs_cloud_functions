import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

async function deviceOwnerUid(deviceId: string): Promise<string | undefined> {
  const snap = await db.collection("devices").doc(deviceId).get();
  const owner = snap.get("ownerUserId");
  return typeof owner === "string" && owner.length > 0 ? owner : undefined;
}

async function backfill(): Promise<void> {
  const pairings = await db.collection("pairings").where("status", "==", "active").get();
  let updates = 0;
  for (const doc of pairings.docs) {
    const members = (doc.get("memberDeviceIds") ?? []) as string[];
    if (members.length !== 2) {
      continue;
    }
    const [deviceA, deviceB] = members;
    const [ownerA, ownerB] = await Promise.all([deviceOwnerUid(deviceA), deviceOwnerUid(deviceB)]);
    const writes: Promise<unknown>[] = [];
    if (ownerB) {
      writes.push(db.collection("devices").doc(deviceA).update({ editorUserIds: FieldValue.arrayUnion(ownerB) }));
    }
    if (ownerA) {
      writes.push(db.collection("devices").doc(deviceB).update({ editorUserIds: FieldValue.arrayUnion(ownerA) }));
    }
    await Promise.all(writes);
    updates += writes.length;
  }
  console.log(`backfillPairingEditors: updated ${updates} device docs across ${pairings.size} active pairings`);
}

backfill()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
