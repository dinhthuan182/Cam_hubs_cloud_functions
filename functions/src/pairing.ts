import { FieldValue, Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

export interface PairedDeviceSummary {
  id: string;
  ownerUserId: string;
  displayName: string;
  platform: string;
  isStreaming: boolean;
}

export interface PairWithTokenResult {
  pairingId: string;
  device: PairedDeviceSummary;
}

export function pairingIdFor(deviceA: string, deviceB: string): string {
  return [deviceA, deviceB].sort().join("_");
}

export async function pairWithToken(
  db: Firestore,
  callerUid: string,
  deviceId: string,
  pairingToken: string
): Promise<PairWithTokenResult> {
  const matches = await db.collection("devices").where("pairingToken", "==", pairingToken).limit(1).get();
  if (matches.empty) {
    throw new HttpsError("not-found", "No device matches this pairing code.");
  }
  const remoteRef = matches.docs[0].ref;
  if (remoteRef.id === deviceId) {
    throw new HttpsError("invalid-argument", "A device cannot pair with itself.");
  }

  const [deviceA, deviceB] = [deviceId, remoteRef.id].sort();
  const pairingRef = db.collection("pairings").doc(pairingIdFor(deviceA, deviceB));
  const localRef = db.collection("devices").doc(deviceId);

  const remote = await db.runTransaction(async (tx) => {
    const [localSnap, remoteSnap, pairingSnap] = await Promise.all([
      tx.get(localRef),
      tx.get(remoteRef),
      tx.get(pairingRef),
    ]);
    if (!localSnap.exists || localSnap.get("ownerUserId") !== callerUid) {
      throw new HttpsError("permission-denied", "Caller does not own the pairing device.");
    }
    if (!remoteSnap.exists || remoteSnap.get("pairingToken") !== pairingToken) {
      throw new HttpsError("not-found", "No device matches this pairing code.");
    }
    const remoteOwner = remoteSnap.get("ownerUserId");
    if (typeof remoteOwner !== "string" || remoteOwner.length === 0) {
      throw new HttpsError("failed-precondition", "The paired device has no owner.");
    }

    if (!pairingSnap.exists) {
      tx.set(pairingRef, {
        deviceA,
        deviceB,
        memberDeviceIds: [deviceA, deviceB],
        createdAt: FieldValue.serverTimestamp(),
        status: "active",
      });
    } else if (pairingSnap.get("status") !== "active") {
      tx.update(pairingRef, { deviceA, deviceB, memberDeviceIds: [deviceA, deviceB], status: "active" });
    }
    tx.update(localRef, { editorUserIds: FieldValue.arrayUnion(remoteOwner) });
    tx.update(remoteRef, { editorUserIds: FieldValue.arrayUnion(callerUid) });
    return remoteSnap;
  });

  return {
    pairingId: pairingRef.id,
    device: {
      id: remote.id,
      ownerUserId: remote.get("ownerUserId"),
      displayName: typeof remote.get("displayName") === "string" ? remote.get("displayName") : "",
      platform: typeof remote.get("platform") === "string" ? remote.get("platform") : "",
      isStreaming: remote.get("isStreaming") === true,
    },
  };
}

export async function recomputeEditors(db: Firestore, deviceId: string): Promise<string[] | undefined> {
  const deviceRef = db.collection("devices").doc(deviceId);
  const activePairings = db
    .collection("pairings")
    .where("memberDeviceIds", "array-contains", deviceId)
    .where("status", "==", "active");

  return db.runTransaction(async (tx) => {
    const [deviceSnap, pairingsSnap] = await Promise.all([tx.get(deviceRef), tx.get(activePairings)]);
    if (!deviceSnap.exists) {
      return undefined;
    }
    const peerIds = new Set<string>();
    for (const doc of pairingsSnap.docs) {
      for (const member of (doc.get("memberDeviceIds") ?? []) as unknown[]) {
        if (typeof member === "string" && member !== deviceId) {
          peerIds.add(member);
        }
      }
    }
    const peers = peerIds.size > 0 ? await tx.getAll(...[...peerIds].map((id) => db.collection("devices").doc(id))) : [];
    const editors = [
      ...new Set(
        peers
          .map((peer) => peer.get("ownerUserId"))
          .filter((uid): uid is string => typeof uid === "string" && uid.length > 0)
      ),
    ].sort();
    tx.update(deviceRef, { editorUserIds: editors });
    return editors;
  });
}
