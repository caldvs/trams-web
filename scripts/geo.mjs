// Douglas-Peucker simplification of [lon, lat] points, with the tolerance in metres.
// Uses a flat projection around Manchester, which is plenty at this scale.
const M_PER_DEG_LON = 111_320 * Math.cos((53.48 * Math.PI) / 180);
const M_PER_DEG_LAT = 110_574;

export function simplify(points, toleranceM) {
  if (points.length < 3) return points;
  const p = points.map(([lon, lat]) => [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT]);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = p[a];
    const [bx, by] = p[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let max = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * p[i][0] - dx * p[i][1] + bx * ay - by * ax) / len;
      if (d > max) [max, at] = [d, i];
    }
    if (max > toleranceM) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export const distanceM = ([lat1, lon1], [lat2, lon2]) =>
  Math.hypot((lat1 - lat2) * M_PER_DEG_LAT, (lon1 - lon2) * M_PER_DEG_LON);
