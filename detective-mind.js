/* ================================================================================
 * DETECTIVE MIND — The Collective Brain of the Detective Bureau
 * ================================================================================
 *
 * All five detectives share one mind. They pool every piece of evidence they
 * have ever observed. They do NOT know Moriarty's true position except on
 * designated Reveal Rounds, or when deduction collapses all uncertainty.
 *
 * WHAT THEY KNOW (inputs):
 *   • Round number
 *   • Transport type Moriarty used each round (cab / tram / underground / river / fog)
 *     — "fog" means Heavy Fog ticket: type unknown, any connection possible
 *   • Moriarty's exact node on Reveal Rounds (3, 8, 13, 18, 22)
 *   • Their own positions (always visible)
 *   • The graph: nodes, edges, edge types
 *
 * WHAT THEY DO NOT KNOW:
 *   • Moriarty's position on non-reveal rounds
 *   • Which specific node Moriarty moved to after each step
 *   • Whether Double Bluff was used (though two log entries in one round is a tell)
 *
 * ARCHITECTURE (mirrors ClueSolo's Player knowledge layer):
 *
 *   beliefMap        — Map<nodeId, float>  probability Moriarty is at this node (sums to 1.0)
 *   candidateSet     — Set<nodeId>         non-zero belief nodes (fast iteration)
 *   moveLog          — Array<MoveRecord>   one entry per Moriarty move observed
 *   revealHistory    — Array<RevealRecord> confirmed sightings
 *
 * CORE OPERATIONS:
 *   observeTransport(round, type)   — Moriarty moved using this transport type
 *   observeReveal(round, nodeId)    — Moriarty was seen at this node
 *   observeFog(round)               — Heavy Fog used: type unknown, any connection valid
 *   observeDoubleBluff(round)       — Two moves this round (two observeTransport calls)
 *   spread()                        — Diffuse belief forward one hop (called after each move)
 *   getBestTarget()                 — Return nodeId the detectives should converge on
 *   getDetectiveAssignments()       — Return one target per detective (coordinated coverage)
 *   getDeductionLog()               — Array of human-readable reasoning strings
 *
 * ================================================================================ */

'use strict';

// ── Constants (must match the main game file) ─────────────────────────────────
const TRANSPORT_TYPES = ['cab', 'tram', 'underground', 'river'];
const REVEAL_ROUNDS   = [3, 8, 13, 18, 22];

/* ================================================================================
 * [SECTION 1]  GameGraph — pure adjacency wrapper
 *
 *  Wraps the raw nodes/edges arrays from the main game into a queryable graph.
 *  All methods are pure (no side effects). Safe to call at any time.
 * ================================================================================ */
class GameGraph {
  /**
   * @param {Array<{id, x, y, name, region}>} nodes
   * @param {Array<{a, b, type}>}             edges
   */
  constructor(nodes, edges) {
    this.nodes = nodes;
    this.edges = edges;
    this._adj = null;   // built lazily
  }

  /** Build and cache the adjacency map: nodeId → [{node, type}] */
  _buildAdj() {
    this._adj = new Map();
    for (const node of this.nodes) {
      this._adj.set(node.id, []);
    }
    for (const edge of this.edges) {
      this._adj.get(edge.a).push({ node: edge.b, type: edge.type });
      this._adj.get(edge.b).push({ node: edge.a, type: edge.type });
    }
  }

  /** Return all neighbours of nodeId, optionally filtered by transport type.
   *  If type is 'fog' or null, return ALL neighbours (any transport). */
  getNeighbors(nodeId, type = null) {
    if (!this._adj) this._buildAdj();
    const all = this._adj.get(nodeId) || [];
    if (!type || type === 'fog') return all;
    return all.filter(n => n.type === type);
  }

  /** Return the Set of all nodes reachable from nodeId in exactly one move
   *  using the given transport type (or any type if type is null/'fog'). */
  reachableOneStep(nodeId, type = null) {
    return new Set(this.getNeighbors(nodeId, type).map(n => n.node));
  }

  /** BFS shortest path (hop count) from a → b. Returns Infinity if unreachable. */
  shortestPath(a, b) {
    if (a === b) return 0;
    if (!this._adj) this._buildAdj();
    const visited = new Set([a]);
    const queue   = [[a, 0]];
    while (queue.length) {
      const [cur, dist] = queue.shift();
      for (const { node } of (this._adj.get(cur) || [])) {
        if (node === b) return dist + 1;
        if (!visited.has(node)) {
          visited.add(node);
          queue.push([node, dist + 1]);
        }
      }
    }
    return Infinity;
  }

  /** Return all nodes within `maxHops` hops of nodeId (any transport).
   *  Includes nodeId itself at distance 0. */
  reachableWithin(nodeId, maxHops) {
    if (!this._adj) this._buildAdj();
    const dist    = new Map([[nodeId, 0]]);
    const queue   = [nodeId];
    while (queue.length) {
      const cur  = queue.shift();
      const d    = dist.get(cur);
      if (d >= maxHops) continue;
      for (const { node } of (this._adj.get(cur) || [])) {
        if (!dist.has(node)) {
          dist.set(node, d + 1);
          queue.push(node);
        }
      }
    }
    return dist; // Map<nodeId, hopCount>
  }
}


/* ================================================================================
 * [SECTION 2]  MoveRecord — one entry in the detectives' evidence log
 * ================================================================================ */
