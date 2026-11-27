/**
 * Plate's copilot (`callCompletionApi`, @platejs/ai 52) reads a completion
 * as JSON `{ text }` (`await res.json()`), but agent-py's
 * `/v1/ai/complete` streams plain text (contract 0.6.0). Until
 * wave 9 every suggestion failed to parse and was swallowed by the
 * plugin's `onError`, so ghost text never showed. The copilot fetch hands
 * Plate the text as the JSON it reads; error responses pass through.
 */
export async function asPlateCompletion(res: Response): Promise<Response> {
  if (!res.ok) return res;
  const text = await res.text();
  return new Response(JSON.stringify({ text }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
}
