import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { recomputeEditors } from "./pairing";

initializeApp();
const db = getFirestore();

async function backfill(): Promise<void> {
  const pairings = await db.collection("pairings").where("status", "==", "active").get();
  const devices = new Set<string>();
  for (const doc of pairings.docs) {
    for (const member of (doc.get("memberDeviceIds") ?? []) as unknown[]) {
      if (typeof member === "string" && member.length > 0) {
        devices.add(member);
      }
    }
  }
  let updates = 0;
  for (const deviceId of devices) {
    if (await recomputeEditors(db, deviceId)) {
      updates++;
    }
  }
  console.log(`backfillPairingEditors: updated ${updates} device docs across ${pairings.size} active pairings`);
}

backfill()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
