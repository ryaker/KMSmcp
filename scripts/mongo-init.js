// MongoDB Initialization Script for Unified KMS
// Creates database, collections, and indexes

db = db.getSiblingDB('unified_kms');

// Create collections
db.createCollection('unified_knowledge');

// Create indexes for optimal performance
db.unified_knowledge.createIndex({ "id": 1 }, { unique: true });
db.unified_knowledge.createIndex({ "contentType": 1 });
db.unified_knowledge.createIndex({ "source": 1 });
db.unified_knowledge.createIndex({ "userId": 1 });
db.unified_knowledge.createIndex({ "coachId": 1 });
db.unified_knowledge.createIndex({ "timestamp": -1 });
db.unified_knowledge.createIndex({ "confidence": -1 });

// Text search index for content
db.unified_knowledge.createIndex({ 
  "content": "text", 
  "metadata.tags": "text" 
}, {
  weights: {
    "content": 10,
    "metadata.tags": 5
  },
  name: "content_text_search"
});

// Compound indexes for common queries
db.unified_knowledge.createIndex({ "source": 1, "contentType": 1, "timestamp": -1 });
db.unified_knowledge.createIndex({ "userId": 1, "contentType": 1, "confidence": -1 });
db.unified_knowledge.createIndex({ "coachId": 1, "source": 1, "timestamp": -1 });

print('MongoDB initialized successfully for Unified KMS');
print('Collections created: unified_knowledge');
print('Indexes created for optimal query performance');