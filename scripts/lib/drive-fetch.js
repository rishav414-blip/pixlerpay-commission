// Read-only fetch of a public "anyone with link can view" Drive file via
// the same restricted API key the dashboard itself uses client-side (no
// OAuth needed for a read). Used as a fallback "previous state" source
// when there's no local snapshot on disk — e.g. a fresh GitHub Actions
// checkout, which has no memory of the last run's data.
export async function fetchPreviousFromDrive(fileId, apiKey) {
  if (!fileId || !apiKey) return null;
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
