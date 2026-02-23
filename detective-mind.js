/* ================================================================================
 * DETECTIVE MIND \u2014 The Collective Brain of the Detective Bureau
 * Version 2.0 \u2014 Ticket-Aware Multi-Step Movement Engine
 * ================================================================================
 *
 * All five detectives share one mind. They pool every piece of evidence they
 * have ever observed. They do NOT know Moriarty's true position except on
 * designated Reveal Rounds, or when deduction collapses all uncertainty.
 *
 * \u2500\u2500 WHAT THE DETECTIVES KNOW \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *   \u2022 Transport type Moriarty used each round (cab/tram/underground/river/fog)
 *   \u2022 Moriarty's exact node on Reveal Rounds (3, 8, 13, 18, 22)
 *   \u2022 Their own positions at all times
 *   \u2022 The full graph (nodes, edges, transport types per edge)
 *
 * \u2500\u2500 WHAT THEY DO NOT KNOW \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *   \u2022 Moriarty's position on non-reveal rounds
 *   \u2022 Which specific node Moriarty moved to each step
 *
 * \u2500\u2500 DETECTIVE TICKET ALLOWANCE (fixed per game) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *   \u2022 Hansom Cab:    10 tickets  (short range, many connections)
 *   \u2022 Tramway:        8 tickets  (medium range, structured lines)
 *   \u2022 Underground:    4 tickets  (long range, sparse \u2014 spend wisely)
 *   \u2022 River Boat:     0 tickets  (detectives CANNOT use river at all)
 *
 * \u2500\u2500 STRANDING RULE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *   If a detective is on a node and has no tickets for any transport type
 *   that has an edge leaving that node, they are STRANDED for the rest of the
 *   game. The movement engine evaluates LOOKAHEAD_DEPTH rounds ahead precisely
 *   to avoid this outcome \u2014 a stranded detective is a wasted resource.
 *
 * \u2500\u2500 KEY DESIGN PRINCIPLES \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *   1. Every move decision considers the next LOOKAHEAD_DEPTH rounds, not just
 *      the immediate step. A move that looks good now but strands the detective
 *      in 2 rounds is scored worse than a slower but sustainable path.
 *   2. Underground tickets (only 4) are conserved unless the hop saving is
 *      at least UNDERGROUND_MIN_SAVING greater than the cab/tram alternative.
 *   3. Holmes is assigned the highest-belief cluster. Other detectives fan out
 *      to maximise total belief coverage, never duplicating effort.
 *   4. Later detectives (processed after Holmes) adapt their moves to avoid
 *      collisions with already-planned positions.
 *
 * \u2500\u2500 PUBLIC API CALLED BY GAME LOOP \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *
 *   createGameGraph(nodes, edges)                  \u2192 GameGraph
 *   createDetectiveMind(graph, startNodes, count)  \u2192 DetectiveMind
 *
 *   processMoriartyMove(mind, round, type, isBluff, detNodes, lastRevRound, lastRevNode)
 *   processMoriartyReveal(mind, round, nodeId, detNodes)
 *   decideDetectiveMoves(mind, detectives, round)  \u2192 Array<MoveDecision>
 *
 *   MoveDecision: { detId, moveToNode, useType, stranded, reasoning, score }
 *
 * ================================================================================
 */

'use strict';

// \u2500\u2500 Single source of truth for ticket allowances \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const DETECTIVE_TICKETS = { cab: 10, tram: 8, underground: 4, river: 0 };

// Detectives never use river \u2014 treated as non-existent for all path planning
const DET_USABLE_TYPES = ['cab', 'tram', 'underground'];

// Underground conservation: only spend it if it saves at least this many hops
const UNDERGROUND_MIN_SAVING = 3;

// How many rounds ahead to simulate when scoring a move candidate
const LOOKAHEAD_DEPTH = 4;

// Reveal rounds \u2014 must match main game file
const DET_REVEAL_ROUNDS = [3, 8, 13, 18, 22];


/* ================================================================================
 * [SECTION 1]  GameGraph
 *
 *  Pure adjacency wrapper around the raw nodes/edges arrays from the game.
 *  Every method is stateless (no mutations). Safe to call from anywhere.
 *
 *  The critical new capability vs v1: ticketAwarePath() and isStranded() which
 *  enforce the detective ticket constraints at the path-planning level.
 * ================================================================================ */
class GameGraph {
  constructor(nodes, edges) {
    this.nodes = nodes;
    this.edges = edges;
    this._adj  = null;  // adjacency map, built lazily on first query
  }