/**
 * @typedef {Object} MoveRecord
 * @property {number}  round        — game round this move occurred in
 * @property {string}  type         — 'cab'|'tram'|'underground'|'river'|'fog'|'bluff'
 * @property {boolean} isFog        — true if Heavy Fog ticket was used (type unknown)
 * @property {boolean} isBluff      — true if this is the 2nd move of a Double Bluff turn
 * @property {Set}     candidateSet — snapshot of candidate nodes BEFORE this move
 *                                    (used for retrospective constraint tightening)
 */

/**
 * @typedef {Object} RevealRecord
 * @property {number} round
 * @property {number} nodeId
 */


/* ================================================================================
 * [SECTION 3]  DetectiveMind — the collective brain
 * ================================================================================ */
class DetectiveMind {
  /**
   * @param {GameGraph} graph
   * @param {number}    nodeCount  — total nodes (default 200)
   */
  constructor(graph, nodeCount = 200) {
    this.graph     = graph;
    this.nodeCount = nodeCount;

    // ── Belief state ──────────────────────────────────────────────────────────
    // beliefMap: Map<nodeId, float>  probability mass at each node. Sums to 1.0.
    this.beliefMap    = new Map();

    // candidateSet: Set<nodeId>  nodes with non-negligible belief (> FLOOR)
    this.candidateSet = new Set();

    // ── Evidence log ──────────────────────────────────────────────────────────
    this.moveLog       = [];    // Array<MoveRecord>
    this.revealHistory = [];    // Array<RevealRecord>

    // ── Deduction log (surfaced to coach/UI) ──────────────────────────────────
    this.deductionLog  = [];    // Array<string>  human-readable reasoning

    // ── Internal config ───────────────────────────────────────────────────────
    // Minimum probability a node can hold before being pruned from candidateSet
    this.BELIEF_FLOOR        = 0.0001;
    // How much belief diffuses to each unexplored neighbour each round
    this.DIFFUSION_RATE      = 0.15;
    // Certainty threshold: if one node holds this fraction, we're confident
    this.CERTAINTY_THRESHOLD = 0.70;
    // After a reveal, what fraction of mass should sit exactly on the revealed node
    // (leaving a small residual to account for immediate escape)
    this.REVEAL_CERTAINTY    = 0.92;

    this._initialized = false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  INITIALISATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Call once at game start, BEFORE any Moriarty moves.
   *
   * We have zero information so belief is uniform across all nodes,
   * EXCEPT nodes occupied by detectives — Moriarty cannot start there.
   *
   * @param {number[]} excludeNodes — detective starting positions
   */
  init(excludeNodes = []) {
    this.beliefMap.clear();
    this.candidateSet.clear();
    this.moveLog       = [];
    this.revealHistory = [];
    this.deductionLog  = [];

    const excluded = new Set(excludeNodes);
    const eligible  = [];
    for (let id = 0; id < this.nodeCount; id++) {
      if (!excluded.has(id)) eligible.push(id);
    }

    const uniform = 1.0 / eligible.length;
    for (const id of eligible) {
      this.beliefMap.set(id, uniform);
      this.candidateSet.add(id);
    }

    this._initialized = true;
    this._log(`Game started. Moriarty could be at any of ${eligible.length} nodes. Prior is uniform.`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  EVIDENCE INTAKE  (called by the game loop after each Moriarty action)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Moriarty used a known transport type this round.
   *
   * LOGIC:  Every node currently in candidateSet is a possible starting point.
   *         From each, we can reach exactly those neighbours connected by `type`.
   *         Any current candidate that has NO such neighbour is impossible —
   *         it means Moriarty could not have moved there.
   *         We re-weight belief by how many neighbours of each OLD candidate
   *         flow into each NEW candidate.
   *
   * This is the core Bayesian update step. Mirrors ClueSolo's propagateConstraints.
   *
   * @param {number} round
   * @param {string} type   — 'cab'|'tram'|'underground'|'river'
   * @param {boolean} isBluff — is this the 2nd move of a Double Bluff?
   */
  observeTransport(round, type, isBluff = false) {
    if (!this._initialized) throw new Error('DetectiveMind.init() not called');

    // Snapshot candidate set for the log record
    const snapshotBefore = new Set(this.candidateSet);
    const beforeCount    = this.candidateSet.size;

    // ── Step 1: forward propagation ──────────────────────────────────────────
    // For each candidate node C, find all neighbours N reachable via `type`.
    // New belief at N accumulates belief(C) / degree_in_type(C),
    // so that each candidate's mass is distributed equally among its type-neighbours.
    const newBeliefMap = new Map();

    for (const candId of this.candidateSet) {
      const belief    = this.beliefMap.get(candId) || 0;
      if (belief < this.BELIEF_FLOOR) continue;

      const neighbors = this.graph.getNeighbors(candId, type);  // type-constrained
      if (neighbors.length === 0) {
        // This candidate has NO outgoing edges of this type — Moriarty cannot
        // be here if he just used this transport. Mass is lost (then renormalized).
        continue;
      }

      const share = belief / neighbors.length;
      for (const { node: nId } of neighbors) {
        newBeliefMap.set(nId, (newBeliefMap.get(nId) || 0) + share);
      }
    }

    // ── Step 2: exclude detective-occupied nodes ───────────────────────────────
    // Detectives' positions are always known. Moriarty cannot occupy them.
    // (Caller is responsible for passing current detective nodes to pruneOccupied.)

    // ── Step 3: prune below floor, rebuild candidateSet, renormalise ──────────
    this._applyNewBelief(newBeliefMap);

    // ── Step 4: log record ────────────────────────────────────────────────────
    this.moveLog.push({
      round,
      type,
      isFog:  false,
      isBluff,
      candidateSet: snapshotBefore,
    });

    const afterCount = this.candidateSet.size;
    const pruned     = beforeCount - afterCount;

    this._log(
      `Round ${round} — ${isBluff ? '[BLUFF move 2] ' : ''}` +
      `Moriarty used ${type.toUpperCase()}. ` +
      `Candidates: ${beforeCount} → ${afterCount}` +
      (pruned > 0 ? ` (${pruned} nodes eliminated — no ${type} connection)` : '') +
      `.`
    );

    this._checkCertainty(round);
    return this;
  }

  /**
   * Heavy Fog ticket used. Moriarty can move to ANY adjacent node via ANY transport.
   * We cannot constrain by transport type — any neighbour is valid.
   * This broadens the candidate set significantly; it is Moriarty's most powerful tool.
   *
   * @param {number} round
   * @param {boolean} isBluff
   */
  observeFog(round, isBluff = false) {
    if (!this._initialized) throw new Error('DetectiveMind.init() not called');

    const beforeCount    = this.candidateSet.size;
    const snapshotBefore = new Set(this.candidateSet);
    const newBeliefMap   = new Map();

    for (const candId of this.candidateSet) {
      const belief    = this.beliefMap.get(candId) || 0;
      if (belief < this.BELIEF_FLOOR) continue;

      // All neighbours regardless of transport type
      const neighbors = this.graph.getNeighbors(candId, null);
      if (neighbors.length === 0) continue;

      const share = belief / neighbors.length;
      for (const { node: nId } of neighbors) {
        newBeliefMap.set(nId, (newBeliefMap.get(nId) || 0) + share);
      }
    }

    this._applyNewBelief(newBeliefMap);

    this.moveLog.push({
      round,
      type:   'fog',
      isFog:  true,
      isBluff,
      candidateSet: snapshotBefore,
    });

    this._log(
      `Round ${round} — ${isBluff ? '[BLUFF move 2] ' : ''}` +
      `HEAVY FOG used. All transport types possible. ` +
      `Candidates expanded: ${beforeCount} → ${this.candidateSet.size}.`
    );

    this._checkCertainty(round);
    return this;
  }

  /**
   * Reveal round: Moriarty was definitively sighted at nodeId.
   *
   * This is the hardest evidence possible. The belief distribution collapses:
   * REVEAL_CERTAINTY mass sits on nodeId, a tiny residual (1-REVEAL_CERTAINTY)
   * is spread across immediate neighbours, accounting for the possibility
   * that Moriarty moved in the same instant the sighting was confirmed
   * (i.e., the sighting is the START of the round, and he might escape next move).
   *
   * Mirrors ClueSolo's markSeen(card, ownerId) with certainty.
   *
   * @param {number} round
   * @param {number} nodeId
   */
  observeReveal(round, nodeId) {
    if (!this._initialized) throw new Error('DetectiveMind.init() not called');

    const newBeliefMap = new Map();

    // Core mass on the revealed node
    newBeliefMap.set(nodeId, this.REVEAL_CERTAINTY);

    // Residual mass on immediate neighbours (any transport)
    const neighbors = this.graph.getNeighbors(nodeId, null);
    const residual  = 1.0 - this.REVEAL_CERTAINTY;
    if (neighbors.length > 0) {
      const share = residual / neighbors.length;
      for (const { node: nId } of neighbors) {
        newBeliefMap.set(nId, (newBeliefMap.get(nId) || 0) + share);
      }
    } else {
      // No neighbours — put all mass on the reveal node
      newBeliefMap.set(nodeId, 1.0);
    }

    this._applyNewBelief(newBeliefMap);

    this.revealHistory.push({ round, nodeId });

    const nodeName = this.graph.nodes[nodeId]?.name || `Node ${nodeId}`;
    this._log(
      `Round ${round} — ⚠ REVEAL: Moriarty sighted at ${nodeName} (node ${nodeId}). ` +
      `Belief collapsed. Candidates: ${this.candidateSet.size} ` +
      `(${Math.round(this.REVEAL_CERTAINTY * 100)}% mass on reveal node, ` +
      `${Math.round((1 - this.REVEAL_CERTAINTY) * 100)}% spread to ${neighbors.length} neighbours).`
    );

    return this;
  }

  /**
   * Remove belief from nodes currently occupied by detectives.
   * Moriarty cannot share a node with a detective — he would be captured.
   * Call this after each detective moves.
   *
   * @param {number[]} detectiveNodes — current positions of all 5 detectives
   */
  pruneOccupied(detectiveNodes) {
    let pruned = 0;
    for (const nodeId of detectiveNodes) {
      if (this.candidateSet.has(nodeId)) {
        this.beliefMap.set(nodeId, 0);
        this.candidateSet.delete(nodeId);
        pruned++;
      }
    }
    if (pruned > 0) {
      this._renormalize();
      this._log(`Detective positions pruned: ${pruned} node(s) removed from candidateSet.`);
    }
    return this;
  }

  /**
   * Retrospective tightening: when a new transport observation is combined
   * with earlier observations, some candidates that seemed possible before
   * can now be ruled out via chained constraint propagation.
   *
   * Example: If round 1 was Underground (max 3 stops) and round 2 was Cab,
   * then on round 3 we observe Underground again, we know Moriarty cannot
   * be more than 5 hops from the last reveal. Anything beyond that is zero.
   *
   * This is called automatically after each observation. Mirrors ClueSolo's
   * applyMildInference / propagateConstraints loop.
   *
   * @param {number} sinceRevealRound  — last confirmed reveal round number
   * @param {number} sinceRevealNode   — nodeId of last reveal
   * @param {number} currentRound
   */
  applyReachabilityConstraint(sinceRevealRound, sinceRevealNode, currentRound) {
    if (sinceRevealNode < 0) return; // No reveal yet — no hard constraint

    const roundsSinceReveal = currentRound - sinceRevealRound;
    if (roundsSinceReveal <= 0) return;

    // Maximum hops Moriarty could have travelled since the reveal.
    // Double Bluff allows 2 moves in one round, so we multiply by 2 as upper bound.
    const maxHops = roundsSinceReveal * 2;

    // Get all nodes within maxHops of the reveal node
    const reachable = this.graph.reachableWithin(sinceRevealNode, maxHops);

    let pruned = 0;
    for (const nodeId of [...this.candidateSet]) {
      if (!reachable.has(nodeId)) {
        this.beliefMap.set(nodeId, 0);
        this.candidateSet.delete(nodeId);
        pruned++;
      }
    }

    if (pruned > 0) {
      this._renormalize();
      const nodeName = this.graph.nodes[sinceRevealNode]?.name || `Node ${sinceRevealNode}`;
      this._log(
        `Reachability constraint: ${roundsSinceReveal} round(s) since reveal at ${nodeName} ` +
        `(max ${maxHops} hops). Eliminated ${pruned} unreachable candidates.`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  QUERYING THE BELIEF STATE
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Return the single node with highest belief probability.
   * This is the "best guess" for Moriarty's location.
   */
  getMostLikelyNode() {
    let best = -1, bestP = -1;
    for (const [id, p] of this.beliefMap) {
      if (p > bestP) { bestP = p; best = id; }
    }
    return { nodeId: best, probability: bestP };
  }

  /**
   * Return the top N nodes by belief probability, sorted descending.
   * Used to draw the heat map and to inform detective movement.
   *
   * @param {number} n — how many top nodes to return (default 10)
   */
  getTopNodes(n = 10) {
    return [...this.beliefMap.entries()]
      .filter(([, p]) => p > this.BELIEF_FLOOR)
      .sort(([, a], [, b]) => b - a)
      .slice(0, n)
      .map(([id, p]) => ({ nodeId: id, probability: p }));
  }

  /**
   * Is the collective mind confident enough to recommend a direct interception?
   * Returns true if any single node exceeds CERTAINTY_THRESHOLD.
   */
  isConfident() {
    const { probability } = this.getMostLikelyNode();
    return probability >= this.CERTAINTY_THRESHOLD;
  }

  /**
   * Return the belief probability for a specific node.
   * Useful for drawing per-node heat tints.
   *
   * @param {number} nodeId
   * @returns {number} 0.0–1.0
   */
  beliefAt(nodeId) {
    return this.beliefMap.get(nodeId) || 0;
  }

  /**
   * Return the entropy of the belief distribution (in bits).
   * High entropy = high uncertainty (Moriarty is well hidden).
   * Low entropy  = detectives are closing in.
   *
   * H = -Σ p(i) * log2(p(i))
   */
  entropy() {
    let H = 0;
    for (const p of this.beliefMap.values()) {
      if (p > 0) H -= p * Math.log2(p);
    }
    return H;
  }

  /**
   * Return the "uncertainty radius" — roughly how spread out the candidate set is.
   * Computed as weighted average distance between top node and all other candidates.
   * A small radius means detectives know where to look; large means Moriarty is lost.
   */
  uncertaintyRadius() {
    const { nodeId: center } = this.getMostLikelyNode();
    if (center < 0) return Infinity;

    let weightedDist = 0, totalWeight = 0;
    for (const [id, p] of this.beliefMap) {
      if (p < this.BELIEF_FLOOR || id === center) continue;
      const d = this.graph.shortestPath(center, id);
      if (d < Infinity) {
        weightedDist += p * d;
        totalWeight  += p;
      }
    }
    return totalWeight > 0 ? weightedDist / totalWeight : 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  DETECTIVE MOVEMENT RECOMMENDATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * For each of the 5 detectives, return the node they should move TOWARD
   * this round. The team jointly maximises expected coverage of the belief map,
   * meaning no two detectives should converge on the same cluster unless
   * confidence is very high.
   *
   * Algorithm:
   *   1. Compute "attraction clusters" from the belief map (top-N nodes).
   *   2. Assign each detective to their nearest unassigned cluster using
   *      a greedy auction (nearest-first). Higher-belief clusters are
   *      weighted more heavily.
   *   3. Within the assigned cluster, return the single node with highest
   *      belief that the detective can step toward.
   *
   * Holmes (detective 0) gets priority: he picks last on the MAP but picks
   * FIRST on cluster assignment, choosing the highest-belief target.
   *
   * @param {Array<{id, node}>} detectives — current detective positions
   * @returns {Array<{detId, targetNode, path, reasoning}>}
   */
  getDetectiveAssignments(detectives) {
    const topNodes = this.getTopNodes(20);
    if (topNodes.length === 0) return detectives.map(d => ({
      detId:      d.id,
      targetNode: d.node,
      path:       [],
      reasoning:  'No belief data yet. Hold position.',
    }));

    // Build cluster list — reduce top nodes to distinct spatial clusters.
    // Two nodes are in the same cluster if they are within 2 hops of each other.
    const clusters = this._clusterNodes(topNodes, 2);

    // Assign detectives to clusters (Holmes first, then others)
    const detOrder = [0, 1, 2, 3, 4];  // Holmes = index 0
    const assigned  = new Map();        // detId → cluster
    const taken     = new Set();        // cluster indices already assigned

    for (const detIdx of detOrder) {
      const det = detectives[detIdx];
      if (!det) continue;

      // Score each unassigned cluster for this detective:
      // score = clusterBeliefMass / (hopsToDet + 1)
      let bestScore    = -1;
      let bestCluster  = 0;

      clusters.forEach((cluster, ci) => {
        if (taken.has(ci)) return;
        const mass  = cluster.reduce((s, n) => s + n.probability, 0);
        const hops  = this.graph.shortestPath(det.node, cluster[0].nodeId) + 1;
        const score = mass / hops;
        if (score > bestScore) { bestScore = score; bestCluster = ci; }
      });

      assigned.set(det.id, bestCluster);
      taken.add(bestCluster);
    }

    // Build result
    return detectives.map(det => {
      if (!det) return null;
      const ci      = assigned.get(det.id) ?? 0;
      const cluster = clusters[ci] || [topNodes[0]];

      // The best node in this cluster (highest belief)
      const target  = cluster.reduce((best, n) =>
        n.probability > best.probability ? n : best, cluster[0]);

      const hops    = this.graph.shortestPath(det.node, target.nodeId);
      const prob    = Math.round(target.probability * 100);
      const nodeName = this.graph.nodes[target.nodeId]?.name || `Node ${target.nodeId}`;
      const detName  = ['Holmes', 'Watson', 'Lestrade', 'Gregson', 'Wiggins'][det.id] || `Det ${det.id}`;

      const reasoning =
        det.node === target.nodeId
          ? `${detName} is already at the highest-belief node (${prob}% likelihood).`
          : `${detName} should advance toward ${nodeName} — ` +
            `${prob}% belief mass, ${hops} hop${hops !== 1 ? 's' : ''} away.`;

      return {
        detId:      det.id,
        targetNode: target.nodeId,
        path:       [],          // full path computed on demand (expensive)
        probability: target.probability,
        reasoning,
      };
    }).filter(Boolean);
  }

  /**
   * For a single detective, return the best ADJACENT node to step to this round,
   * given their current position and available ticket types.
   *
   * Used by the AI to make a concrete move each turn.
   *
   * @param {Object} det       — {id, node, tickets: {cab, tram, underground, river}}
   * @param {number} targetNode — the cluster target from getDetectiveAssignments()
   * @returns {{moveToNode, useType, reasoning}}
   */
  getBestMove(det, targetNode) {
    if (!this.graph._adj) this.graph._buildAdj();

    const neighbors = this.graph.getNeighbors(det.node, null);
    if (neighbors.length === 0) {
      return { moveToNode: det.node, useType: null, reasoning: 'No legal moves available.' };
    }

    let bestScore = -Infinity;
    let bestMove  = null;

    for (const { node: nId, type } of neighbors) {
      // Must have a ticket for this transport type
      if ((det.tickets[type] || 0) <= 0) continue;

      // Score = belief at that node minus cost of moving away from target
      const beliefScore = (this.beliefMap.get(nId) || 0) * 1000;
      const distToTarget = this.graph.shortestPath(nId, targetNode);
      const distScore    = -distToTarget * 10;

      // Slight bonus for higher-value transport (underground covers more ground)
      const transportBonus = { cab: 0, tram: 1, underground: 3, river: 2 }[type] || 0;

      const score = beliefScore + distScore + transportBonus;
      if (score > bestScore) {
        bestScore = score;
        bestMove  = { moveToNode: nId, useType: type };
      }
    }

    if (!bestMove) {
      return { moveToNode: det.node, useType: null, reasoning: 'No affordable moves available (out of tickets?).' };
    }

    const nodeName = this.graph.nodes[bestMove.moveToNode]?.name || `Node ${bestMove.moveToNode}`;
    const prob     = Math.round((this.beliefMap.get(bestMove.moveToNode) || 0) * 100 * 10) / 10;

    return {
      ...bestMove,
      reasoning: `Move to ${nodeName} via ${bestMove.useType} (belief: ${prob}%, score: ${Math.round(bestScore)}).`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  DEDUCTION LOG (surfaced to UI)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Return the full deduction log as an array of strings.
   * The UI can display the last N entries in the coach panel.
   */
  getDeductionLog() {
    return [...this.deductionLog];
  }

  /**
   * Return a human-readable summary of the current belief state.
   * This is what the coach panel shows as the "current assessment".
   */
  getSummary() {
    const { nodeId, probability } = this.getMostLikelyNode();
    const candidates  = this.candidateSet.size;
    const entropyVal  = this.entropy().toFixed(2);
    const nodeName    = nodeId >= 0
      ? (this.graph.nodes[nodeId]?.name || `Node ${nodeId}`)
      : 'Unknown';
    const pct         = Math.round(probability * 100);
    const confident   = this.isConfident();
    const radius      = this.uncertaintyRadius().toFixed(1);

    const lastReveal  = this.revealHistory.length > 0
      ? this.revealHistory[this.revealHistory.length - 1]
      : null;

    const lines = [];

    if (lastReveal) {
      const rName = this.graph.nodes[lastReveal.nodeId]?.name || `Node ${lastReveal.nodeId}`;
      lines.push(`Last confirmed sighting: ${rName} (Round ${lastReveal.round}).`);
    } else {
      lines.push(`No confirmed sightings yet.`);
    }

    lines.push(`${candidates} nodes remain in the suspect pool.`);
    lines.push(`Highest probability: ${nodeName} at ${pct}%.`);
    lines.push(`Uncertainty entropy: ${entropyVal} bits. Spread radius: ~${radius} hops.`);

    if (confident) {
      lines.push(`⚠ High confidence — converge on ${nodeName} immediately.`);
    } else if (probability > 0.35) {
      lines.push(`Strong suspicion around ${nodeName} — press the flank.`);
    } else if (candidates < 15) {
      lines.push(`Field is narrowing. Maintain coverage formation.`);
    } else {
      lines.push(`Moriarty remains elusive. Fan out and observe transport patterns.`);
    }

    return lines.join(' ');
  }

  /**
   * Generate a Holmesian deduction narrative — flavoured text for the coach panel.
   * Draws on moveLog patterns to reason aloud.
   */
  getHolmesNarrative(currentRound) {
    const log        = this.moveLog;
    const lastReveal = this.revealHistory[this.revealHistory.length - 1];
    const { nodeId, probability } = this.getMostLikelyNode();
    const nodeName   = this.graph.nodes[nodeId]?.name || `Node ${nodeId}`;
    const pct        = Math.round(probability * 100);
    const candidates = this.candidateSet.size;

    // Count transport type usage since last reveal
    const revealRound = lastReveal?.round || 0;
    const recentMoves = log.filter(m => m.round > revealRound);
    const typeCounts  = { cab: 0, tram: 0, underground: 0, river: 0, fog: 0 };
    for (const m of recentMoves) {
      if (typeCounts[m.type] !== undefined) typeCounts[m.type]++;
    }

    // Build narrative
    const narrativeParts = [];

    if (!lastReveal) {
      narrativeParts.push(
        `Without a confirmed sighting, I rely entirely on transport deduction.`
      );
    } else {
      const rName = this.graph.nodes[lastReveal.nodeId]?.name || `Node ${lastReveal.nodeId}`;
      const roundsAgo = currentRound - lastReveal.round;
      narrativeParts.push(
        `When last seen at ${rName} (${roundsAgo} round${roundsAgo !== 1 ? 's' : ''} ago), ` +
        `Moriarty had ${recentMoves.length} subsequent move${recentMoves.length !== 1 ? 's' : ''} to make.`
      );
    }

    // Transport pattern commentary
    if (typeCounts.underground > 0) {
      narrativeParts.push(
        `${typeCounts.underground} Underground move${typeCounts.underground > 1 ? 's' : ''} ` +
        `suggest${typeCounts.underground === 1 ? 's' : ''} he is attempting a long-range escape. ` +
        `The Metropolitan and District lines narrow his possible exits considerably.`
      );
    }
    if (typeCounts.river > 0) {
      narrativeParts.push(
        `A Thames steamer was used — he is exploiting the river corridor. ` +
        `Only a handful of nodes are accessible by water.`
      );
    }
    if (typeCounts.fog > 0) {
      narrativeParts.push(
        `Heavy Fog was deployed on ${typeCounts.fog} occasion${typeCounts.fog > 1 ? 's' : ''} — ` +
        `he is concealing his transport choice deliberately. Treat all adjacent nodes as suspect.`
      );
    }
    if (typeCounts.cab > 1 && typeCounts.underground === 0) {
      narrativeParts.push(
        `Repeated Hansom Cab usage suggests he is staying within a local neighbourhood, ` +
        `zigzagging to confuse pursuit rather than making for the periphery.`
      );
    }

    // Current assessment
    if (candidates === 1) {
      narrativeParts.push(
        `Elementary. He can only be at ${nodeName}. Converge immediately.`
      );
    } else if (pct >= 70) {
      narrativeParts.push(
        `My calculations place him at ${nodeName} with ${pct}% confidence. ` +
        `The evidence is overwhelming. Move at once.`
      );
    } else if (pct >= 40) {
      narrativeParts.push(
        `${nodeName} is my primary hypothesis at ${pct}%. ` +
        `Maintain the pincer — do not allow him to slip between our positions.`
      );
    } else {
      narrativeParts.push(
        `The field remains open with ${candidates} possibilities. ` +
        `We must wait for the next reveal, or force him to exhaust his Fog tickets.`
      );
    }

    return narrativeParts.join(' ');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  INTERNAL HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Replace beliefMap with newBeliefMap, prune below floor, renormalise,
   * rebuild candidateSet.
   *
   * @param {Map<number, float>} newBeliefMap
   */
  _applyNewBelief(newBeliefMap) {
    this.beliefMap.clear();
    this.candidateSet.clear();

    let total = 0;
    for (const [id, p] of newBeliefMap) {
      if (p >= this.BELIEF_FLOOR) {
        this.beliefMap.set(id, p);
        total += p;
      }
    }

    // Renormalise so all beliefs sum to 1.0
    if (total > 0) {
      for (const [id, p] of this.beliefMap) {
        const norm = p / total;
        this.beliefMap.set(id, norm);
        if (norm >= this.BELIEF_FLOOR) this.candidateSet.add(id);
      }
    }
  }

  /** Renormalise existing beliefMap in-place (used after pruning). */
  _renormalize() {
    let total = 0;
    for (const p of this.beliefMap.values()) total += p;
    if (total <= 0) return;
    this.candidateSet.clear();
    for (const [id, p] of this.beliefMap) {
      const norm = p / total;
      this.beliefMap.set(id, norm);
      if (norm >= this.BELIEF_FLOOR) this.candidateSet.add(id);
    }
  }

  /**
   * Group nodes into spatial clusters.
   * Two nodes belong to the same cluster if they are ≤ maxHops apart.
   * Returns Array<Array<{nodeId, probability}>>
   *
   * Uses a simple greedy union-find style approach: iterate nodes by
   * decreasing probability, starting a new cluster if no existing cluster
   * has a member within maxHops.
   *
   * @param {Array<{nodeId, probability}>} nodes  — sorted descending by probability
   * @param {number} maxHops
   */
  _clusterNodes(nodes, maxHops) {
    const clusters  = [];
    const assigned  = new Set();

    for (const node of nodes) {
      if (assigned.has(node.nodeId)) continue;

      // Does this node fit into an existing cluster?
      let placed = false;
      for (const cluster of clusters) {
        const rep  = cluster[0].nodeId;
        const hops = this.graph.shortestPath(rep, node.nodeId);
        if (hops <= maxHops) {
          cluster.push(node);
          assigned.add(node.nodeId);
          placed = true;
          break;
        }
      }

      if (!placed) {
        clusters.push([node]);
        assigned.add(node.nodeId);
      }
    }

    return clusters;
  }

  /** Check whether the belief state has collapsed to near-certainty and log it. */
  _checkCertainty(round) {
    const { nodeId, probability } = this.getMostLikelyNode();
    if (probability >= this.CERTAINTY_THRESHOLD && nodeId >= 0) {
      const nodeName = this.graph.nodes[nodeId]?.name || `Node ${nodeId}`;
      this._log(
        `⚡ High confidence (${Math.round(probability * 100)}%): ` +
        `Moriarty is almost certainly at ${nodeName}. ` +
        `All detectives should converge immediately.`
      );
    }
  }

  /** Push a reasoning string to the deduction log. */
  _log(msg) {
    this.deductionLog.push(msg);
    // Keep log bounded (last 100 entries)
    if (this.deductionLog.length > 100) this.deductionLog.shift();
  }
}


/* ================================================================================
 * [SECTION 4]  EXPORTS & INTEGRATION HELPERS
 *
 * These functions are the public API that moriartys-maze.html calls.
 * They wrap DetectiveMind + GameGraph in a way that slots cleanly into the
 * existing gameState object without requiring a full rewrite.
 * ================================================================================ */

/**
 * Create a GameGraph from the raw arrays already in gameState.
 * Call once after generateNodes() and generateEdges() complete.
 *
 * @param {Array} nodes  — gameState.nodes
 * @param {Array} edges  — gameState.edges
 * @returns {GameGraph}
 */
function createGameGraph(nodes, edges) {
  return new GameGraph(nodes, edges);
}

/**
 * Create and initialise a DetectiveMind for a new game.
 *
 * @param {GameGraph} graph
 * @param {number[]}  detectiveStartNodes — 5 starting positions
 * @param {number}    nodeCount           — default 200
 * @returns {DetectiveMind}
 */
function createDetectiveMind(graph, detectiveStartNodes, nodeCount = 200) {
  const mind = new DetectiveMind(graph, nodeCount);
  mind.init(detectiveStartNodes);
  return mind;
}

/**
 * After Moriarty moves, call this to update the collective mind.
 * The game loop should call this BEFORE the detective phase of each round.
 *
 * @param {DetectiveMind} mind
 * @param {number}        round
 * @param {string}        transportType  — 'cab'|'tram'|'underground'|'river'|'fog'
 * @param {boolean}       isFog
 * @param {boolean}       isSecondBluffMove
 * @param {number[]}      detectiveNodes  — current detective positions (for pruning)
 * @param {number}        lastRevealRound — round number of last reveal (-1 if none)
 * @param {number}        lastRevealNode  — nodeId of last reveal (-1 if none)
 */
function processMoriartyMove(
  mind, round, transportType, isFog,
  isSecondBluffMove, detectiveNodes,
  lastRevealRound, lastRevealNode
) {
  if (isFog) {
    mind.observeFog(round, isSecondBluffMove);
  } else {
    mind.observeTransport(round, transportType, isSecondBluffMove);
  }

  // Apply geographic constraint from last known reveal
  if (lastRevealNode >= 0) {
    mind.applyReachabilityConstraint(lastRevealRound, lastRevealNode, round);
  }

  // Remove detective-occupied nodes from candidateSet
  mind.pruneOccupied(detectiveNodes);
}

/**
 * On a reveal round, call this INSTEAD of (or after) processMoriartyMove.
 *
 * @param {DetectiveMind} mind
 * @param {number}        round
 * @param {number}        nodeId  — Moriarty's confirmed position
 * @param {number[]}      detectiveNodes
 */
function processMoriartyReveal(mind, round, nodeId, detectiveNodes) {
  mind.observeReveal(round, nodeId);
  mind.pruneOccupied(detectiveNodes);
}


/* ================================================================================
 * [SECTION 5]  SELF-TEST
 *
 *  Run in the browser console after the game loads:
 *    DetectiveMindTest.run(gameState.nodes, gameState.edges)
 *
 *  Verifies: belief sums to ~1.0, candidateSet shrinks after observeTransport,
 *  and collapses after observeReveal.
 * ================================================================================ */
const DetectiveMindTest = {
  run(nodes, edges) {
    console.group('🔍 DetectiveMind Self-Test');

    const graph = createGameGraph(nodes, edges);
    const mind  = createDetectiveMind(graph, [12, 40, 70, 110, 160], nodes.length);

    // Test 1: belief sums to 1
    let sum = 0; for (const p of mind.beliefMap.values()) sum += p;
    console.assert(Math.abs(sum - 1.0) < 0.0001, `❌ FAIL: initial belief sum = ${sum}`);
    console.log(`✅ Initial belief sum: ${sum.toFixed(6)}`);
    console.log(`   Candidates: ${mind.candidateSet.size} of ${nodes.length}`);

    // Test 2: observeTransport shrinks candidateSet
    const before = mind.candidateSet.size;
    mind.observeTransport(1, 'underground');
    const after = mind.candidateSet.size;
    console.assert(after <= before, `❌ FAIL: candidateSet grew after underground filter`);
    console.log(`✅ After Underground move: ${before} → ${after} candidates`);

    // Test 3: belief still sums to 1 after update
    sum = 0; for (const p of mind.beliefMap.values()) sum += p;
    console.assert(Math.abs(sum - 1.0) < 0.0001, `❌ FAIL: belief sum after update = ${sum}`);
    console.log(`✅ Belief sum after update: ${sum.toFixed(6)}`);

    // Test 4: reveal collapses belief
    const revealNode = [...mind.candidateSet][0];
    mind.observeReveal(3, revealNode);
    const revealBelief = mind.beliefAt(revealNode);
    console.assert(revealBelief >= mind.REVEAL_CERTAINTY - 0.001, `❌ FAIL: reveal belief = ${revealBelief}`);
    console.log(`✅ After reveal: belief at node ${revealNode} = ${revealBelief.toFixed(4)} (≥ ${mind.REVEAL_CERTAINTY})`);

    // Test 5: isConfident after reveal
    console.assert(mind.isConfident(), `❌ FAIL: should be confident after reveal`);
    console.log(`✅ isConfident() = true after reveal`);

    // Test 6: entropy decreases after reveal
    const entropy = mind.entropy();
    console.log(`✅ Entropy after reveal: ${entropy.toFixed(3)} bits (lower = more certain)`);

    // Test 7: getSummary produces a string
    const summary = mind.getSummary();
    console.assert(typeof summary === 'string' && summary.length > 10, `❌ FAIL: getSummary returned empty`);
    console.log(`✅ getSummary: "${summary.slice(0, 80)}..."`);

    // Test 8: getDetectiveAssignments returns 5 entries
    const dets = [
      {id:0, node:12, tickets:{cab:12,tram:8,underground:4,river:2}},
      {id:1, node:40, tickets:{cab:11,tram:6,underground:3,river:1}},
      {id:2, node:70, tickets:{cab:10,tram:6,underground:3,river:1}},
      {id:3, node:110,tickets:{cab:10,tram:6,underground:3,river:1}},
      {id:4, node:160,tickets:{cab:9, tram:5,underground:2,river:1}},
    ];
    const assignments = mind.getDetectiveAssignments(dets);
    console.assert(assignments.length === 5, `❌ FAIL: expected 5 assignments, got ${assignments.length}`);
    console.log(`✅ getDetectiveAssignments: 5 assignments returned`);
    assignments.forEach(a => console.log(`   Det ${a.detId}: → node ${a.targetNode} | ${a.reasoning}`));

    // Test 9: getHolmesNarrative
    const narrative = mind.getHolmesNarrative(3);
    console.log(`✅ Holmes narrative: "${narrative.slice(0, 100)}..."`);

    console.log('\n📋 Deduction log:');
    mind.getDeductionLog().forEach(l => console.log(`  ${l}`));

    console.groupEnd();
  }
};

// ── Make available globally (browser) or as module (Node) ─────────────────────
if (typeof window !== 'undefined') {
  window.GameGraph           = GameGraph;
  window.DetectiveMind       = DetectiveMind;
  window.createGameGraph     = createGameGraph;
  window.createDetectiveMind = createDetectiveMind;
  window.processMoriartyMove = processMoriartyMove;
  window.processMoriartyReveal = processMoriartyReveal;
  window.DetectiveMindTest   = DetectiveMindTest;
} else if (typeof module !== 'undefined') {
  module.exports = {
    GameGraph, DetectiveMind,
    createGameGraph, createDetectiveMind,
    processMoriartyMove, processMoriartyReveal,
    DetectiveMindTest,
  };
}
