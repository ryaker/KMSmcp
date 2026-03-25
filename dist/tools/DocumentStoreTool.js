/**
 * DocumentStoreTool — store large full-text documents directly into MongoDB.
 *
 * Unlike unified_store (which routes based on content type), this tool always
 * writes to the `documents` collection without any routing logic, size limits,
 * or Mem0/SparrowDB involvement. Intended for articles, transcripts, reports,
 * specs, and any other archival content that needs full-text search later.
 */
import crypto from 'crypto';
import { logger } from '../logger.js';
export class DocumentStoreTool {
    mongodb;
    constructor(mongodb) {
        this.mongodb = mongodb;
    }
    async store(args) {
        const id = `doc_${crypto.randomBytes(8).toString('hex')}`;
        const trimmedContent = args.content.trim();
        const wordCount = trimmedContent.length === 0 ? 0 : trimmedContent.split(/\s+/).length;
        const storedAt = new Date();
        const doc = {
            id,
            title: args.title,
            content: args.content,
            docType: args.docType ?? 'document',
            sourceUrl: args.sourceUrl,
            publishedDate: args.publishedDate,
            tags: args.tags ?? [],
            wordCount,
            storedAt,
            userId: args.userId ?? process.env.KMS_DEFAULT_USER_ID ?? '',
        };
        logger.debug(`📄 DocumentStore: "${args.title}" (${wordCount} words)`);
        const result = await this.mongodb.storeDocument(doc);
        logger.debug(`📄 DocumentStore: ${result.isNew ? 'stored' : 'duplicate, skipped'} — id=${result.id}`);
        return {
            success: true,
            id: result.id,
            isNew: result.isNew,
            wordCount,
            storedAt: storedAt.toISOString(),
        };
    }
    async search(args) {
        const docs = await this.mongodb.searchDocuments(args.query, args.tags, args.limit ?? 10, args.userId);
        const results = docs.map(d => ({
            id: d.id,
            title: d.title,
            docType: d.docType,
            wordCount: d.wordCount,
            storedAt: d.storedAt instanceof Date ? d.storedAt.toISOString() : String(d.storedAt),
            tags: d.tags,
            excerpt: d.content.slice(0, 300) + (d.content.length > 300 ? '…' : ''),
        }));
        return { results, count: results.length };
    }
}
