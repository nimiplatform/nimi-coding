import { Buffer } from "node:buffer";
import { stat } from "node:fs/promises";
import path from "node:path";

import { compileAuthorityPath } from "./compile.mjs";
import { compareText, makeDiagnostic, portablePath } from "./diagnostics.mjs";

const GRAPH_FORMAT = "nimicoding.authority-graph/v1";

async function inputLocation(inputPath) {
  const absolute = path.resolve(inputPath);
  const info = await stat(absolute);
  return {
    basePath: info.isDirectory() ? absolute : path.dirname(absolute),
    label: info.isDirectory() ? "." : path.basename(absolute),
  };
}

function portableLocation(mapped, basePath) {
  return {
    file: portablePath(mapped.file, basePath),
    range: mapped.range,
    sourcePointer: mapped.sourcePointer,
  };
}

function diagnostic(location, code, id, reason, repair, mapped = null) {
  return makeDiagnostic({
    code,
    file: mapped ? portablePath(mapped.file, location.basePath) : location.label,
    range: mapped?.range ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: mapped?.sourcePointer ?? "/id",
    reason: `${reason}: ${id}`,
    repair,
  });
}

function failedResult(compiled, diagnostics = compiled.diagnostics) {
  return {
    ok: false,
    diagnostics,
    fileCount: compiled.fileCount,
    unitCount: 0,
    graphBytes: 0,
    graph: null,
    partial: false,
  };
}

function edgeKey(edge) {
  return `${edge.source}\u0000${edge.type}\u0000${edge.target}`;
}

function compareEdge(left, right) {
  return compareText(left.source, right.source)
    || compareText(left.type, right.type)
    || compareText(left.target, right.target);
}

function compareStep(left, right) {
  return compareText(left.type, right.type)
    || compareText(left.traversal, right.traversal)
    || compareText(left.source, right.source)
    || compareText(left.target, right.target);
}

