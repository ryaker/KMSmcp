/**
 * SparrowDB Storage System Implementation
 *
 * Drop-in replacement for Neo4jStorage — implements the same StorageSystem
 * interface plus the extended methods (getEntitySummary, getOperationalNodes,
 * getEntityCandidates, createAboutRelationships, findRelated, close) that
 * EntityLinker, UnifiedSearchTool, and UnifiedStoreTool reference directly
 * on the Neo4jStorage instance.
 *
 * Integration method: sparrowdb native Node.js binding
 *   ~/Dev/SparrowDB/npm/sparrowdb/sparrowdb.node  (NAPI, darwin-arm64)
 *
 * Known SparrowDB constraints handled here:
 *
 *   STRING TRUNCATION (current build limitation):
 *     The current sparrowdb.node binary truncates string property values to 7
 *     characters when decoding from the CSR node store. This is a bug in the
 *     NAPI value decoding path (tracked as SPA issue). Workaround: all full-
 *     length string content is stored in a JSON sidecar file (`content-index.json`)
 *     alongside the SparrowDB directory. The sidecar is loaded at startup and
 *     consulted for search. Graph structure (IDs, labels, relationships, short
 *     metadata) is stored in SparrowDB itself.
 *
 *   - Floats are bit-cast to i64 when stored via literal float syntax;
 *     workaround: store confidence as a string property.
 *   - No MERGE … SET support — upserts use DELETE + CREATE.
 *   - Relationship properties not supported — property-bearing rels
 *     stored as node properties on a synthetic node.
 *   - Variable-length path traversal ([:R*N..M]) not yet implemented;
 *     workaround: manual BFS in TypeScript.
 *   - OPTIONAL MATCH not supported — handled via separate try/catch queries.
 *   - type(r) does not work with anonymous relationship variable — use a
 *     named relationship type directly in the pattern.
 *   - CALL db.index.fulltext.createNodeIndex is not a Cypher procedure;
 *     the fulltext index requires the Rust API (create_fulltext_index +
 *     add_to_fulltext_index). These are not yet exposed to Node.js.
 *     Fulltext search falls back to in-process CONTAINS on the content sidecar.
 *
 * Environment variables:
 *   KMS_STORAGE_BACKEND=sparrowdb   (switches graph backend from Neo4j to SparrowDB)
 *   SPARROWDB_PATH=/path/to/kms.db  (default: ~/.kms-sparrowdb)
 */
