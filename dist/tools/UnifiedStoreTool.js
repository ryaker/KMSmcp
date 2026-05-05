/**
 * Unified Store Tool - The heart of intelligent storage routing
 */
import crypto from 'crypto';
import { FACTCache } from '../cache/FACTCache.js';
import { ContentInference } from '../inference/ContentInference.js';
const debug = (...args) => { if (process.env.KMS_DEBUG)
    console.error(...args); };
export class UnifiedStoreTool {
    router;
    storage;
    cache;
    ollamaRouter;
    enrichmentQueue;
    constructor(router, storage, cache, ollamaRouter, enrichmentQueue) {
        this.router = router;
        this.storage = storage;
        this.cache = cache; // Now using real cache
        this.ollamaRouter = ollamaRouter ?? null;
        this.enrichmentQueue = enrichmentQueue ?? null;
    }
    /**
     * Store knowledge with intelligent routing
     * This is the main "unified_store" tool function
     */
    async store(args) {
        const startTime = Date.now();
        debug(`\n🚀 UNIFIED STORE Starting...`);
        debug(`📝 Content: "${args.content.slice(0, 100)}${args.content.length > 100 ? '...' : ''}"`);
        // Apply smart inference if needed
        let enrichedArgs = { ...args };
        const inference = ContentInference.analyze(args.content);
        // Use inference to fill in missing parameters
        if (!args.contentType) {
            enrichedArgs.contentType = inference.contentType;
            debug(`🧠 Inferred content type: ${inference.contentType} (confidence: ${inference.confidence})`);
        }
        if (!args.source) {
            // Infer source based on content and project
            if (inference.detectedProject) {
                enrichedArgs.source = 'technical';
            }
            else if (inference.contentType === 'memory' || inference.contentType === 'insight') {
                enrichedArgs.source = 'personal';
            }
            else {
                enrichedArgs.source = 'cross_domain';
            }
            debug(`🧠 Inferred source: ${enrichedArgs.source}`);
        }
        // Enhance metadata with inference
        const enhancedMetadata = ContentInference.generateMetadata(args.content, args.metadata);
        enrichedArgs.metadata = enhancedMetadata;
        // Use inferred confidence if not provided
        if (!args.confidence) {
            enrichedArgs.confidence = inference.confidence;
        }
        // Suggest relationships if none provided
        if (!args.relationships || args.relationships.length === 0) {
            const suggestedRelationships = ContentInference.suggestRelationships(args.content);
            if (suggestedRelationships.length > 0) {
                debug(`💡 Suggested relationships: ${suggestedRelationships.map(r => r.type).join(', ')}`);
            }
        }
        debug(`🏷️  Type: ${enrichedArgs.contentType}, Source: ${enrichedArgs.source}`);
        debug(`👤 User: ${enrichedArgs.userId || 'auto'}, Context: ${inference.detectedProject || 'general'}`);
        debug(`🏷️  Tags: ${enhancedMetadata.tags?.join(', ') || 'none'}`);
        const defaultUserId = process.env.KMS_DEFAULT_USER_ID || 'personal';
        const resolvedUserId = enrichedArgs.userId || defaultUserId;
        // Create unified knowledge object
        const knowledge = {
            id: crypto.randomUUID(),
            content: args.content,
            contentType: enrichedArgs.contentType,
            source: enrichedArgs.source,
            userId: resolvedUserId,
            metadata: enrichedArgs.metadata || {},
            timestamp: new Date(),
            confidence: enrichedArgs.confidence || 0.8,
            relationships: enrichedArgs.relationships || []
        };
        // Step 1: Get intelligent storage decision
        const routingStartTime = Date.now();
        let primarySystem;
        let secondarySystems;
        let decision;
        if (this.ollamaRouter) {
            // Pass all resolved knowledge fields so the fallback router has full context
            const routingMetadata = {
                ...knowledge.metadata,
                contentType: knowledge.contentType,
                source: knowledge.source,
                userId: knowledge.userId,
            };
            const ollamaDecision = await this.ollamaRouter.getStorageTargets(knowledge.content, routingMetadata);
            primarySystem = ollamaDecision.targets[0];
            secondarySystems = ollamaDecision.targets.slice(1);
            // Derive cacheStrategy from the fallback router so it stays policy-consistent
            const fallbackDecision = this.router.determineStorage(knowledge);
            decision = {
                primary: primarySystem,
                secondary: secondarySystems,
                cacheStrategy: fallbackDecision.cacheStrategy,
                reasoning: `OllamaStorageRouter(${ollamaDecision.source}, confidence=${ollamaDecision.confidence.toFixed(2)})`
            };
        }
        else {
            decision = this.router.determineStorage(knowledge);
            primarySystem = decision.primary;
            secondarySystems = decision.secondary ?? [];
        }
        const routingTime = Date.now() - routingStartTime;
        debug(`\n🧠 STORAGE DECISION:`);
        debug(`   Primary: ${decision.primary}`);
        debug(`   Secondary: ${decision.secondary?.join(', ') || 'none'}`);
        debug(`   Cache Strategy: ${decision.cacheStrategy}`);
        debug(`   Reasoning: ${decision.reasoning}`);
        // Step 2: Store in systems
        const storageStartTime = Date.now();
        try {
            // Store in primary system
            await this.storeInSystem(knowledge, primarySystem);
            // Store in secondary systems (for cross-linking)
            if (secondarySystems.length > 0) {
                debug(`\n🔗 Cross-linking to secondary systems...`);
                await Promise.all(secondarySystems.map(async (system) => {
                    try {
                        await this.storeInSystem(knowledge, system);
                        debug(`✅ Cross-stored in ${system}`);
                    }
                    catch (error) {
                        console.warn(`⚠️ Failed to cross-store in ${system}:`, error instanceof Error ? error.message : String(error));
                    }
                }));
            }
            // Queue enrichment once for the primary system (same content — no need to repeat per secondary)
            if (this.enrichmentQueue) {
                this.enrichmentQueue.add(knowledge.id, knowledge.content, primarySystem);
            }
            const storageTime = Date.now() - storageStartTime;
            // Step 3: Cache based on strategy
            let cached = false;
            if (decision.cacheStrategy !== 'skip') {
                const cacheKey = FACTCache.generateKnowledgeKey(knowledge.userId, knowledge.contentType, { id: knowledge.id });
                if (this.cache) {
                    const ttl = this.getCacheTTL(decision.cacheStrategy);
                    await this.cache.set(cacheKey, knowledge, ttl);
                    cached = true;
                    debug(`💾 Cached with ${decision.cacheStrategy} strategy (TTL: ${Math.round(ttl / 1000)}s)`);
                }
            }
            const totalTime = Date.now() - startTime;
            debug(`\n✅ UNIFIED STORE COMPLETE`);
            debug(`   ID: ${knowledge.id}`);
            debug(`   Total Time: ${totalTime}ms`);
            debug(`   Systems: ${[decision.primary, ...(decision.secondary || [])].join(', ')}`);
            return {
                success: true,
                id: knowledge.id,
                storageDecision: decision,
                cached,
                performance: {
                    routingTime,
                    storageTime,
                    totalTime
                }
            };
        }
        catch (error) {
            console.error(`❌ UNIFIED STORE FAILED:`, error);
            return {
                success: false,
                id: knowledge.id,
                storageDecision: decision,
                cached: false,
                performance: {
                    routingTime,
                    storageTime: Date.now() - storageStartTime,
                    totalTime: Date.now() - startTime
                }
            };
        }
    }
    /**
     * Store knowledge in a specific system
     */
    async storeInSystem(knowledge, system) {
        debug(`📊 Storing in ${system}...`);
        switch (system) {
            case 'mem0':
                await this.storage.mem0.store(knowledge);
                break;
            case 'neo4j':
                await this.storage.neo4j.store(knowledge);
                break;
            case 'mongodb':
                await this.storage.mongodb.store(knowledge);
                break;
            default:
                throw new Error(`Unknown storage system: ${system}`);
        }
        debug(`✅ Successfully stored in ${system}`);
    }
    /**
     * Get cache TTL based on strategy
     */
    getCacheTTL(strategy) {
        switch (strategy) {
            case 'L1': return 300000; // 5 minutes - aggressive caching
            case 'L2': return 1800000; // 30 minutes - moderate caching
            case 'L3': return 3600000; // 1 hour - conservative caching
            default: return 1800000; // Default to L2
        }
    }
    /**
     * Get storage recommendation without storing
     * This supports the "get_storage_recommendation" tool
     */
    getStorageRecommendation(args) {
        debug(`\n🤔 STORAGE RECOMMENDATION REQUEST`);
        debug(`📝 Content: "${args.content.slice(0, 100)}..."`);
        debug(`🏷️  Type: ${args.contentType || 'auto-detect'}`);
        const decision = this.router.determineStorage({
            content: args.content,
            contentType: args.contentType,
            metadata: args.metadata
        });
        debug(`\n💡 RECOMMENDATION:`);
        debug(`   Primary: ${decision.primary}`);
        debug(`   Secondary: ${decision.secondary?.join(', ') || 'none'}`);
        debug(`   Cache: ${decision.cacheStrategy}`);
        debug(`   Why: ${decision.reasoning}`);
        return decision;
    }
    /**
     * Test the routing logic with sample data
     */
    async testRouting() {
        debug(`\n🧪 TESTING ROUTING LOGIC`);
        const testCases = [
            {
                content: "Client prefers morning coaching sessions and responds well to visualization techniques",
                contentType: "memory"
            },
            {
                content: "Reframing technique shows 85% effectiveness for anxiety-related issues across 50 clients",
                contentType: "insight"
            },
            {
                content: "Session configuration: duration 60min, frequency weekly, payment auto-renew enabled",
                contentType: "fact"
            },
            {
                content: "Discovered pattern: clients with morning routine consistency achieve goals 40% faster",
                contentType: "pattern"
            },
            {
                content: "Fixed bug in authentication middleware causing 500 errors on password reset",
                contentType: "procedure"
            }
        ];
        const results = testCases.map(test => {
            const decision = this.router.determineStorage({
                content: test.content,
                contentType: test.contentType
            });
            debug(`\n📝 "${test.content.slice(0, 50)}..."`);
            debug(`   Type: ${test.contentType} → ${decision.primary}`);
            debug(`   Reasoning: ${decision.reasoning}`);
            return {
                content: test.content,
                contentType: test.contentType,
                decision
            };
        });
        return { tests: results };
    }
    /**
     * Get routing statistics
     */
    getRoutingStats() {
        return this.router.getRoutingStats();
    }
    // ===========================================================================
    // Corrective operations (kms_update / kms_delete / kms_supersede / kms_flag /
    // kms_reap). These mutate or hide existing entries — the additive complement
    // to `store`.
    //
    // Soft-delete model: kms_delete and kms_supersede flag entries rather than
    // physically removing them. The reaper sweeps flagged entries older than 90
    // days. The read path (unified_search and downstream context-injection) hides
    // flagged entries by default; pass options.includeFlagged=true to see them.
    // ===========================================================================
    /**
     * Update an existing entry by ID. Mutates content/metadata in place; bumps
     * timestamp. NOT a flag operation — for "I was wrong" use supersede instead.
     * Use update for genuine edits (typo fix, metadata correction, confidence
     * adjustment).
     *
     * Calls SparrowDB and MongoDB. Mem0 is skipped — its memories are LLM-managed
     * and re-extracted on next store, so direct edits don't make sense.
     */
    async update(args) {
        const updates = {};
        if (args.content !== undefined)
            updates.content = args.content;
        if (args.confidence !== undefined)
            updates.confidence = args.confidence;
        // Fetch existing record so we can merge metadata instead of overwriting it.
        // This prevents $set from dropping existing metadata keys and prior
        // update_history entries that the caller did not include in args.metadata.
        let existingMetadata = {};
        try {
            const existing = await this.storage.mongodb.findById(args.id);
            if (existing?.metadata)
                existingMetadata = existing.metadata;
        }
        catch (e) {
            console.warn('⚠️  unified_update: could not fetch existing metadata for merge (non-fatal):', e);
        }
        // Merge: existing metadata base, then caller-supplied overrides, then
        // append the new audit entry to update_history (preserving prior entries).
        const mergedMetadata = {
            ...existingMetadata,
            ...(args.metadata || {})
        };
        if (args.reason) {
            const prior = Array.isArray(mergedMetadata.update_history) ? mergedMetadata.update_history : [];
            mergedMetadata.update_history = [...prior, { at: new Date().toISOString(), reason: args.reason }];
        }
        updates.metadata = mergedMetadata;
        const backends = [];
        if (typeof this.storage.neo4j.update === 'function') {
            try {
                const ok = await this.storage.neo4j.update(args.id, updates);
                if (ok)
                    backends.push('sparrowdb');
            }
            catch (e) {
                console.warn('⚠️  unified_update SparrowDB error:', e);
            }
        }
        try {
            const ok = await this.storage.mongodb.update(args.id, updates);
            if (ok)
                backends.push('mongodb');
        }
        catch (e) {
            console.warn('⚠️  unified_update MongoDB error:', e);
        }
        // Invalidate cache after any successful backend update so stale search
        // results and knowledge cache entries don't serve pre-update content.
        if (backends.length > 0 && this.cache) {
            try {
                await this.cache.invalidate('kms:search:*');
                await this.cache.invalidate(`*${args.id}*`);
            }
            catch { /* non-fatal */ }
        }
        return {
            success: backends.length > 0,
            id: args.id,
            backends,
            reason: args.reason
        };
    }
    /**
     * Soft-delete: flag the entry as DELETED. Reversible until the reaper runs
     * (90 days by default). Hidden from search by default.
     *
     * Use kms_supersede if there's a corrected replacement; use kms_delete only
     * for noise (test entries, accidental stores, garbage).
     */
    async delete(args) {
        return this.flag({
            id: args.id,
            flag: 'DELETED',
            note: args.reason,
            by: args.by
        });
    }
    /**
     * Mark an entry with an arbitrary flag without modifying its content.
     * Pass `flag=null` to clear (un-retract).
     *
     * Used by kms_delete (DELETED), kms_supersede (SUPERSEDED), and direct
     * flagging for RETRACTED/UNVERIFIED.
     */
    async flag(args) {
        const backends = [];
        if (typeof this.storage.neo4j.flag === 'function') {
            try {
                const ok = await this.storage.neo4j.flag(args.id, args.flag, args.note, args.by, args.superseded_by);
                if (ok)
                    backends.push('sparrowdb');
            }
            catch (e) {
                console.warn('⚠️  unified_flag SparrowDB error:', e);
            }
        }
        try {
            const ok = await this.storage.mongodb.flag(args.id, args.flag, args.note, args.by, args.superseded_by);
            if (ok)
                backends.push('mongodb');
        }
        catch (e) {
            console.warn('⚠️  unified_flag MongoDB error:', e);
        }
        // Mem0: best-effort delete on flag != null. Mem0 has no flag concept and
        // its memories get re-extracted on next store; deleting prevents stale
        // copies from leaking back through Mem0 search.
        if (args.flag !== null) {
            try {
                await this.storage.mem0.deleteMemory(args.id);
            }
            catch (e) {
                // Mem0 IDs don't always match unified IDs; non-fatal.
                debug(`Mem0 delete on flag failed (non-fatal): ${e}`);
            }
        }
        // Invalidate cache so the next read sees the flag.
        // Search cache keys are hashed (kms:search:<hash>) and don't contain entry
        // IDs, so we have to invalidate the whole search namespace. Knowledge cache
        // entries that mention this ID also get cleared.
        if (this.cache) {
            try {
                await this.cache.invalidate('kms:search:*');
                await this.cache.invalidate(`*${args.id}*`);
            }
            catch { /* non-fatal */ }
        }
        return {
            success: backends.length > 0,
            id: args.id,
            backends,
            flag: args.flag,
            reason: args.note
        };
    }
    /**
     * Atomic supersede: store a new entry, then flag the old one as SUPERSEDED
     * with a back-link to the new entry. The new entry's metadata gets a forward
     * link (`supersedes`) for bidirectional chain tracing.
     *
     * If the flag step fails, rolls back by hard-deleting the new entry to keep
     * the operation atomic. Returns the new entry's ID on success.
     */
    async supersede(args) {
        // Step 1: store the new entry (with forward-link to the old one)
        const storeResult = await this.store({
            content: args.new_content,
            contentType: args.contentType,
            source: args.source,
            userId: args.userId,
            confidence: args.confidence,
            metadata: {
                ...(args.metadata || {}),
                supersedes: args.old_id,
                supersede_reason: args.reason
            }
        });
        if (!storeResult.success) {
            return {
                success: false,
                old_id: args.old_id,
                error: 'Failed to store new entry'
            };
        }
        const new_id = storeResult.id;
        // Step 2: flag the old entry as SUPERSEDED with back-link to the new one.
        // Each required backend is called individually so we can detect partial
        // failures — flag() returns success=true if ANY backend succeeded, which
        // would leave the old entry live in the graph if SparrowDB succeeded but
        // MongoDB failed (or vice-versa). We require ALL present backends to succeed.
        const flagNote = args.reason || `Superseded by ${new_id}`;
        const flaggedBackends = [];
        const failedBackends = [];
        if (typeof this.storage.neo4j.flag === 'function') {
            try {
                const ok = await this.storage.neo4j.flag(args.old_id, 'SUPERSEDED', flagNote, undefined, new_id);
                if (ok)
                    flaggedBackends.push('sparrowdb');
                else
                    failedBackends.push('sparrowdb');
            }
            catch (e) {
                failedBackends.push('sparrowdb');
                console.warn(`⚠️  unified_supersede SparrowDB flag error:`, e);
            }
        }
        try {
            const ok = await this.storage.mongodb.flag(args.old_id, 'SUPERSEDED', flagNote, undefined, new_id);
            if (ok)
                flaggedBackends.push('mongodb');
            else
                failedBackends.push('mongodb');
        }
        catch (e) {
            failedBackends.push('mongodb');
            console.warn(`⚠️  unified_supersede MongoDB flag error:`, e);
        }
        // Invalidate cache after flagging (mirrors flag() behavior).
        if (this.cache) {
            try {
                await this.cache.invalidate('kms:search:*');
                await this.cache.invalidate(`*${args.old_id}*`);
            }
            catch { /* non-fatal */ }
        }
        if (failedBackends.length > 0) {
            // Rollback: hard-delete the new entry so we don't leave a dangling
            // replacement. Surface the real failure reason for the caller.
            console.warn(`⚠️  unified_supersede rollback: flag failed on [${failedBackends.join(', ')}], deleting new entry ${new_id}`);
            try {
                if (typeof this.storage.neo4j.delete === 'function') {
                    await this.storage.neo4j.delete(new_id);
                }
                await this.storage.mongodb.delete(new_id);
                await this.storage.mem0.deleteMemory(new_id).catch(() => { });
                // Undo any flag that did succeed so backends stay in sync.
                for (const backend of flaggedBackends) {
                    if (backend === 'sparrowdb' && typeof this.storage.neo4j.flag === 'function') {
                        await this.storage.neo4j.flag(args.old_id, null).catch(() => { });
                    }
                    else if (backend === 'mongodb') {
                        await this.storage.mongodb.flag(args.old_id, null).catch(() => { });
                    }
                }
            }
            catch (e) {
                console.error('❌ unified_supersede rollback failed:', e);
            }
            return {
                success: false,
                old_id: args.old_id,
                error: `Flag step failed on backend(s): [${failedBackends.join(', ')}] for entry ${args.old_id} (entry not found or backend write error). New entry ${new_id} was rolled back — retry may succeed if this was transient.`
            };
        }
        return {
            success: true,
            old_id: args.old_id,
            new_id,
            backends: flaggedBackends,
            reason: args.reason
        };
    }
    /**
     * Reaper — find or hard-delete flagged entries older than `olderThanDays`.
     * Defaults to 90 days, dry-run by default.
     *
     * dryRun=true (default): returns the list of candidates without deleting.
     * dryRun=false: hard-deletes each candidate from all backends.
     */
    async reap(args) {
        const olderThanDays = args.olderThanDays ?? 90;
        const dryRun = args.dryRun !== false; // default true
        const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
        // Collect candidates from each backend, deduplicated by ID
        const candidatesById = new Map();
        // SparrowDB candidates. `await` defensively — the current SparrowDB
        // implementation is synchronous, but the `neo4j` slot is typed as
        // GraphStorage and could hold an async listFlagged in the future.
        // `await` on a non-Promise resolves to the value, so this is safe for
        // both sync and async implementations.
        if (typeof this.storage.neo4j.listFlagged === 'function') {
            try {
                const flagged = await this.storage.neo4j.listFlagged();
                for (const e of flagged) {
                    if (e.flag_date && new Date(e.flag_date) < cutoff) {
                        const existing = candidatesById.get(e.id);
                        if (existing) {
                            existing.backends_found.push('sparrowdb');
                        }
                        else {
                            candidatesById.set(e.id, {
                                id: e.id,
                                flag: e.flag,
                                flag_date: e.flag_date,
                                flag_note: e.flag_note,
                                backends_found: ['sparrowdb']
                            });
                        }
                    }
                }
            }
            catch (e) {
                console.warn('⚠️  reap: SparrowDB listFlagged error:', e);
            }
        }
        // MongoDB candidates
        try {
            const flagged = await this.storage.mongodb.listFlagged(cutoff);
            for (const e of flagged) {
                const existing = candidatesById.get(e.id);
                if (existing) {
                    existing.backends_found.push('mongodb');
                }
                else {
                    candidatesById.set(e.id, {
                        id: e.id,
                        flag: String(e.flag),
                        flag_date: e.flag_date instanceof Date ? e.flag_date.toISOString() : e.flag_date,
                        flag_note: e.flag_note,
                        backends_found: ['mongodb']
                    });
                }
            }
        }
        catch (e) {
            console.warn('⚠️  reap: MongoDB listFlagged error:', e);
        }
        const candidates = Array.from(candidatesById.values());
        if (dryRun) {
            return {
                success: true,
                olderThanDays,
                dryRun: true,
                candidates
            };
        }
        // Apply deletions
        const deleted = [];
        for (const c of candidates) {
            const backends = [];
            if (typeof this.storage.neo4j.delete === 'function') {
                try {
                    const ok = await this.storage.neo4j.delete(c.id);
                    if (ok)
                        backends.push('sparrowdb');
                }
                catch (e) { /* logged below */ }
            }
            try {
                const ok = await this.storage.mongodb.delete(c.id);
                if (ok)
                    backends.push('mongodb');
            }
            catch (e) { /* logged below */ }
            try {
                await this.storage.mem0.deleteMemory(c.id);
                backends.push('mem0');
            }
            catch { /* mem0 IDs may not match — non-fatal */ }
            deleted.push({ id: c.id, backends });
            console.log(`🗑️  reap: hard-deleted ${c.id} (flag=${c.flag}, age>${olderThanDays}d) from [${backends.join(',')}]`);
        }
        return {
            success: true,
            olderThanDays,
            dryRun: false,
            candidates,
            deleted
        };
    }
}
