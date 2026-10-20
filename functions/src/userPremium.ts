import { FieldValue, Firestore } from "firebase-admin/firestore";

export async function syncOwnerPremium(db: Firestore, ownerUid: string): Promise<boolean> {
  const premiumDevices = await db
    .collection("devices")
    .where("ownerUserId", "==", ownerUid)
    .where("premiumActive", "==", true)
    .limit(1)
    .get();
  const premium = !premiumDevices.empty;
  await db
    .collection("users")
    .doc(ownerUid)
    .set({ premium, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return premium;
}

export function ownersNeedingPremiumSync(
  before: { ownerUserId?: unknown; premiumActive?: unknown } | undefined,
  after: { ownerUserId?: unknown; premiumActive?: unknown } | undefined
): string[] {
  const ownerBefore = typeof before?.ownerUserId === "string" ? before.ownerUserId : undefined;
  const ownerAfter = typeof after?.ownerUserId === "string" ? after.ownerUserId : undefined;
  const premiumBefore = before?.premiumActive === true;
  const premiumAfter = after?.premiumActive === true;
  if (!premiumBefore && !premiumAfter) {
    return [];
  }
  if (ownerBefore === ownerAfter && premiumBefore === premiumAfter) {
    return [];
  }
  return [...new Set([ownerBefore, ownerAfter].filter((uid): uid is string => !!uid && uid.length > 0))];
}
