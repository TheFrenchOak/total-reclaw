/**
 * Local embeddings for tests using all-MiniLM-L6-v2 (384 dims).
 * Runs entirely on CPU via ONNX Runtime — no API key needed.
 */

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
export const VECTOR_DIM = 384;

let embedder: FeatureExtractionPipeline | null = null;

export async function initEmbeddings(): Promise<void> {
  if (embedder) return;
  embedder = await pipeline('feature-extraction', MODEL, { dtype: 'fp32' });
}

export async function embed(text: string): Promise<number[]> {
  if (!embedder) await initEmbeddings();
  const result = await embedder!(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data as Float32Array);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!embedder) await initEmbeddings();
  const results: number[][] = [];
  // Process sequentially to avoid OOM on large batches
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}
