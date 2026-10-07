export type EmbedModel = 'code' | 'text';

export class OllamaService {
  private baseUrl: string;
  private codeModel: string;
  private textModel: string;

  constructor(baseUrl: string, codeModel: string, textModel: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.codeModel = codeModel;
    this.textModel = textModel;
    console.log(`[ollama] Initialized with code model '${codeModel}' and text model '${textModel}'`);
  }

  private getModel(type: EmbedModel): string {
    return type === 'code' ? this.codeModel : this.textModel;
  }

  async embed(text: string, model: EmbedModel = 'text'): Promise<number[]> {
    const modelName = this.getModel(model);

    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelName,
          input: text,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as { embeddings: number[][] };
      
      if (!data.embeddings || data.embeddings.length === 0) {
        throw new Error('No embeddings returned from Ollama');
      }

      return data.embeddings[0];
    } catch (error) {
      console.error(`[ollama] Embed error with model '${modelName}':`, error);
      throw error;
    }
  }

  async embedBatch(texts: string[], model: EmbedModel = 'text'): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const modelName = this.getModel(model);

    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelName,
          input: texts,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as { embeddings: number[][] };
      
      if (!data.embeddings || data.embeddings.length !== texts.length) {
        throw new Error(
          `Expected ${texts.length} embeddings, got ${data.embeddings?.length || 0}`
        );
      }

      console.log(`[ollama] Generated ${texts.length} embeddings with model '${modelName}'`);
      return data.embeddings;
    } catch (error) {
      console.error(`[ollama] Batch embed error with model '${modelName}':`, error);
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
      });
      return response.ok;
    } catch (error) {
      console.error('[ollama] Health check failed:', error);
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { models?: Array<{ name: string }> };
      return data.models?.map((m) => m.name) || [];
    } catch (error) {
      console.error('[ollama] Failed to get models:', error);
      return [];
    }
  }
}