function compareStepSequences(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = compareStep(left[index], right[index]);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function facade(compiled, basePath, relations) {
  const selectedTypes = new Set(relations);
  const byId = new Map();
  const outgoing = new Map();
  const incoming = new Map();
  const edges = [];

  compiled.ir.units.forEach((unit, unitIndex) => {
    const idMap = compiled.sourceMap.fields[`/units/${unitIndex}/id`];
    const node = {
      id: unit.id,
      kind: unit.kind,
      owner: unit.owner,
      lifecycle: unit.lifecycle,
      scope: unit.lifecycle === "active" && unit.kind === "rule" ? [...unit.semantic.scope] : [],
      location: portableLocation(idMap, basePath),
    };
    byId.set(unit.id, { unit, unitIndex, idMap, node });
    outgoing.set(unit.id, []);
    incoming.set(unit.id, []);
  });

  compiled.ir.units.forEach((unit, unitIndex) => {
    unit.relations.forEach((relation, relationIndex) => {
      if (!selectedTypes.has(relation.type)) return;
      const target = byId.get(relation.target);
      const value = {
        source: unit.id,
        type: relation.type,
        target: relation.target,
        sourceLocation: portableLocation(compiled.sourceMap.fields[`/units/${unitIndex}/id`], basePath),
        relationLocation: portableLocation(compiled.sourceMap.fields[`/units/${unitIndex}/relations/${relationIndex}/target`], basePath),
        targetLocation: target.node.location,
      };
      edges.push(value);
      outgoing.get(value.source).push(value);
      incoming.get(value.target).push(value);
    });
  });
  edges.sort(compareEdge);
  for (const adjacency of [...outgoing.values(), ...incoming.values()]) adjacency.sort(compareEdge);
  return { byId, outgoing, incoming, edges };
}

function adjacent(snapshot, id, direction) {
  const values = [];
  if (direction === "outgoing" || direction === "both") {
    for (const edge of snapshot.outgoing.get(id)) values.push({ edge, next: edge.target, traversal: "forward" });
  }
  if (direction === "incoming" || direction === "both") {
    for (const edge of snapshot.incoming.get(id)) values.push({ edge, next: edge.source, traversal: "reverse" });
  }
  const deduplicated = new Map();
  for (const value of values) deduplicated.set(`${edgeKey(value.edge)}\u0000${value.traversal}`, value);
  return [...deduplicated.values()].sort((left, right) => compareStep(
    { ...left.edge, traversal: left.traversal },
    { ...right.edge, traversal: right.traversal },
  ));
}

function graphBase(operation, query, nodes, edges, policy, counts, budgets, extra = {}) {
  return {
    format: GRAPH_FORMAT,
    operation,
    query,
    complete: true,
    ...extra,
    nodes: [...nodes].sort((left, right) => compareText(left.id, right.id)),
    edges: [...edges].sort(compareEdge),
    policy,
    counts,
    budgets,
  };
}

function budgetFailure(compiled, location, id, reason, mapped) {
  return failedResult(compiled, [diagnostic(
    location,
    "AUTH_GRAPH_BUDGET",
    id,
    reason,
    "increase the explicit graph budget; partial graph results are forbidden",
    mapped,
  )]);
}

function finish(compiled, graph, location, root, traversal) {
  const { maxUnits, maxEdges, maxBytes } = graph.budgets;
  if (traversal.units > maxUnits) return budgetFailure(
    compiled,
    location,
    root.unit.id,
    `complete graph proof requires ${traversal.units} units but max-units is ${maxUnits}`,
    root.idMap,
  );
  if (traversal.edges > maxEdges) return budgetFailure(
    compiled,
    location,
    root.unit.id,
    `complete graph proof requires ${traversal.edges} authored edges but max-edges is ${maxEdges}`,
    root.idMap,
  );
  const graphBytes = Buffer.byteLength(JSON.stringify(graph), "utf8");
  if (graphBytes > maxBytes) return budgetFailure(
    compiled,
    location,
    root.unit.id,
    `complete graph requires ${graphBytes} UTF-8 bytes but max-bytes is ${maxBytes}`,
    root.idMap,
  );
  return {
    ok: true,
    diagnostics: [],
    fileCount: compiled.fileCount,
    unitCount: graph.nodes.length,
    graphBytes,
    graph,
    partial: false,
  };
}

async function admittedGraph(inputPath, ids, relations) {
  const compiled = await compileAuthorityPath(inputPath);
  if (!compiled.ok) return { result: failedResult(compiled) };
  const location = await inputLocation(inputPath);
  const snapshot = facade(compiled, location.basePath, relations);
  for (const [role, id] of ids) {
    if (!snapshot.byId.has(id)) return { result: failedResult(compiled, [diagnostic(
      location,
      "AUTH_QUERY_NOT_FOUND",
      id,
      `${role} authority identity does not resolve`,
      "use an exact admitted authority ID; do not infer a near match",
    )]) };
  }
  return { compiled, location, snapshot };
}

export async function refsAuthorityPath(inputPath, id, { direction, relations, maxUnits, maxEdges, maxBytes }) {
  const admitted = await admittedGraph(inputPath, [["reference root", id]], relations);
  if (admitted.result) return admitted.result;
  const { compiled, location, snapshot } = admitted;
  const root = snapshot.byId.get(id);
  const selected = new Map();
  for (const value of adjacent(snapshot, id, direction)) selected.set(edgeKey(value.edge), value.edge);
  const edges = [...selected.values()];
  const nodeIds = new Set([id]);
  for (const edge of edges) { nodeIds.add(edge.source); nodeIds.add(edge.target); }
  const nodes = [...nodeIds].map((nodeId) => snapshot.byId.get(nodeId).node);
  const traversal = { units: nodes.length, edges: edges.length };
  const budgets = { maxUnits, maxEdges, maxBytes };
  const graph = graphBase("refs", { id, direction, relations }, nodes, edges, {
    edgeRepresentation: "canonical_authored_source_to_target",
    selection: "direct_only",
    duplicateEdges: "suppressed",
    ordering: { nodes: "id", edges: ["source", "type", "target"] },
  }, {
    returned: { units: nodes.length, edges: edges.length },
    traversal,
  }, budgets);
  return finish(compiled, graph, location, root, traversal);
}

function pathAdjacency(snapshot, id, traversal) {
  return adjacent(snapshot, id, traversal === "directed" ? "outgoing" : "both");
}

export async function pathAuthorityPath(inputPath, fromId, toId, { traversal: traversalMode, relations, maxHops, maxUnits, maxEdges, maxBytes }) {
  const admitted = await admittedGraph(inputPath, [["path source", fromId], ["path target", toId]], relations);
  if (admitted.result) return admitted.result;
  const { compiled, location, snapshot } = admitted;
  const root = snapshot.byId.get(fromId);
  const visitedDepth = new Map([[fromId, 0]]);
  const proofEdges = new Set();
  let layer = new Map([[fromId, []]]);
  let witness = fromId === toId ? [] : null;
  let exhausted = false;

  for (let depth = 0; witness === null && depth < maxHops && layer.size > 0; depth += 1) {
    const next = new Map();
    for (const id of [...layer.keys()].sort(compareText)) {
      const prefix = layer.get(id);
      for (const value of pathAdjacency(snapshot, id, traversalMode)) {
        proofEdges.add(edgeKey(value.edge));
        const priorDepth = visitedDepth.get(value.next);
        if (priorDepth !== undefined && priorDepth < depth + 1) continue;
        const candidate = [...prefix, { source: value.edge.source, type: value.edge.type, target: value.edge.target, traversal: value.traversal }];
        const prior = next.get(value.next);
        if (!prior || compareStepSequences(candidate, prior) < 0) next.set(value.next, candidate);
        if (priorDepth === undefined) visitedDepth.set(value.next, depth + 1);
      }
    }
    if (next.has(toId)) witness = next.get(toId);
    if (next.size === 0) exhausted = true;
    layer = next;
  }

  if (witness === null && !exhausted && layer.size > 0) {
    let unchecked = false;
    for (const id of [...layer.keys()].sort(compareText)) {
      for (const value of pathAdjacency(snapshot, id, traversalMode)) {
        proofEdges.add(edgeKey(value.edge));
        if (!visitedDepth.has(value.next)) unchecked = true;
      }
    }
    if (unchecked) return budgetFailure(
      compiled,
      location,
      fromId,
      `complete path result requires traversing beyond max-hops ${maxHops}`,
      root.idMap,
    );
  }

  const found = witness !== null;
  const pathEdgeKeys = new Set((witness ?? []).map((step) => `${step.source}\u0000${step.type}\u0000${step.target}`));
  const edges = snapshot.edges.filter((edge) => pathEdgeKeys.has(edgeKey(edge)));
  const pathNodeIds = found
    ? [fromId, ...(witness ?? []).map((step) => step.traversal === "forward" ? step.target : step.source)]
    : [fromId, toId];
  const nodes = [...new Set(pathNodeIds)].map((id) => snapshot.byId.get(id).node);
  const traversal = { units: new Set([...visitedDepth.keys(), toId]).size, edges: proofEdges.size };
  const budgets = { maxHops, maxUnits, maxEdges, maxBytes };
  const graph = graphBase("path", { fromId, toId, traversal: traversalMode, relations }, nodes, edges, {
    edgeRepresentation: "canonical_authored_source_to_target",
    traversal: traversalMode === "directed" ? "authored_forward_only" : "incidence_forward_or_reverse",
    reverseStepClaim: "topology_incidence_only_not_semantic_dependency",
    selection: "shortest_hops_then_lexical_minimum_complete_step_tuple_sequence",
    stepTuple: ["type", "traversal", "authored_source", "authored_target"],
    ordering: { nodes: "id", edges: ["source", "type", "target"] },
  }, {
    returned: { units: nodes.length, edges: edges.length, hops: witness?.length ?? 0 },
    traversal,
  }, budgets, { found, steps: witness ?? [] });
  return finish(compiled, graph, location, root, traversal);
}

export async function subgraphAuthorityPath(inputPath, id, { direction, relations, depth, maxUnits, maxEdges, maxBytes }) {
  const admitted = await admittedGraph(inputPath, [["subgraph root", id]], relations);
  if (admitted.result) return admitted.result;
  const { compiled, location, snapshot } = admitted;
  const root = snapshot.byId.get(id);
  const distances = new Map([[id, 0]]);
  const proofEdges = new Set();
  let layer = [id];
  for (let currentDepth = 0; currentDepth < depth && layer.length > 0; currentDepth += 1) {
    const next = new Set();
    for (const current of [...layer].sort(compareText)) {
      for (const value of adjacent(snapshot, current, direction)) {
        proofEdges.add(edgeKey(value.edge));
        if (!distances.has(value.next)) {
          distances.set(value.next, currentDepth + 1);
          next.add(value.next);
        }
      }
    }
    layer = [...next].sort(compareText);
  }
  const nodeIds = new Set(distances.keys());
  const edges = snapshot.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  for (const edge of edges) proofEdges.add(edgeKey(edge));
  const nodes = [...nodeIds].map((nodeId) => snapshot.byId.get(nodeId).node);
  const traversal = { units: nodes.length, edges: proofEdges.size };
  const budgets = { depth, maxUnits, maxEdges, maxBytes };
  const graph = graphBase("subgraph", { id, direction, relations, depth }, nodes, edges, {
    edgeRepresentation: "canonical_authored_source_to_target",
    traversal: "deterministic_breadth_first",
    selection: "complete_selected_graph_within_depth",
    duplicateNodesAndEdges: "suppressed",
    cycleSafe: true,
    ordering: { nodes: "id", edges: ["source", "type", "target"] },
  }, {
    returned: { units: nodes.length, edges: edges.length },
    traversal,
  }, budgets);
  return finish(compiled, graph, location, root, traversal);
}
