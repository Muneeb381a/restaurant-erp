import { createServer, type Server, type Socket } from 'node:net';
import { describe as describeEscPos } from '@erp/printing';

/**
 * A fake thermal printer: a real TCP server on port 9100's role. Every connection is one
 * received print job. `unplug()` closes the port (connections are refused, like a printer that
 * is switched off); `plug()` brings it back on the SAME port.
 */
export class SimPrinter {
  /** One entry per received ticket, in arrival order. */
  readonly jobs: Buffer[] = [];
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  port = 0;

  static async start(): Promise<SimPrinter> {
    const p = new SimPrinter();
    await p.listen(0);
    return p;
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        this.sockets.add(socket);
        const chunks: Buffer[] = [];
        socket.on('data', (c) => chunks.push(c));
        socket.on('close', () => {
          this.sockets.delete(socket);
          if (chunks.length) this.jobs.push(Buffer.concat(chunks));
        });
        socket.on('error', () => undefined);
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  async unplug(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async plug(): Promise<void> {
    if (!this.server) await this.listen(this.port);
  }

  /** Received tickets as readable text (control codes shown as tags). */
  tickets(): string[] {
    return this.jobs.map((b) => describeEscPos(new Uint8Array(b)));
  }
}
