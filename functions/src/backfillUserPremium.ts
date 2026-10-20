import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { syncOwnerPremium } from "./userPremium";

initializeApp();
const db = getFirestore();

async function backfill(): Promise<void> {
  const devices = await db.collection("devices").select("ownerUserId").get();
  const owners = new Set<string>();
  for (const doc of devices.docs) {
    const owner = doc.get("ownerUserId");
    if (typeof owner === "string" && owner.length > 0) {
      owners.add(owner);
    }
  }
  let premium = 0;
  for (const owner of owners) {
    if (await syncOwnerPremium(db, owner)) {
      premium++;
    }
  }
  console.log(`backfillUserPremium: wrote ${owners.size} users docs, ${premium} premium`);
}

backfill()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
