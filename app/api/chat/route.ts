export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { input } = await req.json();
    const assistantId = process.env.ASSISTANT_ID || 'asst_abc123xyz';
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable not set');
    }

    const threadResponse = await fetch('https://api.openai.com/v1/threads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v1',
      },
    });

    if (!threadResponse.ok) {
      const error = await threadResponse.text();
      throw new Error(`Thread creation failed: ${threadResponse.status} ${error}`);
    }

    const threadData = await threadResponse.json();
    const threadId = threadData.id;

    const messageResponse = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v1',
        },
        body: JSON.stringify({
          role: 'user',
          content: input,
        }),
      }
    );

    if (!messageResponse.ok) {
      const error = await messageResponse.text();
      throw new Error(`Message addition failed: ${messageResponse.status} ${error}`);
    }

    const runResponse = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v1',
        },
        body: JSON.stringify({
          assistant_id: assistantId,
          stream: true,
        }),
      }
    );

    if (!runResponse.ok) {
      const error = await runResponse.text();
      throw new Error(`Run creation failed: ${runResponse.status} ${error}`);
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const reader = runResponse.body?.getReader();
          if (!reader) throw new Error('No response body');

          let buffer = '';
          let runCompleted = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';

            for (const event of events) {
              if (event.includes('[DONE]')) {
                runCompleted = true;
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                continue;
              }

              try {
                const jsonStr = event.replace(/^data: /, '');
                const data = JSON.parse(jsonStr);

                if (data.event === 'thread.message.delta') {
                  const payload = JSON.stringify({ delta: data.data.delta });
                  controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
                }
              } catch (error) {
                console.error('Error parsing event:', error);
              }
            }
          }

          if (!runCompleted) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          }
        } catch (error) {
          console.error('Stream error:', error);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('API error:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal server error', 
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}