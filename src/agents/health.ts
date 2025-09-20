import { Agent, HttpEndpoint } from '@mastra/core';

export default new Agent({
  id: 'health',
  endpoints: [
    new HttpEndpoint({
      method: 'GET',
      path: '/health',
      handler: async () => {
        return { status: 200, body: 'OK' };
      },
    }),
  ],
});
