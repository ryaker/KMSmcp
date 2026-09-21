#!/bin/zsh
# Phase 1 dry-run: harvest Claude labels across high-volume projects. Review-only.
cd /Volumes/Dev/wt-labels-harvest-p1 || exit 1
npx tsx src/scripts/harvest-claude-transcripts.ts \
  --projects -Volumes-Dev-DittoTrade,-Volumes-Dev-DittoTrade-DEV-frontend--claude-worktrees-wt-flowstates,-Users-ryaker-Dev-SparrowDB,-Users-ryaker-Dev-KMSmcp,-Volumes-Dev-SparrowOntology,-Volumes-Dev-Tengo,-Volumes-Dev-Tengo-Portal,-Volumes-Dev-personal-portfolio,-Volumes-Dev-Transcriber,-Volumes-Dev-bc26-backend,-Users-ryaker-Dev-bc26-backend \
  --cap 50 --out phase1-dry.jsonl 2>&1 | tail -6