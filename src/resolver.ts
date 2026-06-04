/**
 * Dependency graph builder and topological sorter.
 * Given a set of clips and their parsed refs, determines evaluation order
 * so that source clips are written before derived clips that reference them.
 */
import { parse } from "./parser.js";
import type { MidiClip } from "@ableton-extensions/sdk";

export interface ClipNode {
  clip: MidiClip<"1.0.0">;
  name: string;
  refs: string[];   // names of clips this one depends on
}

/** Build a flat map of all evaluatable clips in the session. */
export function buildGraph(clips: Array<MidiClip<"1.0.0">>): Map<string, ClipNode> {
  const graph = new Map<string, ClipNode>();
  for (const clip of clips) {
    const name = clip.name.trim();
    if (!name) continue;
    const parsed = parse(name);
    if (!parsed) continue;  // not a streusel pattern
    graph.set(name, { clip, name, refs: parsed.refs });
  }
  return graph;
}

/**
 * Topological sort — returns clip names in evaluation order (sources first).
 * Throws if there are circular dependencies.
 */
export function topoSort(graph: Map<string, ClipNode>): string[] {
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(name: string, ancestors: Set<string>): void {
    if (visited.has(name)) return;
    if (ancestors.has(name)) throw new Error(`Circular dependency: ${name}`);
    const node = graph.get(name);
    if (!node) return; // ref to a non-pattern clip — that's fine, will resolve from store
    ancestors.add(name);
    for (const dep of node.refs) visit(dep, new Set(ancestors));
    visited.add(name);
    result.push(name);
  }

  for (const name of graph.keys()) visit(name, new Set());
  return result;
}

/**
 * Given a specific clip that changed, return the set of clip names
 * that transitively depend on it (for cascade evaluation).
 */
export function dependents(changedName: string, graph: Map<string, ClipNode>): string[] {
  const deps = new Set<string>();
  function walk(name: string) {
    for (const [nodeName, node] of graph) {
      if (node.refs.includes(name) && !deps.has(nodeName)) {
        deps.add(nodeName);
        walk(nodeName);
      }
    }
  }
  walk(changedName);
  // Return in topological order
  try {
    const order = topoSort(graph);
    return order.filter(n => deps.has(n));
  } catch {
    return [...deps];
  }
}