  // Build adjacency: Map<nodeId, [{node, type}]>
  _buildAdj() {
    this._adj = new Map();
    for (const n of this.nodes) this._adj.set(n.id, []);
    for (const e of this.edges) {
      this._adj.get(e.a)?.push({ node: e.b, type: e.type });
      this._adj.get(e.b)?.push({ node: e.a, type: e.type });
    }
  }

  /**
   * All neighbours of nodeId, with optional transport filter.
   *   typeFilter = null | 'fog'        \u2192 all types
   *   typeFilter = 'cab'               \u2192 only cab edges
   *   typeFilter = ['cab','tram']      \u2192 cab or tram edges
   */
  getNeighbors(nodeId, typeFilter = null) {
    if (!this._adj) this._buildAdj();
    const all = this._adj.get(nodeId) || [];
    if (!typeFilter || typeFilter === 'fog') return all;
    if (Array.isArray(typeFilter)) return all.filter(n => typeFilter.includes(n.type));
    return all.filter(n => n.type === typeFilter);
  }

  /**
   * All neighbours a detective can legally move to from nodeId, given their
   * remaining tickets. River edges are always excluded (0 river tickets).
   * Returns [{node, type}].
   */
  getDetectiveNeighbors(nodeId, tickets) {
    if (!this._adj) this._buildAdj();
    return (this._adj.get(nodeId) || []).filter(n =>
      n.type !== 'river' &&
      (tickets[n.type] || 0) > 0
    );
  }

  /**
   * Ticket-aware BFS: find the shortest path from start \u2192 goal that the
   * detective can actually walk given their current ticket counts.
   *
   * Tracks remaining tickets at each BFS state so it never plans a route
   * that consumes more tickets than the detective has. States are keyed by
   * [nodeId, cab, tram, underground] to avoid re-expanding identical states.
   *
   * Returns Array<{node, type}> (each element = one step), or null if the
   * goal is unreachable within available tickets.
   */
  ticketAwarePath(start, goal, tickets) {
    if (start === goal) return [];
    if (!this._adj) this._buildAdj();

    const visited = new Set();
    // Queue entries: { node, tickets (copy), path (array of steps) }
    const queue = [{ node: start, tickets: { ...tickets }, path: [] }];

    while (queue.length) {
      const { node: cur, tickets: rem, path } = queue.shift();
      const key = `${cur}|${rem.cab}|${rem.tram}|${rem.underground}`;
      if (visited.has(key)) continue;
      visited.add(key);

      for (const { node: next, type } of this.getDetectiveNeighbors(cur, rem)) {
        const newRem  = { ...rem, [type]: rem[type] - 1 };
        const newPath = [...path, { node: next, type }];
        if (next === goal) return newPath;
        const nextKey = `${next}|${newRem.cab}|${newRem.tram}|${newRem.underground}`;
        if (!visited.has(nextKey)) queue.push({ node: next, tickets: newRem, path: newPath });
      }
    }
    return null;  // unreachable
  }

  /**
   * Simple BFS hop count, ignoring transport types.
   * Used for belief geometry (not movement planning).
   * Returns Infinity if a and b are disconnected.
   */
  shortestPath(a, b) {
    if (a === b) return 0;
    if (!this._adj) this._buildAdj();
    const visited = new Set([a]);
    const queue   = [[a, 0]];
    while (queue.length) {
      const [cur, d] = queue.shift();
      for (const { node } of (this._adj.get(cur) || [])) {
        if (node === b) return d + 1;
        if (!visited.has(node)) { visited.add(node); queue.push([node, d + 1]); }
      }
    }
    return Infinity;
  }

  /**
   * All nodes reachable from nodeId within maxHops (any transport).
   * Returns Map<nodeId, hopCount>.
   */
  reachableWithin(nodeId, maxHops) {
    if (!this._adj) this._buildAdj();
    const dist  = new Map([[nodeId, 0]]);
    const queue = [nodeId];
    while (queue.length) {
      const cur = queue.shift();
      const d   = dist.get(cur);
      if (d >= maxHops) continue;
      for (const { node } of (this._adj.get(cur) || [])) {
        if (!dist.has(node)) { dist.set(node, d + 1); queue.push(node); }
      }
    }
    return dist;
  }

  /**
   * True if the detective at nodeId has no usable ticket for any exit edge.
   * A stranded detective is permanently stuck for the rest of the game.
   */
  isStranded(nodeId, tickets) {
    return this.getDetectiveNeighbors(nodeId, tickets).length === 0;
  }
}


