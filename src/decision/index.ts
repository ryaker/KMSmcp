export type {
  ChoiceDecisionAnswer,
  ChoiceDecisionQuestion,
  DecisionAnswer,
  DecisionEngine,
  DecisionJson,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  DecisionUsage,
  NoulDecisionAnswer,
  NoulDecisionQuestion,
  ScoreDecisionAnswer,
  ScoreDecisionQuestion,
} from './types.js'
export { JevDecisionEngine, createJevDecisionEngineFromEnv } from './JevDecisionEngine.js'
export {
  JsonlDecisionLog,
  decisionLogFromEnv,
  type CandidateDecisionRecord,
  type DecisionLogSink,
  type ShadowAction,
  type ShadowRunRecord,
} from './decisionLog.js'
export {
  JEV_SHADOW_RERANK_FLAG,
  JEV_SHADOW_REORDER_FLAG,
  isJevShadowRerankEnabled,
  jevShadowAction,
  jevShadowTopK,
  runShadowRerank,
} from './shadowRerank.js'
export {
  JEV_WRITE_DEDUP_ACT_FLAG,
  JEV_WRITE_DEDUP_FLAG,
  buildWriteDedupResolution,
  isJevWriteDedupActRequested,
  isJevWriteDedupEnabled,
  jevWriteDedupMinSimilarity,
  runWriteDedupShadow,
  writeDedupLogFromEnv,
  type WriteDedupGateOutcome,
  type WriteDedupLogRow,
  type WriteDedupResolutionRecord,
  type WriteDedupRunRecord,
  type WriteDedupShadowCandidate,
} from './writeDedupShadow.js'
export { WRITE_DEDUP_AUTO_ACTIONS, type WriteDedupProposal } from './writeDedupPolicy.js'
