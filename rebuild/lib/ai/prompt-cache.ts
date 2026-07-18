/**
 * Prompt caching: the (large, stable) system prompt is sent with an
 * Anthropic cache_control breakpoint so repeated analyses reuse the cache.
 */
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './system-prompt';

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export function cachedSystemBlocks(extraContext: string) {
  return [
    {
      type: 'text' as const,
      text: SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' as const },
    },
    ...(extraContext ? [{ type: 'text' as const, text: extraContext }] : []),
  ];
}

export async function analyze(portfolioJson: string, question: string, extraContext = ''): Promise<string> {
  const res = await anthropic().messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2000,
    system: cachedSystemBlocks(extraContext),
    messages: [
      {
        role: 'user',
        content: `Live portfolio data:\n\`\`\`json\n${portfolioJson}\n\`\`\`\n\n${question}`,
      },
    ],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
