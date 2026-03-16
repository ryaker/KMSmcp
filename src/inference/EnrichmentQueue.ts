export interface EnrichmentJob {
  id: string
  content: string
  sourceSystem: 'mongodb' | 'mem0' | 'neo4j'
  queuedAt: Date
}

interface IEntityLinker {
  enrich(id: string, content: string, sourceSystem: string): Promise<void>
}

export class EnrichmentQueue {
  private queue: EnrichmentJob[] = []
  private processing = false
  private drainTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly MAX_DEPTH = 50
  private readonly DEBOUNCE_MS = 50

  constructor(private linker: IEntityLinker | null = null) {}

  add(id: string, content: string, sourceSystem: EnrichmentJob['sourceSystem']): void {
    if (this.queue.length >= this.MAX_DEPTH) {
      this.queue.shift()
    }

    const job: EnrichmentJob = {
      id,
      content,
      sourceSystem,
      queuedAt: new Date()
    }

    this.queue.push(job)
    console.log(`[EnrichmentQueue] Queued ${id} (queue depth: ${this.queue.length})`)
    this.scheduleDrain()
  }

  setLinker(linker: IEntityLinker): void {
    this.linker = linker
  }

  private scheduleDrain(): void {
    if (this.processing) return
    if (this.drainTimeout !== null) return

    this.drainTimeout = setTimeout(() => this.drain(), this.DEBOUNCE_MS)
  }

  private async drain(): Promise<void> {
    this.drainTimeout = null

    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      const job = this.queue.shift()!
      try {
        if (this.linker) {
          await this.linker.enrich(job.id, job.content, job.sourceSystem)
          console.log(`[EnrichmentQueue] Enriched ${job.id}`)
        }
      } catch (err) {
        console.warn(
          `[EnrichmentQueue] Failed to enrich ${job.id}:`,
          err instanceof Error ? err.message : String(err)
        )
        // continue — never stop the drain loop on individual failures
      }
    }

    this.processing = false
  }
}