/* ================================================================================
 * [SECTION 2]  TicketPlanner
 *
 *  Scores candidate moves using multi-step lookahead.
 *
 *  The key insight is that a move must be evaluated not just on its immediate
 *  benefit (belief at destination) but on:
 *    \u2014 Whether it risks stranding the detective
 *    \u2014 How much of the belief map remains reachable after the move
 *    \u2014 Whether it wastes scarce Underground tickets unnecessarily
 *    \u2014 How it positions the detective for the next LOOKAHEAD_DEPTH rounds
 *
 *  This mirrors how a strong chess engine evaluates not just material gain
 *  but position, mobility, and king safety.
 * ================================================================================ */
class TicketPlanner {
  constructor(graph) {
    this.graph = graph;
  }

  /**
   * Score a specific candidate move: currentNode \u2192 candidateNode via type.
   *
   * HIGHER score = BETTER move.
   *
   * Scoring components:
   *   +1000  \u00d7 belief(candidateNode)         immediate capture value
   *   +500   \u00d7 \u03a3belief(adj neighbours)       one-step follow-up value
   *   \u2212200     if stranded after move (and belief < 50%) \u2014 catastrophic waste
   *   \u221250      if underground spent without saving \u2265 UNDERGROUND_MIN_SAVING hops
   *   +30    \u00d7 future belief coverage (lookahead)
   *   \u221210    \u00d7 hops from candidateNode to targetNode
   *   \u221280      if candidateNode is already taken by another detective this round
   *
   * @param {number} currentNode
   * @param {number} candidateNode
   * @param {string} type              transport type for this move
   * @param {Object} tickets           remaining tickets BEFORE this move
   * @param {Map}    beliefMap         current belief distribution
   * @param {number} targetNode        assigned cluster target for this detective
   * @param {Set}    occupiedByOthers  nodes other detectives are moving to this round
   * @returns {number}
   */
  scoreCandidateMove(
    currentNode, candidateNode, type,
    tickets, beliefMap, targetNode, occupiedByOthers
  ) {
    const remTickets = { ...tickets, [type]: tickets[type] - 1 };
    let score = 0;

    // \u2500\u2500 Immediate belief value \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const immBelief = beliefMap.get(candidateNode) || 0;
    score += immBelief * 1000;

    // \u2500\u2500 Adjacent follow-up value \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    for (const { node: n } of this.graph.getDetectiveNeighbors(candidateNode, remTickets)) {
      score += (beliefMap.get(n) || 0) * 500;
    }

    // \u2500\u2500 Stranding penalty \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    // If stranded after this move, the detective is useless for the rest of the
    // game. Apply a major penalty unless belief here is already very high
    // (in which case staying put may be correct \u2014 you're where Moriarty probably is).
    if (this.graph.isStranded(candidateNode, remTickets) && immBelief < 0.5) {
      score -= 200;
    }

    // \u2500\u2500 Underground conservation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    // Only spend Underground if it saves enough hops over cab/tram alternatives.
    if (type === 'underground') {
      // Best cab/tram alternative distance to target from current node
      const altNeighbors = this.graph.getNeighbors(currentNode, ['cab', 'tram']);
      const bestAltDist  = altNeighbors.length
        ? Math.min(...altNeighbors.map(n => this.graph.shortestPath(n.node, targetNode)))
        : Infinity;
      const underDist    = this.graph.shortestPath(candidateNode, targetNode);
      const saving       = bestAltDist - underDist;

      if (saving < UNDERGROUND_MIN_SAVING) {
        score -= 50;  // Not worth it
      } else {
        score += saving * 10;  // Reward proportional to shortcut value
      }
    }

    // \u2500\u2500 Lookahead: future coverage of belief map \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    // Simulate LOOKAHEAD_DEPTH more rounds from candidateNode.
    // Score based on how much total belief mass remains reachable.
    const futureCoverage = this._mobilityLookahead(
      candidateNode, remTickets, beliefMap, LOOKAHEAD_DEPTH
    );
    score += futureCoverage * 30;

    // \u2500\u2500 Distance to assigned cluster target \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const distToTarget = this.graph.shortestPath(candidateNode, targetNode);
    if (distToTarget < Infinity) score -= distToTarget * 10;

    // \u2500\u2500 Avoid collision with teammates this round \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (occupiedByOthers.has(candidateNode)) score -= 80;

