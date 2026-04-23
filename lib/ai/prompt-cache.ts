/**
 * Prompt-cache helpers for Anthropic Messages API.
 *
 * The Triple C system prompt is ~835 lines and identical across every call —
 * perfect candidate for ephemeral cache. We mark the system prompt as cached
 * so subsequent requests within ~5min hit the cache (10× cheaper, faster
 * time-to-first-token).
 *
 * Critical: the cache only matches when the cached portion is byte-identical.
 * Anything that varies per-request (feedback block, user task) MUST sit in
 * the user message, NOT the system field.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { getSystemPrompt } from './system-prompt';

/**
 * The system prompt as an array of cached text blocks. Pass this directly
 * as the `system` parameter to `client.messages.stream()` or `.create()`.
 *
 * Returning a fresh array each call is fine — the cache key is the *content*
 * of each block, not the array reference.
 *
 * `mode` lets ai-analysis routes select between the full and lean prompts
 * (each cached independently).
 */
export function cachedSystemPrompt(mode = 'default'): Anthropic.Messages.TextBlockParam[] {
  return [
    {
      type: 'text',
      text: getSystemPrompt(mode),
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/**
 * Compose a user message with the feedback block prepended. Keeps the
 * "feedback first, task second" ordering consistent across endpoints.
 *
 * If feedback is empty (no recap available), just returns the task untouched.
 */
export function withFeedback(feedbackBlock: string | null, taskMessage: string): string {
  if (!feedbackBlock) return taskMessage;
  return `${feedbackBlock}\n\n${taskMessage}`;
}