import { createRequire } from 'module';
import { logger } from '../logger.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
// ---------------------------------------------------------------------------
// Load the native .node module
// ---------------------------------------------------------------------------
function loadNativeBinding() {
    const require = createRequire(import.meta.url);
    // Prefer npm package; fall back to local dev builds
    try {
        return require('sparrowdb');
    }
    catch {
        // npm package not installed — try local dev paths
    }
    const candidates = [
        join(homedir(), 'Dev', 'SparrowDB', 'npm', 'sparrowdb', 'sparrowdb.node'),
        join(homedir(), 'Dev', 'SparrowDB', 'target', 'release', 'sparrowdb.node'),
        join(homedir(), 'Dev', 'SparrowDB', 'target', 'debug', 'sparrowdb.node'),
    ];
    for (const p of candidates) {
        if (existsSync(p)) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            return require(p);
        }
    }
    throw new Error('SparrowDBStorage: cannot find sparrowdb.\n' +
        'Install: npm install sparrowdb\n' +
        'Or build locally: cargo build --release -p sparrowdb-node  in ~/Dev/SparrowDB');
}
// ---------------------------------------------------------------------------
// Cypher string helpers
// SparrowDB execute() has no parameter binding — values must be embedded.
// ---------------------------------------------------------------------------
function esc(s) {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function cypherStr(s) {
    return `'${esc(s)}'`;
}
function parseFloatSafe(v) {
    if (typeof v === 'number')
        return isNaN(v) ? 0 : v;
    if (typeof v === 'string') {
        const n = parseFloat(v);
        return isNaN(n) ? 0 : n;
    }
    return 0;
}
// ---------------------------------------------------------------------------
// SparrowDBStorage
// ---------------------------------------------------------------------------
export class SparrowDBStorage {
    name = 'sparrowdb';
    db;
    dbPath;
    sidecarPath;
    // In-process content index — keyed by knowledge id.
    // Persisted to a JSON sidecar so it survives restarts.
    contentIndex = new Map();
    // Identity registry loaded from config/known-people.json.
    knownPeople = null;
    // Vector index dimensions (dedup gate DG-T1-A). 768 = nomic-embed-text.
    static VECTOR_DIMENSIONS = 768;
    static VECTOR_LABEL = 'Knowledge';
    static VECTOR_PROPERTY = 'embedding';
    // True iff the loaded sparrowdb binding exposes createVectorIndex/vectorSearch
    // AND the index initialization on the configured (label, property) succeeded.
    // When false, storeEmbedding becomes a no-op so the dedup gate degrades to
    // "graph-only" rather than crashing the store path.
    vectorIndexAvailable = false;
    constructor(config) {
        this.dbPath =
            config?.dbPath ||
                process.env.SPARROWDB_PATH ||
                join(homedir(), '.kms-sparrowdb');
        this.sidecarPath = join(this.dbPath, 'content-index.json');
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    async initialize() {
        logger.debug(`⚡ Opening SparrowDB at ${this.dbPath}…`);
        if (!existsSync(this.dbPath)) {
            mkdirSync(this.dbPath, { recursive: true });
        }
        const native = loadNativeBinding();
        this.db = native.SparrowDB.open(this.dbPath);
        // Load content sidecar
        this._loadSidecar();
        // Load identity registry
        this._loadKnownPeople();
        // Initialize HNSW vector index for dedup gate (DG-T1-A).
        // Idempotent in the binding (no-op if it already exists), but we
        // additionally guard against missing-method on older builds.
        this._initializeVectorIndex();
        logger.debug(`✅ SparrowDB opened — ${this.contentIndex.size} content entries in sidecar, ` +
            `vectorIndex=${this.vectorIndexAvailable ? 'ready' : 'unavailable'}`);
    }
    _initializeVectorIndex() {
        if (typeof this.db.createVectorIndex !== 'function') {
            logger.warn('⚠️ SparrowDB binding does not expose createVectorIndex — ' +
                'embedding-on-write disabled. Upgrade to sparrowdb >= 0.1.22.');
            this.vectorIndexAvailable = false;
            return;
        }
        try {
            this.db.createVectorIndex(SparrowDBStorage.VECTOR_LABEL, SparrowDBStorage.VECTOR_PROPERTY, SparrowDBStorage.VECTOR_DIMENSIONS, 'cosine');
            this.vectorIndexAvailable = true;
            logger.debug(`✅ SparrowDB vector index ready: ` +
                `(${SparrowDBStorage.VECTOR_LABEL}, ${SparrowDBStorage.VECTOR_PROPERTY}) ` +
                `dim=${SparrowDBStorage.VECTOR_DIMENSIONS} metric=cosine`);
        }
        catch (e) {
            // Per the binding contract, createVectorIndex is idempotent and a
            // second call for the same (label, property) is a no-op. So a thrown
            // error here is unexpected — log and continue with embedding disabled.
            logger.warn(`⚠️ SparrowDB createVectorIndex failed — embedding-on-write disabled: ${e instanceof Error ? e.message : String(e)}`);
            this.vectorIndexAvailable = false;
        }
    }
    /** Whether the SparrowDB HNSW vector index is live for embedding writes. */
    isVectorIndexAvailable() {
        return this.vectorIndexAvailable;
    }
    async close() {
        if (this.db) {
            this._saveSidecar();
            this.db.checkpoint();
            logger.debug('✅ SparrowDB checkpointed and sidecar saved');
        }
    }
    // -------------------------------------------------------------------------
    // StorageSystem.store
    // -------------------------------------------------------------------------
    async store(knowledge) {
        logger.debug(`⚡ Storing in SparrowDB: ${knowledge.id}`);
        // Delete any existing node (upsert via DELETE+CREATE, since MERGE+SET is unsupported).
        try {
            this.db.execute(`MATCH (k:Knowledge {id: ${cypherStr(knowledge.id)}}) DELETE k`);
        }
        catch { /* node may not exist */ }
        const ts = knowledge.timestamp instanceof Date
            ? knowledge.timestamp.toISOString()
            : String(knowledge.timestamp);
        // Pluck a transient embedding payload off knowledge.metadata if the caller
        // attached one. This is the inline-MERGE path for HNSW population — see
        // storeEmbedding() for the architectural rationale (SparrowDB 0.1.22's
        // MATCH+SET silently no-ops for vector params; only MERGE/CREATE pattern's
        // literal property dict triggers idx.insert). The payload uses a
        // double-underscored key to mark it transient — we strip it before the
        // sidecar write so it never persists.
        const META_EMB_KEY = '__pending_embedding';
        const META_EMB_ID_KEY = '__pending_embedder_id';
        const inlineEmb = knowledge.metadata?.[META_EMB_KEY];
        const inlineEmbId = knowledge.metadata?.[META_EMB_ID_KEY];
        const hasInlineEmb = inlineEmb !== undefined &&
            inlineEmbId !== undefined &&
            this.vectorIndexAvailable &&
            (inlineEmb instanceof Float32Array
                ? inlineEmb.length === SparrowDBStorage.VECTOR_DIMENSIONS
                : Array.isArray(inlineEmb) && inlineEmb.length === SparrowDBStorage.VECTOR_DIMENSIONS);
        if (hasInlineEmb) {
            const embArray = inlineEmb instanceof Float32Array ? Array.from(inlineEmb) : inlineEmb;
            // Reject non-finite values — would corrupt HNSW (same guard as storeEmbedding).
            if (embArray.some(v => !Number.isFinite(v))) {
                logger.warn(`⚠️ store: rejecting inline embedding (non-finite value) — falling back to no-embed CREATE`);
                this._createWithoutEmbedding(knowledge);
            }
            else {
                try {
                    // ALL props INLINE in one MERGE pattern. SparrowDB 0.1.22 honours
                    // HNSW population only when the vector property appears as a $param
                    // inside the MERGE pattern's literal property dict. Compound
                    // MERGE+SET parses but the SET clause silently no-ops in 0.1.22
                    // (verified — see channel msg #202 to SparrowDB session).
                    ;
                    this.db.executeWithParams(`MERGE (k:Knowledge {` +
                        `  id: ${cypherStr(knowledge.id)},` +
                        `  contentType: ${cypherStr(knowledge.contentType)},` +
                        `  source: ${cypherStr(knowledge.source)},` +
                        `  userId: ${cypherStr(knowledge.userId ?? '')},` +
                        `  confidence: ${cypherStr(String(knowledge.confidence))},` +
                        `  embedderId: ${cypherStr(inlineEmbId)},` +
                        `  embedding: $emb` +
                        `})`, { emb: embArray });
                    // Incrementally maintain the internalId → UUID map for findSimilar.
                    if (this.internalIdMapLoaded) {
                        try {
                            const res = this.db.execute(`MATCH (k:${SparrowDBStorage.VECTOR_LABEL} {id: ${cypherStr(knowledge.id)}}) RETURN id(k) AS nid`);
                            const nid = res.rows[0]?.['nid'];
                            if (nid !== null && nid !== undefined) {
                                this.internalIdToUuid.set(String(nid), knowledge.id);
                            }
                        }
                        catch {
                            this.internalIdMapLoaded = false;
                        }
                    }
                }
                catch (e) {
                    // If the inline MERGE failed (parser change, etc.), don't lose the
                    // node entirely — fall back to CREATE-without-embedding so the
                    // entry still lands in the graph and can be re-embedded later.
                    logger.warn(`⚠️ store: inline-embedding MERGE failed (${e instanceof Error ? e.message : String(e)}) — ` +
                        `falling back to no-embed CREATE`);
                    this._createWithoutEmbedding(knowledge);
                }
            }
        }
        else {
            this._createWithoutEmbedding(knowledge);
        }
        // Persist full-length content in the sidecar.
        // Strip the transient embedding payload before persisting so it never
        // serializes into the JSON sidecar (would balloon the file by ~6KB/entry).
        const cleanMetadata = { ...(knowledge.metadata ?? {}) };
        delete cleanMetadata[META_EMB_KEY];
        delete cleanMetadata[META_EMB_ID_KEY];
        const entry = {
            id: knowledge.id,
            content: knowledge.content,
            contentType: knowledge.contentType,
            source: knowledge.source,
            userId: knowledge.userId ?? '',
            confidence: knowledge.confidence,
            timestamp: ts,
            metadata: cleanMetadata,
            flag: knowledge.flag ?? null,
            flag_note: knowledge.flag_note,
            flag_date: knowledge.flag_date instanceof Date ? knowledge.flag_date.toISOString() : knowledge.flag_date,
            flag_by: knowledge.flag_by,
            superseded_by: knowledge.superseded_by
        };
        this.contentIndex.set(knowledge.id, entry);
        this._saveSidecar();
        // Create explicit relationships with optional strength property.
        if (knowledge.relationships && knowledge.relationships.length > 0) {
            for (const rel of knowledge.relationships) {
                await this._createRelationship(knowledge.id, rel.targetId, rel.type, rel.strength);
            }
        }
        // Semantic auto-relationships (best-effort).
        await this._createSemanticRelationships(knowledge);
        logger.debug(`✅ SparrowDB stored ${knowledge.id} with ` +
            `${knowledge.relationships?.length ?? 0} relationships`);
    }
    /**
     * Plain CREATE for the no-embedding path (and the inline-MERGE fallback).
     * Kept identical to the legacy 0.1.x shape — five literal string props on a
     * single MATCH-ready row. Don't use SET to add props later; SparrowDB 0.1.22
     * silently no-ops SET on existing nodes (proven in /tmp/test-single-prop.js
     * and reported upstream via channel #202). All node props go inline here.
     */
    _createWithoutEmbedding(knowledge) {
        this.db.execute(`CREATE (k:Knowledge {` +
            `  id: ${cypherStr(knowledge.id)},` +
            `  contentType: ${cypherStr(knowledge.contentType)},` +
            `  source: ${cypherStr(knowledge.source)},` +
            `  userId: ${cypherStr(knowledge.userId ?? '')},` +
            `  confidence: ${cypherStr(String(knowledge.confidence))}` +
            `})`);
    }
    // -------------------------------------------------------------------------
    // Embedding write (DG-T1-A)
    //
    // Persists a 768-dim Float32Array into the HNSW vector index for the
    // (Knowledge, embedding) tuple. Also stores `embedderId` as a property on
    // the Knowledge node so an embedder swap can invalidate stale vectors via a
    // single property-equality query (spec §9 — embedding drift mitigation).
    //
    // Idempotent: re-calling for the same id replaces the embedding by routing
    // through SET (the binding's vector-index DDL handles upsert internally).
    //
    // Returns true if the embedding was persisted, false if the index isn't
    // available or the node doesn't exist (e.g. sidecar-orphan).
    // -------------------------------------------------------------------------
    async storeEmbedding(id, embedding, embedderId) {
        if (!this.vectorIndexAvailable) {
            logger.debug(`storeEmbedding skipped (no vector index): ${id}`);
            return false;
        }
        if (embedding.length !== SparrowDBStorage.VECTOR_DIMENSIONS) {
            logger.warn(`⚠️ storeEmbedding rejected — dim mismatch: got ${embedding.length}, expected ${SparrowDBStorage.VECTOR_DIMENSIONS}`);
            return false;
        }
        // SparrowDB indexes vectors automatically when the (label, property) was
        // registered via createVectorIndex. Defensive check: reject if any value is
        // ±Infinity / NaN — would corrupt HNSW.
        if (Array.from(embedding).some(v => !Number.isFinite(v))) {
            logger.warn(`⚠️ storeEmbedding rejected — embedding contains non-finite value(s)`);
            return false;
        }
        try {
            // SparrowDB 0.1.22+: Cypher parser rejects list literals in SET, so the
            // embedding MUST go through executeWithParams (PR #409). The engine
            // coerces JS Array → engine List → Vec<f32> for HNSW index population.
            // String props (embedderId) still work via literal SET.
            ;
            this.db.executeWithParams(`MATCH (k:${SparrowDBStorage.VECTOR_LABEL} {id: ${cypherStr(id)}}) ` +
                `SET k.${SparrowDBStorage.VECTOR_PROPERTY} = $emb, ` +
                `    k.embedderId = ${cypherStr(embedderId)}`, { emb: Array.from(embedding) });
        }
        catch (e) {
            // The most common failure is "node not found" — happens for the ~185
            // sidecar-orphan entries that exist in the JSON sidecar but never got
            // a graph node (pre-cutover legacy). Logged at debug, not warn.
            logger.debug(`storeEmbedding: graph SET failed for ${id} (likely sidecar-orphan): ` +
                `${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
        // Mirror the bookkeeping into the in-memory sidecar so consumers can check
        // "has-embedding?" without round-tripping to SparrowDB.
        //
        // _saveSidecar() is intentionally NOT called here. On the hot path,
        // store() already set embedder_id + embedded_at on knowledge.metadata
        // before persisting the sidecar, so flushing again would be a redundant
        // full-write of the ~1200-entry JSON file. The in-memory contentIndex is
        // updated above to stay consistent; the next organic _saveSidecar() call
        // (e.g. a subsequent delete/flag) will flush these values to disk.
        const entry = this.contentIndex.get(id);
        if (entry) {
            entry.embedder_id = embedderId;
            entry.embedded_at = new Date().toISOString();
            this.contentIndex.set(id, entry);
        }
        // Incrementally maintain the internalId → UUID map so newly-embedded
        // entries are findable via findSimilar without waiting for a full reload.
        // Best-effort: a failure here just means findSimilar will rebuild on next
        // call. Cheap query (single MATCH by id), runs on every embed write.
        if (this.internalIdMapLoaded) {
            try {
                const res = this.db.execute(`MATCH (k:${SparrowDBStorage.VECTOR_LABEL} {id: ${cypherStr(id)}}) RETURN id(k) AS nid`);
                const nid = res.rows[0]?.['nid'];
                if (nid !== null && nid !== undefined) {
                    this.internalIdToUuid.set(String(nid), id);
                }
            }
            catch {
                // Non-fatal: just invalidate so next findSimilar reloads the full map.
                this.internalIdMapLoaded = false;
            }
        }
        return true;
    }
    // -------------------------------------------------------------------------
    // Vector retrieval (DG-T1-B)
    //
    // Top-K nearest-neighbour search over the HNSW vector index. Used by the
    // dedup gate to find candidate near-duplicates BEFORE persisting a new
    // unified_store call.
    //
    // The native vectorSearch returns NodeResult.id as the SparrowDB internal
    // node u64 (decimal string), NOT the Knowledge.id UUID. We translate via
    // an in-memory map populated lazily on first call, then kept fresh by
    // storeEmbedding inserts.
    //
    // The native binding's vector index doesn't support property filters in
    // 0.1.22, so we over-fetch (k * 5) candidates from HNSW and post-filter
    // by userId / contentType / subject in JS. This is the documented pattern
    // for SparrowDB until issue #406 (combined property + vector queries) lands.
    //
    // Score interpretation: cosine index → score IS cosine similarity directly
    // (range -1..1, identical = 1.0). NO L2-distance conversion is applied;
    // the spec assumption that conversion was needed was wrong (verified
    // against sparrowdb-storage/vector_index.rs to_score() — for cosine the
    // returned score is already the similarity).
    // -------------------------------------------------------------------------
    /** Reverse-lookup table: SparrowDB internal node id (u64 string) → Knowledge.id UUID. */
    internalIdToUuid = new Map();
    /** True once the internalIdToUuid map has been bulk-loaded from the graph. */
    internalIdMapLoaded = false;
    /**
     * Build (or refresh) the internal-id → UUID lookup table by scanning all
     * Knowledge nodes in the graph. Called lazily on first findSimilar() and
     * incrementally maintained by storeEmbedding(). Idempotent.
     */
    _ensureInternalIdMap() {
        if (this.internalIdMapLoaded)
            return;
        try {
            const res = this.db.execute(`MATCH (k:Knowledge) RETURN id(k) AS nid, k.id AS short_id`);
            for (const row of res.rows) {
                const nid = row['nid'];
                const shortId = row['short_id'];
                if (nid === null || nid === undefined)
                    continue;
                const internalId = String(nid);
                const prefix = String(shortId ?? '');
                // Resolve possibly-truncated short_id to the full UUID via sidecar prefix lookup.
                // SparrowDB 0.1.22 truncates string properties to 7 chars on read; the sidecar
                // is the authoritative source for full UUIDs.
                const entry = this._findEntryByPrefix(prefix);
                if (entry) {
                    this.internalIdToUuid.set(internalId, entry.id);
                }
            }
            this.internalIdMapLoaded = true;
            logger.debug(`✅ SparrowDB internalId→UUID map loaded: ${this.internalIdToUuid.size} entries`);
        }
        catch (e) {
            logger.warn(`⚠️ SparrowDB internalId→UUID map load failed (vector results may be unresolvable): ${e instanceof Error ? e.message : String(e)}`);
            // Mark loaded to avoid retry storm; degraded mode just returns fewer results.
            this.internalIdMapLoaded = true;
        }
    }
    /**
     * Find top-K nearest-neighbour Knowledge nodes by embedding similarity.
     *
     * Filters applied (post-vector-search):
     *   - userId           — required (scope is always within-user)
     *   - contentType      — optional; matches exact contentType
     *   - subject          — optional; matches metadata.subject exact string
     *   - flag             — default: hide flagged entries (matches search() behavior)
     *
     * Returns up to topK candidates (default 5) sorted by descending similarity.
     * Returns [] if the vector index is unavailable or no candidates match filters.
     */
    async findSimilar(embedding, options) {
        if (!this.vectorIndexAvailable || typeof this.db.vectorSearch !== 'function') {
            return [];
        }
        if (embedding.length !== SparrowDBStorage.VECTOR_DIMENSIONS) {
            logger.warn(`⚠️ findSimilar rejected — dim mismatch: got ${embedding.length}, expected ${SparrowDBStorage.VECTOR_DIMENSIONS}`);
            return [];
        }
        const topK = Math.max(1, Math.floor(options.topK ?? 5));
        // Over-fetch by 5x to compensate for post-filter discards. SparrowDB's
        // vector_search has no native property filter in 0.1.22.
        const overFetch = Math.min(500, topK * 5);
        let raw;
        try {
            raw = this.db.vectorSearch(SparrowDBStorage.VECTOR_LABEL, SparrowDBStorage.VECTOR_PROPERTY, embedding, overFetch);
        }
        catch (e) {
            logger.warn(`⚠️ SparrowDB vectorSearch failed: ${e instanceof Error ? e.message : String(e)}`);
            return [];
        }
        if (!raw || raw.length === 0)
            return [];
        this._ensureInternalIdMap();
        const out = [];
        for (const r of raw) {
            // Translate internal node id → Knowledge UUID. Skip if unmapped (shouldn't
            // happen for nodes created post-embedding-rollout, but guard just in case).
            const uuid = this.internalIdToUuid.get(String(r.id));
            if (!uuid)
                continue;
            const entry = this.contentIndex.get(uuid);
            if (!entry)
                continue;
            // Filter: flagged entries (default hidden, matches search() behavior).
            if (!options.includeFlagged && entry.flag)
                continue;
            // Filter: userId (always required).
            if (entry.userId !== options.userId)
                continue;
            // Filter: contentType (optional).
            if (options.contentType && entry.contentType !== options.contentType)
                continue;
            // Filter: subject (optional).
            if (options.subject !== undefined) {
                const s = entry.metadata?.subject;
                if (typeof s !== 'string' || s !== options.subject)
                    continue;
            }
            // Clamp similarity to a sane range — defensive: cosine similarity should
            // be in [-1, 1] but f32 round-off in HNSW can drift a touch beyond.
            const sim = Math.max(-1, Math.min(1, r.score));
            out.push({
                id: entry.id,
                similarity: sim,
                contentType: entry.contentType,
                source: entry.source,
                subject: typeof entry.metadata?.subject === 'string' ? entry.metadata.subject : undefined,
                created: entry.timestamp,
                flag: entry.flag ?? null,
                content_preview: (entry.content ?? '').slice(0, 200)
            });
            if (out.length >= topK)
                break;
        }
        // vector_search already returns descending by similarity, but post-filter
        // can leave the top-K out of order if any high-sim candidate was filtered.
        // Re-sort defensively.
        out.sort((a, b) => b.similarity - a.similarity);
        return out;
    }
    // -------------------------------------------------------------------------
    // Corrective operations: delete / update / flag
    // -------------------------------------------------------------------------
    /**
     * Hard delete an entry by ID. Removes the graph node, all incident
     * relationships (DETACH), and the sidecar entry. Returns true if anything
     * was actually removed.
     */
    async delete(id) {
        logger.debug(`🗑️  Deleting from SparrowDB: ${id}`);
        const hadEntry = this.contentIndex.has(id);
        // Detach + delete graph node. SparrowDB doesn't have DETACH DELETE in all
        // versions, so we delete relationships first then the node.
        try {
            this.db.execute(`MATCH (k:Knowledge {id: ${cypherStr(id)}})-[r]-() DELETE r`);
        }
        catch { /* may have no relationships */ }
        try {
            this.db.execute(`MATCH (k:Knowledge {id: ${cypherStr(id)}}) DELETE k`);
        }
        catch { /* node may not exist */ }
        if (hadEntry) {
            this.contentIndex.delete(id);
            this._saveSidecar();
        }
        // Also drop any stale internalId → UUID entries so findSimilar doesn't
        // surface ghosts. Cheap: scan ~1200 keys.
        for (const [nid, uuid] of this.internalIdToUuid) {
            if (uuid === id) {
                this.internalIdToUuid.delete(nid);
                break;
            }
        }
        return hadEntry;
    }
    /**
     * Update fields on an existing entry. Merges `updates` into the sidecar
     * ContentEntry and (for structural fields) refreshes the graph node via
     * DELETE+CREATE since SparrowDB lacks MERGE+SET.
     *
     * Bumps the timestamp to now. Returns true if the entry existed.
     */
    async update(id, updates) {
        logger.debug(`✏️  Updating SparrowDB entry: ${id}`);
        const existing = this.contentIndex.get(id);
        if (!existing)
            return false;
        // Merge updates into sidecar entry. Timestamp bumps to now.
        const updated = {
            ...existing,
            content: updates.content ?? existing.content,
            contentType: updates.contentType ?? existing.contentType,
            source: updates.source ?? existing.source,
            userId: updates.userId ?? existing.userId,
            confidence: updates.confidence ?? existing.confidence,
            timestamp: new Date().toISOString(),
            metadata: { ...existing.metadata, ...(updates.metadata ?? {}) },
            flag: updates.flag !== undefined ? updates.flag : existing.flag,
            flag_note: updates.flag_note ?? existing.flag_note,
            flag_date: updates.flag_date instanceof Date
                ? updates.flag_date.toISOString()
                : (updates.flag_date ?? existing.flag_date),
            flag_by: updates.flag_by ?? existing.flag_by,
            superseded_by: updates.superseded_by ?? existing.superseded_by
        };
        // Refresh graph node structural properties without destroying relationships.
        // Use SET on the existing node instead of DELETE+CREATE so that all
        // RELATED_TO / ABOUT edges are preserved.
        let graphOk = false;
        try {
            this.db.execute(`MATCH (k:Knowledge {id: ${cypherStr(id)}})` +
                ` SET k.contentType = ${cypherStr(updated.contentType)},` +
                `     k.source = ${cypherStr(updated.source)},` +
                `     k.userId = ${cypherStr(updated.userId)},` +
                `     k.confidence = ${cypherStr(String(updated.confidence))}`);
            graphOk = true;
        }
        catch (e) {
            logger.warn(`SparrowDB update: failed to refresh graph node for ${id}: ${e}`);
            return false;
        }
        // Only persist sidecar after the graph update succeeds, so the two stores
        // stay in sync (sidecar is the source of truth for full content).
        if (graphOk) {
            this.contentIndex.set(id, updated);
            this._saveSidecar();
        }
        return true;
    }
    /**
     * Flag an entry without modifying its content. Soft-delete primitive used
     * by kms_delete (flag='DELETED'), kms_supersede (flag='SUPERSEDED'), and
     * kms_flag for arbitrary flags (RETRACTED, UNVERIFIED).
     *
     * Pass `flag=null` to clear the flag (un-retract). Returns true if the
     * entry existed.
     */
    async flag(id, flag, note, by, superseded_by) {
        logger.debug(`🚩 Flagging SparrowDB entry: ${id} → ${flag ?? 'CLEARED'}`);
        const existing = this.contentIndex.get(id);
        if (!existing)
            return false;
        existing.flag = flag;
        existing.flag_note = flag === null ? undefined : note;
        existing.flag_date = flag === null ? undefined : new Date().toISOString();
        existing.flag_by = flag === null ? undefined : by;
        // Clear superseded_by whenever the entry transitions AWAY from SUPERSEDED
        // (including to null/DELETED/RETRACTED) so stale successor IDs don't linger.
        existing.superseded_by = flag === 'SUPERSEDED' ? superseded_by : undefined;
        this.contentIndex.set(id, existing);
        this._saveSidecar();
        return true;
    }
    /**
     * Find an entry by ID. Returns the full ContentEntry or null.
     * Used by reaper and unified_get_by_id.
     */
    findById(id) {
        return this.contentIndex.get(id) ?? null;
    }
    /**
     * List all flagged entries (any flag value). Used by reaper to find
     * candidates for hard-deletion past the 90-day window.
     */
    listFlagged() {
        const out = [];
        for (const e of this.contentIndex.values()) {
            if (e.flag)
                out.push(e);
        }
        return out;
    }
    // -------------------------------------------------------------------------
    // StorageSystem.search
    // -------------------------------------------------------------------------
    async search(query) {
        logger.debug(`🔍 Searching SparrowDB: "${query.query}"`);
        try {
            const maxResults = Math.floor(query.options?.maxResults ?? 10);
            const searchTerms = query.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
            // Search is entirely in-process against the content sidecar.
            // The sidecar holds full-length strings; SparrowDB graph holds short
            // structural metadata only.
            let entries = Array.from(this.contentIndex.values());
            // Default: hide flagged (retracted/superseded/deleted) entries.
            // Opt in via options.includeFlagged to see them (e.g. for audit/reaper paths).
            if (!query.options?.includeFlagged) {
                entries = entries.filter(e => !e.flag);
            }
            // Apply KnowledgeQuery filters.
            if (query.filters?.userId) {
                const uid = query.filters.userId;
                entries = entries.filter(e => e.userId === uid);
            }
            if (query.filters?.source && query.filters.source.length > 0) {
                const sources = query.filters.source;
                entries = entries.filter(e => sources.includes(e.source));
            }
            if (query.filters?.contentType && query.filters.contentType.length > 0) {
                const types = query.filters.contentType;
                entries = entries.filter(e => types.includes(e.contentType));
            }
            if (query.filters?.minConfidence !== undefined) {
                const min = query.filters.minConfidence;
                entries = entries.filter(e => e.confidence >= min);
            }
            // Subject facet filter (DG-FACET-A). Pure pass-through against
            // metadata.subject. String → exact; String[] → any-match.
            if (query.filters?.subject !== undefined) {
                const wanted = Array.isArray(query.filters.subject)
                    ? query.filters.subject
                    : [query.filters.subject];
                if (wanted.length > 0) {
                    entries = entries.filter(e => {
                        const s = e.metadata?.subject;
                        return typeof s === 'string' && wanted.includes(s);
                    });
                }
            }
            // Score by term hits in content.
            const scored = entries
                .map(e => {
                const lower = e.content.toLowerCase();
                const hits = searchTerms.filter(t => lower.includes(t)).length;
                const score = searchTerms.length > 0 ? hits / searchTerms.length : 1;
                return { entry: e, score };
            })
                .filter(({ score }) => score > 0 || searchTerms.length === 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, maxResults);
            // Optionally fetch graph relationships.
            const results = await Promise.all(scored.map(async ({ entry, score }) => {
                let relationships = [];
                if (query.options?.includeRelationships) {
                    relationships = await this._getRelationships(entry.id);
                }
                return {
                    id: entry.id,
                    content: entry.content,
                    confidence: Math.min(score, 1),
                    metadata: entry.metadata,
                    sourceSystem: 'sparrowdb',
                    timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
                    contentType: entry.contentType || 'fact',
                    source: entry.source || 'technical',
                    nodeLabels: ['Knowledge'],
                    relationships
                };
            }));
            logger.debug(`⚡ SparrowDB found ${results.length} results`);
            return results;
        }
        catch (error) {
            logger.warn('⚠️ SparrowDB search error:', error);
            return [];
        }
    }
    // -------------------------------------------------------------------------
    // StorageSystem.getStats
    // -------------------------------------------------------------------------
    async getStats() {
        try {
            const nodeResult = this.db.execute(`MATCH (n:Knowledge) RETURN count(n)`);
            const totalNodes = Number(nodeResult.rows[0]?.['count(n)'] ?? 0);
            const relResult = this.db.execute(`MATCH ()-[r]->() RETURN count(r) AS cnt`);
            const totalRelationships = Number(relResult.rows[0]?.['cnt'] ?? 0);
            // Content type distribution from sidecar (authoritative — SparrowDB strings truncated).
            const contentTypes = {};
            for (const entry of this.contentIndex.values()) {
                contentTypes[entry.contentType] = (contentTypes[entry.contentType] ?? 0) + 1;
            }
            return {
                totalNodes: Math.max(totalNodes, this.contentIndex.size),
                totalRelationships,
                contentTypes,
                relationshipTypes: { total: totalRelationships },
                knowledgeHubs: [],
                status: 'connected',
                graphDensity: totalNodes > 0 ? totalRelationships / totalNodes : 0,
                backend: 'sparrowdb',
                dbPath: this.dbPath,
                sidecarEntries: this.contentIndex.size
            };
        }
        catch (error) {
            logger.error('❌ SparrowDB stats error:', error);
            return {
                totalNodes: 0,
                totalRelationships: 0,
                status: 'error',
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
    // -------------------------------------------------------------------------
    // Extended Neo4jStorage-compatible API
    // -------------------------------------------------------------------------
    /**
     * PersonResolver — resolve any name variant to a canonical SparrowDB node ID.
     *
     * Checks (fastest → slowest):
     *   1. In-memory nameIndex from known-people.json  (O(1))
     *   2. Normalized first+last name lookup in nameIndex
     *   3. SparrowDB CONTAINS search on Person nodes
     *
     * Returns the canonical node ID, or null if no match found.
     * The caller should only create a new Person node when this returns null.
     */
    async resolvePersonId(rawName) {
        if (!rawName?.trim())
            return null;
        const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
        const normalized = normalize(rawName);
        if (!normalized)
            return null; // e.g. input was "!!!" — would produce CONTAINS '' which matches all
        // 1. Fast in-memory lookup from known-people.json
        if (this.knownPeople) {
            const directHit = this.knownPeople.nameIndex[normalized];
            if (directHit)
                return directHit;
            const parts = normalized.split(' ');
            if (parts.length > 2) {
                const firstLast = `${parts[0]} ${parts[parts.length - 1]}`;
                const hit = this.knownPeople.nameIndex[firstLast];
                if (hit)
                    return hit;
            }
        }
        // 2. SparrowDB CONTAINS search fallback
        try {
            const safeNorm = normalized.replace(/'/g, "\\'");
            // Prefer exact normalized match first
            const exact = this.db.execute(`MATCH (n:Person) WHERE toLower(n.name) = '${safeNorm}' RETURN n.id LIMIT 1`);
            if (exact.rows.length === 1) {
                return String(exact.rows[0]['n.id'] ?? '') || null;
            }
            // Partial match — only safe if exactly one result (ambiguous = skip)
            const partial = this.db.execute(`MATCH (n:Person) WHERE toLower(n.name) CONTAINS '${safeNorm}' RETURN n.id LIMIT 5`);
            if (partial.rows.length === 1) {
                const rawId = String(partial.rows[0]['n.id'] ?? '').trim();
                if (!rawId)
                    return null;
                // SparrowDB may truncate string properties to 7 chars — try to expand prefix
                if (this.knownPeople && rawId.length <= 7) {
                    const matches = Object.keys(this.knownPeople.people).filter(id => id.startsWith(rawId));
                    if (matches.length === 1)
                        return matches[0];
                }
                return rawId || null;
            }
        }
        catch (e) {
            logger.warn('⚠️ SparrowDB resolvePersonId search error:', e);
        }
        return null;
    }
    async findRelated(nodeId, maxDepth = 2) {
        // Batched BFS: 2 queries per depth level (out + in) covering the entire
        // frontier, instead of 2 queries per node. Reduces O(N×D) to O(D).
        try {
            const visited = new Set([nodeId]);
            let frontier = [nodeId];
            const results = [];
            for (let depth = 1; depth <= maxDepth; depth++) {
                if (frontier.length === 0)
                    break;
                const idList = frontier.map(id => cypherStr(id)).join(', ');
                // Two queries cover all outgoing and incoming edges for the whole frontier.
                const neighbourRows = [];
                try {
                    const out = this.db.execute(`MATCH (a:Knowledge)-[r:RELATED_TO]->(b:Knowledge) WHERE a.id IN [${idList}] RETURN b.id, r.strength`);
                    neighbourRows.push(...out.rows);
                }
                catch (e) {
                    logger.warn('⚠️ SparrowDB findRelated outgoing query failed at depth', depth, e);
                }
                try {
                    const inc = this.db.execute(`MATCH (b:Knowledge)-[r:RELATED_TO]->(a:Knowledge) WHERE a.id IN [${idList}] RETURN b.id, r.strength`);
                    neighbourRows.push(...inc.rows);
                }
                catch (e) {
                    logger.warn('⚠️ SparrowDB findRelated incoming query failed at depth', depth, e);
                }
                const next = [];
                for (const row of neighbourRows) {
                    const rawId = String(row['b.id'] ?? '');
                    // Stored as integer × 100 — divide back to 0.0–1.0 float (SparrowDB#229 workaround).
                    const rawStrength = row['r.strength'];
                    const edgeStrength = rawStrength != null
                        ? Math.round(parseFloatSafe(rawStrength)) / 100
                        : undefined;
                    // rawId may be truncated to 7 chars — use prefix search to
                    // resolve all matching sidecar entries.
                    const matches = this._findAllEntriesByPrefix(rawId);
                    const toProcess = matches.length > 0
                        ? matches
                        : [{ id: rawId, content: '', confidence: 0, contentType: '',
                                source: '', userId: '', timestamp: '', metadata: {} }];
                    for (const fullEntry of toProcess) {
                        const fullId = fullEntry.id;
                        if (!fullId || visited.has(fullId))
                            continue;
                        visited.add(fullId);
                        next.push(fullId);
                        results.push({
                            id: fullId,
                            content: fullEntry.content,
                            confidence: fullEntry.confidence,
                            distance: depth,
                            ...(edgeStrength !== undefined && { strength: edgeStrength }),
                            pathTypes: ['RELATED_TO'],
                            sourceSystem: 'sparrowdb'
                        });
                    }
                }
                frontier = next;
            }
            return results.slice(0, 20);
        }
        catch (error) {
            logger.warn('⚠️ SparrowDB findRelated error:', error);
            return [];
        }
    }
    async getEntitySummary(id) {
        // Check sidecar first for full content.
        const entry = this.contentIndex.get(id);
        // Try each label in the graph.
        for (const label of ['Knowledge', 'Person', 'Organization', 'Project',
            'Technology', 'Concept', 'Service', 'Event']) {
            let result;
            try {
                result = this.db.execute(`MATCH (n:${label} {id: ${cypherStr(id)}}) ` +
                    `RETURN n.id, n.name, n.description, n.notes, n.headline, ` +
                    `       n.profession, n.career, n.purpose, n.industry, ` +
                    `       n.expertise, n.role, n.status, n.domain, n.taskPattern, ` +
                    `       n.approach, n.path`);
            }
            catch {
                continue;
            }
            if (result.rows.length === 0)
                continue;
            // Strings from SparrowDB are truncated — use sidecar for content where available.
            const summary = {
                id,
                name: entry?.content?.split(' ').slice(0, 3).join(' ') ?? null,
                type: [label],
                summary: entry?.content?.slice(0, 200) ?? null,
                key_props: {},
                top_relationships: []
            };
            // Best-effort: fetch up to 4 connected nodes.
            try {
                const rels = this.db.execute(`MATCH (n {id: ${cypherStr(id)}})-[:RELATED_TO]-(m) ` +
                    `RETURN m.id LIMIT 4`);
                summary.top_relationships = rels.rows
                    .map(r => {
                    const mid = String(r['m.id'] ?? '');
                    const related = this._findEntryByPrefix(mid);
                    return related
                        ? { rel: 'RELATED_TO', name: related.content.slice(0, 40), id: related.id }
                        : null;
                })
                    .filter(Boolean);
            }
            catch { /* ignore */ }
            return summary;
        }
        // Not in graph at all — return from sidecar only if available.
        if (entry) {
            return {
                id,
                name: null,
                type: ['Knowledge'],
                summary: entry.content.slice(0, 200),
                key_props: {},
                top_relationships: []
            };
        }
        return null;
    }
    async getOperationalNodes() {
        const results = [];
        for (const label of ['ContextTrigger', 'ToolRoute']) {
            try {
                const r = this.db.execute(`MATCH (n:${label}) ` +
                    `RETURN n.id, n.type, n.name, n.description, n.taskPattern, n.actions`);
                for (const row of r.rows) {
                    const nodeId = String(row['n.id'] ?? '');
                    // Resolve full strings from sidecar.
                    const entry = this._findEntryByPrefix(nodeId);
                    results.push({
                        id: entry?.id ?? nodeId,
                        type: String(row['n.type'] ?? label),
                        name: String(row['n.name'] ?? ''),
                        description: String(row['n.description'] ?? row['n.taskPattern'] ?? ''),
                        actions: (() => {
                            try {
                                return JSON.parse(String(row['n.actions'] ?? '[]'));
                            }
                            catch {
                                return [];
                            }
                        })(),
                        taskPattern: row['n.taskPattern'] ? String(row['n.taskPattern']) : undefined
                    });
                }
            }
            catch { /* label may not exist yet */ }
        }
        return results;
    }
    async getEntityCandidates() {
        const candidates = [];
        for (const label of ['Person', 'Organization', 'Project', 'Technology', 'Concept', 'Service']) {
            try {
                const r = this.db.execute(`MATCH (n:${label}) RETURN n.id, n.name, n.aliases LIMIT 500`);
                for (const row of r.rows) {
                    const rawId = String(row['n.id'] ?? '');
                    if (!rawId)
                        continue;
                    const entry = this._findEntryByPrefix(rawId);
                    const id = entry?.id ?? rawId;
                    const name = String(row['n.name'] ?? entry?.content?.split(' ')[0] ?? '');
                    if (!name)
                        continue;
                    const aliases = (() => {
                        try {
                            return JSON.parse(String(row['n.aliases'] ?? '[]'));
                        }
                        catch {
                            return [];
                        }
                    })();
                    candidates.push({ id, name, labels: [label], aliases });
                }
            }
            catch { /* label may not exist yet */ }
        }
        return candidates.slice(0, 500);
    }
    async createAboutRelationships(sourceId, targetEntityIds) {
        if (targetEntityIds.length === 0)
            return;
        for (const targetId of targetEntityIds) {
            try {
                const src = this.db.execute(`MATCH (k:Knowledge {id: ${cypherStr(sourceId)}}) RETURN k.id`);
                if (src.rows.length === 0)
                    continue;
                // Target can be any label.
                let targetExists = false;
                for (const label of ['Knowledge', 'Person', 'Organization', 'Project',
                    'Technology', 'Concept', 'Service', 'Event']) {
                    try {
                        const t = this.db.execute(`MATCH (e:${label} {id: ${cypherStr(targetId)}}) RETURN e.id`);
                        if (t.rows.length > 0) {
                            targetExists = true;
                            break;
                        }
                    }
                    catch {
                        continue;
                    }
                }
                if (!targetExists)
                    continue;
                this.db.execute(`MATCH (k:Knowledge {id: ${cypherStr(sourceId)}}), ` +
                    `(e {id: ${cypherStr(targetId)}}) ` +
                    `CREATE (k)-[:ABOUT {strength: 100}]->(e)`);
            }
            catch (error) {
                logger.warn(`⚠️ SparrowDB createAboutRelationships ${sourceId} → ${targetId}:`, error);
            }
        }
        logger.debug(`⚡ SparrowDB: created ABOUT relationships: ${sourceId} → [${targetEntityIds.join(', ')}]`);
    }
    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------
    /**
     * Find a sidecar entry whose ID starts with the (possibly truncated) prefix.
     * Returns the first match. When multiple IDs share the same 7-char prefix,
     * disambiguation is impossible — this is a known limitation of the current
     * SparrowDB build's 7-char string truncation.
     */
    _findEntryByPrefix(prefix) {
        if (!prefix)
            return undefined;
        // Exact match first.
        if (this.contentIndex.has(prefix))
            return this.contentIndex.get(prefix);
        // Prefix search (handles 7-char truncation from SparrowDB native binding).
        for (const [key, entry] of this.contentIndex) {
            if (key.startsWith(prefix))
                return entry;
        }
        return undefined;
    }
    /**
     * Find ALL sidecar entries whose ID starts with the given prefix.
     * Used by findRelated to handle ambiguous 7-char truncated IDs.
     */
    _findAllEntriesByPrefix(prefix) {
        if (!prefix)
            return [];
        if (this.contentIndex.has(prefix)) {
            const e = this.contentIndex.get(prefix);
            return e ? [e] : [];
        }
        const matches = [];
        for (const [key, entry] of this.contentIndex) {
            if (key.startsWith(prefix))
                matches.push(entry);
        }
        return matches;
    }
    async _createRelationship(sourceId, targetId, relationshipType, strength) {
        try {
            const safeRelType = relationshipType.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
            // SparrowDB edge props only support integers (SparrowDB#229: float panics).
            // Store strength × 100 as integer (0–100); divide by 100 on read.
            let props = '';
            if (strength !== undefined) {
                if (strength >= 0 && strength <= 1) {
                    props = ` {strength: ${Math.round(strength * 100)}}`;
                }
                else {
                    logger.warn(`⚠️ Invalid strength value for relationship ${relationshipType}: ${strength}. Must be between 0 and 1. Ignoring strength property.`);
                }
            }
            this.db.execute(`MATCH (a:Knowledge {id: ${cypherStr(sourceId)}}), ` +
                `(b:Knowledge {id: ${cypherStr(targetId)}}) ` +
                `CREATE (a)-[:${safeRelType}${props}]->(b)`);
        }
        catch (error) {
            logger.warn(`⚠️ SparrowDB createRelationship ${relationshipType}:`, error);
        }
    }
    async _createSemanticRelationships(knowledge) {
        try {
            if (knowledge.contentType !== 'insight' && knowledge.contentType !== 'relationship')
                return;
            // Find similar nodes in sidecar (same contentType or source).
            const related = Array.from(this.contentIndex.values())
                .filter(e => e.id !== knowledge.id &&
                (e.contentType === knowledge.contentType || e.source === knowledge.source))
                .slice(0, 5);
            for (const rel of related) {
                await this._createRelationship(knowledge.id, rel.id, 'RELATED_TO');
            }
        }
        catch (error) {
            logger.warn('⚠️ SparrowDB createSemanticRelationships:', error);
        }
    }
    async _getRelationships(nodeId) {
        const relationships = [];
        try {
            const out = this.db.execute(`MATCH (a:Knowledge {id: ${cypherStr(nodeId)}})-[:RELATED_TO]->(b:Knowledge) ` +
                `RETURN b.id`);
            for (const row of out.rows) {
                const rawId = String(row['b.id'] ?? '');
                const target = this._findEntryByPrefix(rawId);
                relationships.push({
                    relationship: 'RELATED_TO',
                    relatedNode: target?.id ?? rawId,
                    relatedContent: (target?.content ?? '').slice(0, 80),
                    strength: null
                });
            }
            // ABOUT links to entity labels.
            for (const label of ['Person', 'Organization', 'Project', 'Technology', 'Concept', 'Service']) {
                try {
                    const about = this.db.execute(`MATCH (k:Knowledge {id: ${cypherStr(nodeId)}})-[:ABOUT]->(e:${label}) ` +
                        `RETURN e.id, e.name`);
                    for (const row of about.rows) {
                        relationships.push({
                            relationship: 'ABOUT',
                            relatedNode: String(row['e.id'] ?? ''),
                            relatedContent: String(row['e.name'] ?? ''),
                            strength: null
                        });
                    }
                }
                catch {
                    continue;
                }
            }
        }
        catch (error) {
            logger.warn('⚠️ SparrowDB _getRelationships error:', error);
        }
        return relationships.filter(r => r.relatedNode);
    }
    // -------------------------------------------------------------------------
    // Identity registry
    // -------------------------------------------------------------------------
    /**
     * Load config/known-people.json into memory.
     * Called on initialize(); silently skipped if file not yet generated.
     */
    _loadKnownPeople() {
        const configPath = join(__dirname, '..', '..', 'config', 'known-people.json');
        if (!existsSync(configPath)) {
            logger.debug('config/known-people.json not found — optional; run scripts/generate-known-people.mjs to enable identity registry');
            return;
        }
        try {
            this.knownPeople = null; // reset first; ensures clean state if re-called or validation fails
            const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
            if (!raw ||
                typeof raw !== 'object' ||
                typeof raw.nameIndex !== 'object' ||
                typeof raw.people !== 'object' ||
                !raw._meta ||
                typeof raw._meta.totalPeople !== 'number') {
                throw new Error('invalid known-people.json structure');
            }
            this.knownPeople = raw;
            logger.debug(`✅ Identity registry loaded: ${this.knownPeople._meta.totalPeople} people, ${this.knownPeople._meta.totalNameVariants} name variants`);
        }
        catch (e) {
            this.knownPeople = null;
            logger.warn('⚠️ Failed to load known-people.json:', e);
        }
    }
    // -------------------------------------------------------------------------
    // Sidecar persistence
    // -------------------------------------------------------------------------
    _loadSidecar() {
        try {
            if (existsSync(this.sidecarPath)) {
                const raw = readFileSync(this.sidecarPath, 'utf8');
                const data = JSON.parse(raw);
                for (const [k, v] of Object.entries(data)) {
                    this.contentIndex.set(k, v);
                }
            }
        }
        catch (error) {
            logger.warn('⚠️ SparrowDB: failed to load content sidecar:', error);
        }
    }
    _saveSidecar() {
        try {
            const data = {};
            for (const [k, v] of this.contentIndex) {
                data[k] = v;
            }
            writeFileSync(this.sidecarPath, JSON.stringify(data, null, 2), 'utf8');
        }
        catch (error) {
            logger.warn('⚠️ SparrowDB: failed to save content sidecar:', error);
        }
    }
}
