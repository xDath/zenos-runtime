const requests = new Map<string, number[]>();

export function rateLimit(ip: string, limit = 60, windowMs = 60000) {
  const now = Date.now();
  const timestamps = requests.get(ip) || [];
  const recent = timestamps.filter(t => now - t < windowMs);
  
  if (recent.length >= limit) {
    return false;
  }
  
  recent.push(now);
  requests.set(ip, recent);
  return true;
}