    return score;
  }

  /**
   * Lookahead: from startNode with given tickets, simulate up to `depth` moves.
   * Returns total belief-weighted reachable node count \u2014 how much probability
   * space this detective can still cover in the next `depth` rounds.
   *
   * Uses bounded BFS tracking ticket state. Does NOT enumerate all paths
   * (exponential) \u2014 aggregates the SET of reachable nodes and sums their belief.
   */
  _mobilityLookahead(startNode, tickets, beliefMap, depth) {
    if (depth <= 0) return 0;

    const reachable = new Set([startNode]);
    const visited   = new Set([`${startNode}|${tickets.cab}|${tickets.tram}|${tickets.underground}`]);
    const queue     = [{ node: startNode, tickets: { ...tickets }, d: 0 }];

    while (queue.length) {
      const { node: cur, tickets: rem, d } = queue.shift();
      if (d >= depth) continue;

      for (const { node: next, type } of this.graph.getDetectiveNeighbors(cur, rem)) {
        const newRem = { ...rem, [type]: rem[type] - 1 };
        const key    = `${next}|${newRem.cab}|${newRem.tram}|${newRem.underground}`;
        if (!visited.has(key)) {
          visited.add(key);
          reachable.add(next);
          queue.push({ node: next, tickets: newRem, d: d + 1 });
        }
      }
    }

    // Sum belief across all reachable nodes, weighted by coverage breadth
    let totalBelief = 0;
    for (const id of reachable) totalBelief += (beliefMap.get(id) || 0);
    return totalBelief * reachable.size;
  }

  /**
   * Given a detective and a target, return the single best adjacent step.
   *
   * Evaluates ALL legal adjacent moves (not just the on-path one \u2014 sometimes
   * a sideways move improves future positioning), scores each with
   * scoreCandidateMove, returns the highest scorer.
   *
   * @param {Object} det              { id, node, tickets }
   * @param {number} targetNode       assigned cluster target
   * @param {Map}    beliefMap
   * @param {Set}    occupiedByOthers nodes already claimed this round
   * @returns {{ moveToNode, useType, score, reasoning, stranded }}
   */
  bestSingleStep(det, targetNode, beliefMap, occupiedByOthers) {
    const candidates = this.graph.getDetectiveNeighbors(det.node, det.tickets);
    const detName    = ['Holmes', 'Watson', 'Lestrade', 'Gregson', 'Wiggins'][det.id] || `Det ${det.id}`;
    const curName    = this.graph.nodes[det.node]?.name || `Node ${det.node}`;

    if (candidates.length === 0) {
      return {
        moveToNode: det.node,
        useType:    null,
        score:      -Infinity,
        reasoning:  `${detName} is STRANDED at ${curName} \u2014 no usable tickets for any exit.`,
        stranded:   true,
      };
    }

    let best = null;

    for (const { node: nextNode, type } of candidates) {
      const score = this.scoreCandidateMove(
        det.node, nextNode, type,
        det.tickets, beliefMap,
        targetNode, occupiedByOthers
      );
      if (!best || score > best.score) best = { moveToNode: nextNode, useType: type, score };
    }

    const destName  = this.graph.nodes[best.moveToNode]?.name || `Node ${best.moveToNode}`;
    const beliefPct = Math.round((beliefMap.get(best.moveToNode) || 0) * 1000) / 10;

    return {
      ...best,
      stranded:  false,
      reasoning: `${detName}: ${curName} \u2192 ${destName} via ${best.useType} ` +
                 `(belief ${beliefPct}%, score ${Math.round(best.score)})`,
    };
  }
}


/* ================================================================================
 * [SECTION 3]  DetectiveMind \u2014 Bayesian belief state + movement orchestrator
 * ================================================================================ */
class DetectiveMind {
  constructor(graph, nodeCount = 200) {
    this.graph      = graph;
    this.planner    = new TicketPlanner(graph);
    this.nodeCount  = nodeCount;

    // Belief state
    this.beliefMap    = new Map();   // Map<nodeId, float>  sums to 1.0
    this.candidateSet = new Set();   // Set<nodeId>  non-negligible nodes

    // Evidence records
    this.moveLog       = [];   // Array<{round, type, isFog, isBluff, snapshotSize}>
    this.revealHistory = [];   // Array<{round, nodeId}>

    // Reasoning log (surfaced to UI/coach)
    this.deductionLog  = [];   // Array<string>

    // Tuning constants
    this.BELIEF_FLOOR        = 0.0001;   // below this: prune from candidateSet
    this.CERTAINTY_THRESHOLD = 0.70;     // above this: isConfident() = true
    this.REVEAL_CERTAINTY    = 0.92;     // fraction of mass placed on reveal node
    this.CLUSTER_RADIUS      = 2;        // nodes within N hops share a cluster

    this._initialized = false;
  }

  // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  //  3A \u2014 INITIALISATION
  // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  /**
   * Call once at game start. Uniform prior over all nodes except detective
   * starting positions (Moriarty cannot share a node with a detective).
   *
   * @param {number[]} excludeNodes  detective starting positions
   */
  init(excludeNodes = []) {
    this.beliefMap.clear();
    this.candidateSet.clear();
    this.moveLog       = [];
    this.revealHistory = [];
    this.deductionLog  = [];
    this._initialized  = true;

    const excluded = new Set(excludeNodes);
    const eligible  = [];
    for (let id = 0; id < this.nodeCount; id++) {
      if (!excluded.has(id)) eligible.push(id);
    }

    const p = 1.0 / eligible.length;
    for (const id of eligible) {
      this.beliefMap.set(id, p);
      this.candidateSet.add(id);
    }

    this._log(`INIT: uniform prior over ${eligible.length} nodes. ` +
              `Detective start positions excluded.`);
  }

  // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  //  3B \u2014 EVIDENCE INTAKE
  //  These four methods are the only way new evidence enters the belief state.
  //  Each one performs a Bayesian update and renormalises.
  // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  /**
   * Moriarty used a known transport type this round.
   *
   * Bayesian forward filter:
   *   For each candidate C, find all type-neighbours N.
   *   Distribute belief(C) / |type-neighbours(C)| to each N.
   *   Candidates with no type-edges are eliminated (impossible starting point).
   *
   * This is P(position_now | transport_observed, position_before).
   *
   * @param {number}  round
   * @param {string}  type      'cab'|'tram'|'underground'|'river'
   * @param {boolean} isBluff   true if this is the 2nd move of a Double Bluff
   */
  observeTransport(round, type, isBluff = false) {
    this._requireInit();
    const before    = this.candidateSet.size;
    const newBelief = new Map();

    for (const candId of this.candidateSet) {
      const p = this.beliefMap.get(candId) || 0;
      if (p < this.BELIEF_FLOOR) continue;

      const neighbors = this.graph.getNeighbors(candId, type);
      if (neighbors.length === 0) continue;  // no such exit: eliminate

      const share = p / neighbors.length;
      for (const { node: nId } of neighbors) {
        newBelief.set(nId, (newBelief.get(nId) || 0) + share);
      }
    }

    this._applyNewBelief(newBelief);
    this.moveLog.push({ round, type, isFog: false, isBluff, snapshotSize: before });

    const pruned = before - this.candidateSet.size;
    this._log(
      `R${round}${isBluff ? '[B2]' : ''} ${type.toUpperCase()}: ` +
      `${before} \u2192 ${this.candidateSet.size} candidates` +
      (pruned > 0 ? ` (${pruned} eliminated \u2014 no ${type} exit)` : '')
    );

    this._checkCertainty(round);
    return this;
  }

  /**
   * Heavy Fog ticket: transport type unknown, any neighbour valid.
   * Candidate set broadens \u2014 this is intentional, Fog is Moriarty's best tool.
   */
  observeFog(round, isBluff = false) {
    this._requireInit();
    const before    = this.candidateSet.size;
    const newBelief = new Map();

    for (const candId of this.candidateSet) {
      const p = this.beliefMap.get(candId) || 0;
      if (p < this.BELIEF_FLOOR) continue;

      const neighbors = this.graph.getNeighbors(candId, null);  // all types
      if (neighbors.length === 0) continue;

      const share = p / neighbors.length;
      for (const { node: nId } of neighbors) {
        newBelief.set(nId, (newBelief.get(nId) || 0) + share);
      }
    }

    this._applyNewBelief(newBelief);
    this.moveLog.push({ round, type: 'fog', isFog: true, isBluff, snapshotSize: before });
    this._log(
      `R${round}${isBluff ? '[B2]' : ''} HEAVY FOG: all types valid. ` +
      `${before} \u2192 ${this.candidateSet.size} candidates.`
    );

    this._checkCertainty(round);
    return this;
  }

  /**
   * Reveal round: Moriarty confirmed at nodeId.
   *
   * REVEAL_CERTAINTY (92%) of belief mass collapses to the reveal node.
   * Remaining 8% spreads to direct neighbours \u2014 Moriarty will flee next round.
   *
   * @param {number} round
   * @param {number} nodeId
   */
  observeReveal(round, nodeId) {
    this._requireInit();
    const newBelief = new Map();
    const neighbors = this.graph.getNeighbors(nodeId, null);
    const residual  = 1.0 - this.REVEAL_CERTAINTY;

    newBelief.set(nodeId, this.REVEAL_CERTAINTY);
    if (neighbors.length > 0) {
      const share = residual / neighbors.length;
      for (const { node: nId } of neighbors) {
        newBelief.set(nId, (newBelief.get(nId) || 0) + share);
      }
    }

    this._applyNewBelief(newBelief);
    this.revealHistory.push({ round, nodeId });

    const name = this.graph.nodes[node
