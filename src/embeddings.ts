import OpenAI from 'openai';

export class Embeddings {
  private client: OpenAI;
  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const resp = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return resp.data[0].embedding;
  }
}
