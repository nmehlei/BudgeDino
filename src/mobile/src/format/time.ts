/** "just now", "5 min ago", "3 h ago", "2 d ago" for an ISO timestamp (or epoch ms). */
export function formatRelative(value: string | number, now: number = Date.now()): string {
  const t = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(t)) return 'unknown';
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** "09.11., 14:05" in the device time zone. */
export function formatDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}., ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
