// Agent Village — graph helpers for the walkable path network in world.json.
// Pure module: no DOM, no network, no model calls.

export function buildGraph(world) {
  const nodes = world.nodes;
  const adjacency = new Map(Object.keys(nodes).map((id) => [id, []]));
  for (const [a, b] of world.edges) {
    if (!adjacency.has(a) || !adjacency.has(b)) throw new Error(`Edge references unknown node: ${a}-${b}`);
    const cost = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]);
    adjacency.get(a).push({ to: b, cost });
    adjacency.get(b).push({ to: a, cost });
  }
  return { nodes, adjacency };
}

// Dijkstra (the graph has a few dozen nodes, so a simple O(n^2) frontier is plenty).
export function shortestPath(graph, from, to) {
  if (!graph.adjacency.has(from) || !graph.adjacency.has(to)) return null;
  if (from === to) return [from];
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const open = new Set([from]);
  const done = new Set();
  while (open.size) {
    let current = null;
    for (const id of open) if (current === null || dist.get(id) < dist.get(current)) current = id;
    open.delete(current);
    if (current === to) break;
    done.add(current);
    for (const { to: next, cost } of graph.adjacency.get(current)) {
      if (done.has(next)) continue;
      const d = dist.get(current) + cost;
      if (!dist.has(next) || d < dist.get(next)) {
        dist.set(next, d);
        prev.set(next, current);
        open.add(next);
      }
    }
  }
  if (!prev.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]));
  return path;
}

export function pathLength(graph, path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = graph.nodes[path[i - 1]];
    const [bx, by] = graph.nodes[path[i]];
    total += Math.hypot(bx - ax, by - ay);
  }
  return total;
}

// Distance from point p to the closest walkable segment (used by tests to prove avatars never leave the paths).
export function distanceToNetwork(world, [px, py]) {
  let best = Infinity;
  for (const [a, b] of world.edges) {
    const [ax, ay] = world.nodes[a];
    const [bx, by] = world.nodes[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}
