import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import * as http from 'http';
import * as https from 'https';

import { getEnhancedPath } from '../../utils/env';
import { parseCommand } from '../../utils/mcp';
import type { ClaudianMcpServer } from '../types';
import { getMcpServerType } from '../types';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpTestResult {
  success: boolean;
  serverName?: string;
  serverVersion?: string;
  tools: McpTool[];
  error?: string;
}

interface UrlServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export async function testMcpServer(server: ClaudianMcpServer): Promise<McpTestResult> {
  const type = getMcpServerType(server.config);

  if (type === 'stdio') {
    let transport;
    try {
      const config = server.config as { command: string; args?: string[]; env?: Record<string, string> };
      const { cmd, args } = parseCommand(config.command, config.args);
      if (!cmd) {
        return { success: false, tools: [], error: 'Missing command' };
      }
      transport = new StdioClientTransport({
        command: cmd,
        args,
        env: { ...process.env, ...config.env, PATH: getEnhancedPath(config.env?.PATH) } as Record<string, string>,
        stderr: 'ignore',
      });
    } catch (error) {
      return {
        success: false,
        tools: [],
        error: error instanceof Error ? error.message : 'Invalid server configuration',
      };
    }

    const client = new Client({ name: 'claudian-tester', version: '1.0.0' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      await client.connect(transport, { signal: controller.signal });

      const serverVersion = client.getServerVersion();
      let tools: McpTool[] = [];
      try {
        const result = await client.listTools(undefined, { signal: controller.signal });
        tools = result.tools.map((t: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        }));
      } catch {
        // listTools failure after successful connect = partial success
      }

      return {
        success: true,
        serverName: serverVersion?.name,
        serverVersion: serverVersion?.version,
        tools,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return { success: false, tools: [], error: 'Connection timeout (10s)' };
      }
      return {
        success: false,
        tools: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      clearTimeout(timeout);
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  // HTTP / SSE implementation (bypassing browser CORS using Node native http/https)
  return new Promise((resolve) => {
    const config = server.config as UrlServerConfig;
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      return resolve({ success: false, tools: [], error: 'Invalid URL' });
    }

    const isHttps = url.protocol === 'https:';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const httpClient: any = isHttps ? https : http;
    const headers = { ...config.headers };

    let isDone = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mainReq: any = null;

    const finish = (result: McpTestResult) => {
      if (!isDone) {
        isDone = true;
        resolve(result);
        if (mainReq) {
          try { mainReq.destroy(); } catch { /* ignore */ }
        }
      }
    };

    const timeout = setTimeout(() => {
      finish({ success: false, tools: [], error: 'Connection timeout (10s)' });
    }, 10000);

    if (type === 'http') {
      // StreamableHTTP: just POST directly with JSON-RPC request.
      // The GET stream is optional per spec and not needed for tool verification.
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      mainReq = httpClient.request(url, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': String(typeof Buffer !== 'undefined' ? Buffer.byteLength(body) : body.length),
          'Accept': 'application/json, text/event-stream'
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }, (res: any) => {
        let data = '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res.on('data', (chunk: any) => data += chunk);
        res.on('end', () => {
          clearTimeout(timeout);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              const msg = Array.isArray(parsed) ? parsed[0] : parsed;
              finish({ success: true, tools: msg.result?.tools || [] });
            } catch {
              finish({ success: false, tools: [], error: 'Invalid JSON response from server' });
            }
          } else {
            finish({ success: false, tools: [], error: `Server returned HTTP ${res.statusCode}` });
          }
        });
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mainReq.on('error', (e: any) => {
        clearTimeout(timeout);
        finish({ success: false, tools: [], error: e.message });
      });
      mainReq.write(body);
      mainReq.end();
    } else {
      // SSE: GET to open stream, wait for 'endpoint' event, then POST to that endpoint.
      mainReq = httpClient.request(url, {
        method: 'GET',
        headers: {
          ...headers,
          'Accept': 'text/event-stream'
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }, (res: any) => {
        let buffer = '';
        let currentEvent = 'message';
        let currentData = '';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res.on('data', (chunk: any) => {
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line === '') {
              if (currentEvent === 'endpoint' && currentData) {
                let endpointUrl: URL;
                try {
                  endpointUrl = new URL(currentData, url.href);
                } catch {
                  try {
                    endpointUrl = new URL(currentData);
                  } catch {
                    finish({ success: false, tools: [], error: 'Invalid endpoint URL format' });
                    continue;
                  }
                }

                const postBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
                const postReq = httpClient.request(endpointUrl, {
                  method: 'POST',
                  headers: {
                    ...headers,
                    'Content-Type': 'application/json',
                    'Content-Length': String(typeof Buffer !== 'undefined' ? Buffer.byteLength(postBody) : postBody.length)
                  }
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                }, (postRes: any) => {
                  postRes.on('data', () => { /* consume stream */ });
                });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                postReq.on('error', (e: any) => finish({ success: false, tools: [], error: `POST error: ${e.message}` }));
                postReq.write(postBody);
                postReq.end();
              } else if (currentEvent === 'message' && currentData) {
                try {
                  const msg = JSON.parse(currentData);
                  if (msg.id === 1 && msg.result) {
                    clearTimeout(timeout);
                    finish({ success: true, tools: msg.result.tools || [] });
                  }
                } catch {
                  // ignore parse errors for other messages
                }
              }
              currentEvent = 'message';
              currentData = '';
            } else if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              currentData += (currentData ? '\n' : '') + line.slice(6);
            } else if (line.startsWith('data:')) {
              currentData += (currentData ? '\n' : '') + line.slice(5);
            }
          }
        });
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mainReq.on('error', (e: any) => {
        clearTimeout(timeout);
        finish({ success: false, tools: [], error: e.message });
      });
      mainReq.end();
    }
  });
}
