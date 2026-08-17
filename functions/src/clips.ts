export function clipStoragePaths(
  cameraDeviceId: string,
  eventId: string
): { clip: string; thumb: string } {
  return {
    clip: `clips/${cameraDeviceId}/${eventId}.mp4`,
    thumb: `clips/${cameraDeviceId}/${eventId}_thumb.jpg`,
  };
}
