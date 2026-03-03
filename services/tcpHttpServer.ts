import TcpSocket from 'react-native-tcp-socket';
import NetInfo from '@react-native-community/netinfo';
import Logger from '@/utils/Logger';

const logger = Logger.withTag('TCPHttpServer');

const PORT = 12346;

interface HttpRequest {
  method: string;
  url: string;
  headers: { [key: string]: string };
  body: string;
}

interface HttpResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

export type RequestHandler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

class TCPHttpServer {
  private server: TcpSocket.Server | null = null;
  private isRunning = false;
  private requestHandler: RequestHandler | null = null;
  private routes: { method: string, path: string, handler: RequestHandler }[] = [];

  constructor() {
    this.server = null;
  }

  // 注册路由 (支持精确匹配和前缀匹配)
  // path 可以是 "/api/v1" 这样的精确路径，也可以是 "/proxy*" 这样的通配符
  public registerRoute(method: string, path: string, handler: RequestHandler) {
    this.routes.push({ method: method.toUpperCase(), path, handler });
  }

  private parseHttpRequest(data: string): HttpRequest | null {
    try {
      const lines = data.split('\r\n');
      const requestLine = lines[0].split(' ');
      
      if (requestLine.length < 3) {
        return null;
      }

      const method = requestLine[0];
      const url = requestLine[1];
      const headers: { [key: string]: string } = {};
      
      let bodyStartIndex = -1;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === '') {
          bodyStartIndex = i + 1;
          break;
        }
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim().toLowerCase();
          const value = line.substring(colonIndex + 1).trim();
          headers[key] = value;
        }
      }

      const body = bodyStartIndex > 0 ? lines.slice(bodyStartIndex).join('\r\n') : '';

      return { method, url, headers, body };
    } catch (error) {
      logger.info('[TCPHttpServer] Error parsing HTTP request:', error);
      return null;
    }
  }

  private formatHttpResponse(response: HttpResponse): string {
    const statusTexts: { [key: number]: string } = {
      200: 'OK',
      400: 'Bad Request',
      404: 'Not Found',
      500: 'Internal Server Error'
    };

    const statusText = statusTexts[response.statusCode] || 'Unknown';
    const headers = {
      'Content-Length': new TextEncoder().encode(response.body).length.toString(),
      'Connection': 'close',
      ...response.headers
    };

    let httpResponse = `HTTP/1.1 ${response.statusCode} ${statusText}\r\n`;
    
    for (const [key, value] of Object.entries(headers)) {
      httpResponse += `${key}: ${value}\r\n`;
    }
    
    httpResponse += '\r\n';
    httpResponse += response.body;

    return httpResponse;
  }

  public setRequestHandler(handler: RequestHandler) {
    this.requestHandler = handler;
  }

  // 内部路由分发逻辑
  private async dispatchRequest(request: HttpRequest): Promise<HttpResponse> {
    // 1. 优先检查已注册的路由
    for (const route of this.routes) {
      if (route.method === request.method || route.method === '*') {
        // 精确匹配
        if (route.path === request.url) {
          return await route.handler(request);
        }
        // 通配符匹配 (简单的 startsWith)
        if (route.path.endsWith('*')) {
          const prefix = route.path.slice(0, -1);
          if (request.url.startsWith(prefix)) {
            return await route.handler(request);
          }
        }
      }
    }

    // 2. 如果没有匹配路由，回退到默认的 requestHandler (保持兼容性)
    if (this.requestHandler) {
      return await this.requestHandler(request);
    }

    // 3. 都没有，返回 404
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Not Found'
    };
  }

  public async start(): Promise<string> {
    const netState = await NetInfo.fetch();
    let ipAddress: string | null = null;
    
    if (netState.type === 'wifi' || netState.type === 'ethernet') {
      ipAddress = (netState.details as any)?.ipAddress ?? null;
    }

    if (!ipAddress) {
      throw new Error('无法获取IP地址，请确认设备已连接到WiFi或以太网。');
    }

    if (this.isRunning) {
      logger.debug('[TCPHttpServer] Server is already running.');
      return `http://${ipAddress}:${PORT}`;
    }

    return new Promise((resolve, reject) => {
      try {
        this.server = TcpSocket.createServer((socket: TcpSocket.Socket) => {
          logger.debug('[TCPHttpServer] Client connected');
          
          let requestData = '';
          
          socket.on('data', async (data: string | Buffer) => {
            requestData += data.toString();
            
            // Check if we have a complete HTTP request
            if (requestData.includes('\r\n\r\n')) {
              try {
                const request = this.parseHttpRequest(requestData);
                if (request) {
                  // 使用分发逻辑替代直接调用 requestHandler
                  const response = await this.dispatchRequest(request);
                  const httpResponse = this.formatHttpResponse(response);
                  socket.write(httpResponse);
                } else {
                  // Send 400 Bad Request for malformed requests
                  const errorResponse = this.formatHttpResponse({
                    statusCode: 400,
                    headers: { 'Content-Type': 'text/plain' },
                    body: 'Bad Request'
                  });
                  socket.write(errorResponse);
                }
              } catch (error) {
                logger.info('[TCPHttpServer] Error handling request:', error);
                const errorResponse = this.formatHttpResponse({
                  statusCode: 500,
                  headers: { 'Content-Type': 'text/plain' },
                  body: 'Internal Server Error'
                });
                socket.write(errorResponse);
              }
              
              socket.end();
              requestData = '';
            }
          });

          socket.on('error', (error: Error) => {
            logger.info('[TCPHttpServer] Socket error:', error);
          });

          socket.on('close', () => {
            logger.debug('[TCPHttpServer] Client disconnected');
          });
        });

        this.server.listen({ port: PORT, host: '0.0.0.0' }, () => {
          logger.debug(`[TCPHttpServer] Server listening on ${ipAddress}:${PORT}`);
          this.isRunning = true;
          resolve(`http://${ipAddress}:${PORT}`);
        });

        this.server.on('error', (error: Error) => {
          logger.info('[TCPHttpServer] Server error:', error);
          this.isRunning = false;
          reject(error);
        });

      } catch (error) {
        logger.info('[TCPHttpServer] Failed to start server:', error);
        reject(error);
      }
    });
  }

  public stop() {
    if (this.server && this.isRunning) {
      this.server.close();
      this.server = null;
      this.isRunning = false;
      logger.debug('[TCPHttpServer] Server stopped');
    }
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }
}

export default TCPHttpServer;