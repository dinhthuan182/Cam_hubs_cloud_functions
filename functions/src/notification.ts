export type DetectionCategory =
  | "person"
  | "pet"
  | "vehicle"
  | "otherMotion"
  | "sound";

export type DetectionEventType = "motion" | "sound";

export interface RecipientDeviceState {
  activelyWatchingCameraId?: string;
  premiumActive?: boolean;
  fcmToken?: unknown;
}

export function eligibleRecipientToken(
  device: RecipientDeviceState,
  cameraDeviceId: string
): string | undefined {
  if (device.activelyWatchingCameraId === cameraDeviceId) return undefined;
  if (device.premiumActive !== true) return undefined;
  const token = device.fcmToken;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

export function selectBodyLocKey(
  category: DetectionCategory | undefined,
  eventType: DetectionEventType
): string {
  switch (category) {
    case "person":
      return "notification.body.person";
    case "pet":
      return "notification.body.pet";
    case "vehicle":
      return "notification.body.vehicle";
    case "otherMotion":
      return "notification.body.otherMotion";
    default:
      return eventType === "sound"
        ? "notification.body.sound"
        : "notification.body.motion";
  }
}
